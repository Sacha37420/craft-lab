"""Envoi d'une icône ou d'un sprite : taille bornée, image réellement décodée.

Décisions du chantier « failles » (contrat v1, § 7) :

* **Taille** : 10 Mo par fichier (``settings.IMAGE_MAX_BYTES`` = 10 485 760
  octets). Deux étages, tous deux **avant tout appel à storage** :
    1. ``check_request_body`` — avant toute lecture du corps, d'après l'en-tête
       ``Content-Length`` : un corps plus gros que le plus gros envoi légitime
       (``body_max_bytes``) est refusé en 413 sans être lu ni écrit sur le disque ;
    2. ``check_image_size`` — sur la taille exacte du fichier (taille de la
       partie multipart, taille décodée du base64 calculée avant de décoder).
  Limite connue : une requête sans ``Content-Length`` (envoi « chunked ») n'est
  bornée que par l'étage 2, après réception de la partie fichier.

* **Contenu** : l'image est décodée par Pillow (``verify()`` puis réouverture et
  ``load()``), images tronquées refusées, bombe de décompression refusée (le
  plafond ``Image.MAX_IMAGE_PIXELS`` de Pillow est gardé, et son avertissement
  traité comme une erreur). Formats acceptés : PNG, JPEG, GIF, WebP — pas de
  SVG (document qui peut porter du script, et que Pillow ne décode pas). Le
  type transmis à storage est celui que Pillow reconnaît, jamais celui annoncé
  par le client ni l'extension.
"""
from __future__ import annotations

import base64
import binascii
import io
import warnings

from django.conf import settings
from PIL import Image, ImageFile
from rest_framework.exceptions import APIException, ValidationError

# Une image tronquée est une image invalide (c'est déjà le défaut de Pillow ;
# posé explicitement pour qu'aucun autre module ne puisse l'avoir changé).
ImageFile.LOAD_TRUNCATED_IMAGES = False

# Marge pour ce qui accompagne le fichier dans le corps : délimiteurs et
# en-têtes multipart, autres champs (nom, catégorie, étiquettes, mime_type),
# syntaxe JSON. Les champs texte de ces routes font quelques centaines
# d'octets : 1 Mo est très large.
BODY_OVERHEAD_BYTES = 1024 * 1024

# Format Pillow → type MIME transmis à storage, et extension du fichier.
IMAGE_FORMATS = {
    'PNG': ('image/png', '.png'),
    'JPEG': ('image/jpeg', '.jpg'),
    'GIF': ('image/gif', '.gif'),
    'WEBP': ('image/webp', '.webp'),
}
IMAGE_EXTENSIONS = {mime: ext for mime, ext in IMAGE_FORMATS.values()}

_INVALID = {'image': "Le fichier n'est pas une image PNG, JPEG, GIF ou WebP lisible."}


class ImageTooLarge(APIException):
    status_code = 413
    default_code = 'image_too_large'

    def __init__(self):
        max_bytes = image_max_bytes()
        super().__init__({
            'detail': f'Image trop volumineuse : {max_bytes} octets au plus.',
            'max_bytes': max_bytes,
        })


def image_max_bytes() -> int:
    return int(settings.IMAGE_MAX_BYTES)


def base64_length(n: int) -> int:
    """Longueur du base64 (avec remplissage) de ``n`` octets."""
    return -(-n // 3) * 4


def body_max_bytes() -> int:
    """Plus gros corps légitime : la forme base64 d'une image à la limite (la
    plus longue des deux formes d'envoi) plus la marge."""
    return base64_length(image_max_bytes()) + BODY_OVERHEAD_BYTES


def check_request_body(request) -> None:
    """413 d'après ``Content-Length``, avant que le corps soit lu."""
    try:
        length = int(request.META.get('CONTENT_LENGTH') or 0)
    except (TypeError, ValueError):
        length = 0
    if length > body_max_bytes():
        raise ImageTooLarge()


def check_image_size(size: int) -> None:
    if size > image_max_bytes():
        raise ImageTooLarge()


_WHITESPACE = {ord(c): None for c in ' \t\r\n\f\v'}


def decode_base64(raw) -> bytes:
    """Décode ``raw`` après avoir vérifié la taille décodée **sans décoder** :
    elle se déduit de la longueur du texte (4 caractères → 3 octets, moins le
    remplissage). Tout caractère hors alphabet est refusé (400)."""
    if not isinstance(raw, str):
        raise ValidationError({'image_base64': 'Image invalide (base64 non décodable).'})
    compact = raw.translate(_WHITESPACE)
    check_image_size(len(compact) // 4 * 3 - compact[-2:].count('='))
    try:
        return base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError({'image_base64': 'Image invalide (base64 non décodable).'}) from exc


def read_upload(upload) -> bytes:
    """Octets d'une partie fichier multipart, après contrôle de sa taille."""
    check_image_size(upload.size)
    data = upload.read()
    check_image_size(len(data))
    return data


def image_type(data: bytes) -> str:
    """Type MIME d'une image, établi en la DÉCODANT entièrement par Pillow.

    400 si ce n'est pas une image PNG/JPEG/GIF/WebP complète et lisible, ou si
    elle dépasse le plafond de pixels de Pillow (bombe de décompression)."""
    allowed = list(IMAGE_FORMATS)
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(data), formats=allowed) as im:
                fmt = im.format
                im.verify()
            # verify() ne décode pas les pixels et rend l'objet inutilisable :
            # réouverture, puis décodage complet.
            with Image.open(io.BytesIO(data), formats=allowed) as im:
                im.load()
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise ValidationError({'image': "Image refusée : trop de pixels."}) from exc
        except Exception as exc:  # noqa: BLE001 — tout échec de décodage est un refus
            raise ValidationError(_INVALID) from exc
    if fmt not in IMAGE_FORMATS:
        raise ValidationError(_INVALID)
    return IMAGE_FORMATS[fmt][0]


def read_image(request):
    """Image envoyée à une route d'icône ou de sprite : ``(octets, mime, envoyé_en_fichier)``.

    Deux formes, jamais mélangées : ``file`` en multipart, ou ``image_base64``
    en JSON. L'appelant a déjà passé ``check_request_body`` (avant toute lecture
    du corps). Rien n'est envoyé à storage avant le retour de cette fonction."""
    upload = request.FILES.get('file')
    if upload is not None:
        data = read_upload(upload)
    else:
        raw = request.data.get('image_base64')
        if not raw:
            raise ValidationError({'image_base64': 'Requis (ou "file" en multipart).'})
        data = decode_base64(raw)
    return data, image_type(data), upload is not None
