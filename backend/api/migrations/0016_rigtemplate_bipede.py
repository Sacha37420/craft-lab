"""Gabarit "Bipède" (Lot 11) — sert de patron pour les 3 suivants (Ver/Volant/Tourelle).

5 slots fixes (tête+torse, bras-g/d, jambe-g/d), 4 chorégraphies par défaut (idle/move-lateral/
jump/attack) — marche = jambes+bras en alternance simple hand-codée (pas de mécanisme "mirror"
générique : le moteur de rig actuel n'a aucune notion de phase/miroir, cf. mémoire — chaque pose
gauche/droite est donc écrite explicitement, deux fois, plutôt que dérivée d'une seule).
"""
from django.db import migrations

TEMPLATE_NAME = 'Bipède'

SLOTS = [
    {'slot_key': 'body', 'label': 'Tête + torse', 'asset_slot_hint': 'body', 'default_x': 0, 'default_y': 0, 'required': True, 'repeatable': False},
    {'slot_key': 'arm-left', 'label': 'Bras gauche', 'asset_slot_hint': 'arm', 'default_x': -35, 'default_y': -4, 'required': True, 'repeatable': False},
    {'slot_key': 'arm-right', 'label': 'Bras droit', 'asset_slot_hint': 'arm', 'default_x': 35, 'default_y': -4, 'required': True, 'repeatable': False},
    {'slot_key': 'leg-left', 'label': 'Jambe gauche', 'asset_slot_hint': 'leg', 'default_x': -14, 'default_y': 60, 'required': True, 'repeatable': False},
    {'slot_key': 'leg-right', 'label': 'Jambe droite', 'asset_slot_hint': 'leg', 'default_x': 14, 'default_y': 60, 'required': True, 'repeatable': False},
]

REST = {'dx': 0, 'dy': 0, 'rotationDeg': 0}

DEFAULT_SKILLS = [
    {
        'name': 'Immobile', 'type': 'idle',
        'steps': [
            {'durationMs': 700, 'poses': {'body': {'dx': 0, 'dy': -2, 'rotationDeg': 0}}},
            {'durationMs': 700, 'poses': {'body': dict(REST)}},
        ],
    },
    {
        'name': 'Marche', 'type': 'move-lateral',
        'steps': [
            {'durationMs': 220, 'poses': {
                'leg-left': {'dx': 0, 'dy': -4, 'rotationDeg': -18},
                'leg-right': {'dx': 0, 'dy': 2, 'rotationDeg': 18},
                'arm-left': {'dx': 0, 'dy': 0, 'rotationDeg': 14},
                'arm-right': {'dx': 0, 'dy': 0, 'rotationDeg': -14},
            }},
            {'durationMs': 220, 'poses': {
                'leg-left': {'dx': 0, 'dy': 2, 'rotationDeg': 18},
                'leg-right': {'dx': 0, 'dy': -4, 'rotationDeg': -18},
                'arm-left': {'dx': 0, 'dy': 0, 'rotationDeg': -14},
                'arm-right': {'dx': 0, 'dy': 0, 'rotationDeg': 14},
            }},
        ],
    },
    {
        'name': 'Saut', 'type': 'jump',
        'steps': [
            {'durationMs': 180, 'poses': {
                'leg-left': {'dx': 0, 'dy': -6, 'rotationDeg': 0},
                'leg-right': {'dx': 0, 'dy': -6, 'rotationDeg': 0},
                'arm-left': {'dx': -2, 'dy': -4, 'rotationDeg': -30},
                'arm-right': {'dx': 2, 'dy': -4, 'rotationDeg': 30},
            }},
        ],
    },
    {
        'name': 'Attaque', 'type': 'attack',
        'steps': [
            {'durationMs': 90, 'poses': {'arm-right': {'dx': 8, 'dy': -4, 'rotationDeg': -50}}},
            {'durationMs': 90, 'poses': {'arm-right': dict(REST)}},
        ],
    },
]


def load_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.update_or_create(
        name=TEMPLATE_NAME,
        defaults={
            'description': 'Silhouette à deux jambes/deux bras — le gabarit le plus courant.',
            'slots': SLOTS,
            'default_skills': DEFAULT_SKILLS,
        },
    )


def unload_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.filter(name=TEMPLATE_NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0015_rigtemplate'),
    ]

    operations = [
        migrations.RunPython(load_data, unload_data),
    ]
