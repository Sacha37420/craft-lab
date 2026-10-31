"""Champ de modèle chiffré au repos — coffre de l'app (`VAULT_ENCRYPTION_KEY`).

Clé : `settings.VAULT_ENCRYPTION_KEY`, clé Fernet propre au coffre, sans lien
avec `SECRET_KEY`. Avant le 2026-10-31, la clé était dérivée de `SECRET_KEY` :
faire tourner `SECRET_KEY` (`rotate-app-secret.sh`) détruisait en silence les
clés d'API enregistrées, et une fuite de `SECRET_KEY` les livrait. L'ancienne
clé n'est plus que LUE (`MultiFernet`), le temps que la migration de données
`0021_rechiffrer_coffre` ait tout réécrit sous la nouvelle.

Une valeur qui ne se déchiffre sous aucune des deux clés n'est plus rendue
telle quelle (c'était le texte chiffré, présenté comme une clé valide) : elle
est traitée comme absente (`''`) et journalisée sans sa valeur. Seule
exception : une valeur qui n'a pas la forme d'un jeton Fernet (`gAAAAA…`) est
une valeur historique en clair (antérieure au chiffrement) — rendue telle
quelle, et rechiffrée par la migration.

Chantier « failles », interface I3.
"""
import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.db import models

logger = logging.getLogger(__name__)

# Tout jeton Fernet commence par l'octet de version 0x80 suivi de l'horodatage :
# en base64 urlsafe, « gAAAAA ».
FERNET_PREFIX = 'gAAAAA'

_UNREADABLE = (InvalidToken, ValueError, TypeError)


def legacy_fernet() -> Fernet:
    """Ancienne clé, dérivée de SECRET_KEY — lecture seule."""
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest())
    return Fernet(key)


def vault_fernet() -> Fernet:
    """Clé du coffre (`VAULT_ENCRYPTION_KEY`). Lève si elle est absente ou mal formée."""
    key = getattr(settings, 'VAULT_ENCRYPTION_KEY', '') or ''
    if not key:
        raise RuntimeError('VAULT_ENCRYPTION_KEY absente : le coffre ne peut ni chiffrer ni déchiffrer.')
    return Fernet(key.encode() if isinstance(key, str) else key)


def _reader() -> MultiFernet:
    """Chiffre sous la clé du coffre ; déchiffre sous la clé du coffre, puis l'ancienne."""
    return MultiFernet([vault_fernet(), legacy_fernet()])


def encrypt(plaintext: str) -> str:
    return vault_fernet().encrypt(plaintext.encode()).decode()


def is_fernet_token(value) -> bool:
    return isinstance(value, str) and value.startswith(FERNET_PREFIX)


def decrypt_stored(value, where: str = '?'):
    """Valeur en base → valeur en clair, ou `''` si indéchiffrable.

    `where` ne sert qu'au journal (`Modèle.champ`) ; la valeur n'y figure jamais.
    """
    if value in (None, ''):
        return value
    try:
        return _reader().decrypt(value.encode()).decode()
    except _UNREADABLE:
        if not is_fernet_token(value):
            return value  # valeur historique en clair
        logger.warning('Coffre : valeur indéchiffrable dans %s, traitée comme absente.', where)
        return ''


class EncryptedTextField(models.TextField):
    """Chiffre la valeur avant écriture en base et la déchiffre à la lecture."""

    def _where(self) -> str:
        model = getattr(self, 'model', None)
        return f"{getattr(model, '__name__', '?')}.{self.name}"

    def get_prep_value(self, value):
        value = super().get_prep_value(value)
        if value in (None, ''):
            return value
        return encrypt(value)

    def from_db_value(self, value, expression, connection):
        return decrypt_stored(value, self._where())


# ── Migration de données (0021_rechiffrer_coffre) ────────────────────────────

REWRITTEN, ALREADY_NEW, UNREADABLE = 'rewritten', 'already_new', 'unreadable'


def reencrypt_raw(raw):
    """Valeur brute en base → `(état, nouvelle valeur brute ou None)`.

    - déjà sous la clé du coffre → `(ALREADY_NEW, None)` : rien à écrire ;
    - lisible sous l'ancienne clé, ou en clair historique → `(REWRITTEN, jeton)` ;
    - jeton Fernet indéchiffrable → `(UNREADABLE, None)` : laissé en base tel
      quel (il se lit comme absent ; une clé retrouvée plus tard pourrait encore
      le lire), JAMAIS écrasé par `''`.
    """
    try:
        vault_fernet().decrypt(raw.encode())
        return ALREADY_NEW, None
    except _UNREADABLE:
        pass
    try:
        plaintext = legacy_fernet().decrypt(raw.encode()).decode()
    except _UNREADABLE:
        if is_fernet_token(raw):
            return UNREADABLE, None
        plaintext = raw  # historique en clair
    return REWRITTEN, encrypt(plaintext)


def rewrite_encrypted_columns(schema_editor, models_fields):
    """Réécrit sous la clé du coffre, en SQL brut, les colonnes chiffrées.

    `models_fields` : `[(modèle historique, ['champ', …]), …]`. Le SQL brut évite
    que `from_db_value`/`get_prep_value` ne s'interposent. Rend les compteurs ;
    journalise seulement table, colonne et clé primaire — jamais une valeur.
    """
    conn = schema_editor.connection
    qn = conn.ops.quote_name
    counts = {REWRITTEN: 0, ALREADY_NEW: 0, UNREADABLE: 0}
    for model, field_names in models_fields:
        table = model._meta.db_table
        pk = model._meta.pk.column
        for name in field_names:
            col = model._meta.get_field(name).column
            with conn.cursor() as cur:
                cur.execute(
                    f'SELECT {qn(pk)}, {qn(col)} FROM {qn(table)} WHERE {qn(col)} IS NOT NULL AND {qn(col)} <> %s',
                    [''],
                )
                rows = cur.fetchall()
            for row_pk, raw in rows:
                state, new = reencrypt_raw(raw)
                counts[state] += 1
                if state == UNREADABLE:
                    logger.warning('Coffre : %s.%s (pk=%s) indéchiffrable, laissé tel quel.', table, col, row_pk)
                if new is None:
                    continue
                with conn.cursor() as cur:
                    cur.execute(f'UPDATE {qn(table)} SET {qn(col)} = %s WHERE {qn(pk)} = %s', [new, row_pk])
    logger.info('Coffre : rechiffrement — %s', counts)
    return counts
