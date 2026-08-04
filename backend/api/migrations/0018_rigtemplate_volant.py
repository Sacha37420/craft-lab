"""Gabarit "Volant" (Lot 11) — 3e gabarit, patron : 0016_rigtemplate_bipede.py.

3 slots fixes (corps, aile-g/d), 3 chorégraphies par défaut (idle/move-lateral/attack — pas de
"jump", un volant ne saute pas). "Aile" n'a pas de catégorie CC0 dédiée : asset_slot_hint='arm'
pour les deux slots d'aile, une pièce "arm" positionnée/tournée au niveau de l'épaule fait
l'affaire (même choix que les bras du Bipède). Différence structurelle avec la marche du Bipède :
le battement synchronise les deux ailes (mêmes valeurs à chaque étape) plutôt que de les opposer.
"""
from django.db import migrations

TEMPLATE_NAME = 'Volant'

SLOTS = [
    {'slot_key': 'body', 'label': 'Corps', 'asset_slot_hint': 'body', 'default_x': 0, 'default_y': 0, 'required': True, 'repeatable': False},
    {'slot_key': 'wing-left', 'label': 'Aile gauche', 'asset_slot_hint': 'arm', 'default_x': -35, 'default_y': -6, 'required': True, 'repeatable': False},
    {'slot_key': 'wing-right', 'label': 'Aile droite', 'asset_slot_hint': 'arm', 'default_x': 35, 'default_y': -6, 'required': True, 'repeatable': False},
]

REST = {'dx': 0, 'dy': 0, 'rotationDeg': 0}

DEFAULT_SKILLS = [
    {
        'name': 'Vol stationnaire', 'type': 'idle',
        'steps': [
            {'durationMs': 700, 'poses': {'body': {'dx': 0, 'dy': -3, 'rotationDeg': 0}}},
            {'durationMs': 700, 'poses': {'body': dict(REST)}},
        ],
    },
    {
        'name': 'Battement', 'type': 'move-lateral',
        'steps': [
            {'durationMs': 100, 'poses': {
                'wing-left': {'dx': 0, 'dy': -8, 'rotationDeg': -40},
                'wing-right': {'dx': 0, 'dy': -8, 'rotationDeg': -40},
            }},
            {'durationMs': 100, 'poses': {
                'wing-left': {'dx': 0, 'dy': 6, 'rotationDeg': 40},
                'wing-right': {'dx': 0, 'dy': 6, 'rotationDeg': 40},
            }},
        ],
    },
    {
        'name': 'Piqué', 'type': 'attack',
        'steps': [
            {'durationMs': 90, 'poses': {'body': {'dx': 12, 'dy': -4, 'rotationDeg': 12}}},
            {'durationMs': 90, 'poses': {'body': dict(REST)}},
        ],
    },
]


def load_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.update_or_create(
        name=TEMPLATE_NAME,
        defaults={
            'description': 'Corps ailé — battement synchronisé, pas de saut.',
            'slots': SLOTS,
            'default_skills': DEFAULT_SKILLS,
        },
    )


def unload_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.filter(name=TEMPLATE_NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0017_rigtemplate_ver'),
    ]

    operations = [
        migrations.RunPython(load_data, unload_data),
    ]
