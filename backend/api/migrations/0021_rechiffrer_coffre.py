"""Réécrit chaque valeur chiffrée sous la clé du coffre (`VAULT_ENCRYPTION_KEY`).

Avant : Fernet dérivé de SECRET_KEY (cf. api/fields.py). Les valeurs lisibles
sous l'ancienne clé, ou historiques en clair, sont rechiffrées ; une valeur
indéchiffrable est laissée intacte (comptée et journalisée, sans sa valeur).
Retour arrière : rien (les valeurs restent sous la nouvelle clé, que le code
d'avant ne lit pas — ne revenir en arrière qu'avec une sauvegarde de la base).
"""
from django.db import migrations

from api.fields import rewrite_encrypted_columns

# Toutes les colonnes `EncryptedTextField` de l'app.
ENCRYPTED = [('AIProviderConfig', ['api_key'])]


def rechiffrer(apps, schema_editor):
    return rewrite_encrypted_columns(
        schema_editor, [(apps.get_model('api', name), fields) for name, fields in ENCRYPTED],
    )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0020_projectile_speed_monster_projectile'),
    ]

    operations = [
        migrations.RunPython(rechiffrer, migrations.RunPython.noop),
    ]
