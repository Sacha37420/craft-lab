"""Gabarit "Tourelle" (Lot 11) — corps fixe + point d'émission, aucune compétence de déplacement.

2 slots (corps + point d'émission), 2 chorégraphies par défaut (idle/attack) — pas de move-lateral
ni de jump : c'est une tourelle immobile par définition. `attack` fait pulser l'émetteur (recul puis
retour) faute d'un vrai système de projectile (Lot futur) ; dégrade en attaque de contact classique
en l'état, cf. docstring RigTemplate.
"""
from django.db import migrations

TEMPLATE_NAME = 'Tourelle'

SLOTS = [
    {'slot_key': 'body', 'label': 'Corps', 'asset_slot_hint': 'body', 'default_x': 0, 'default_y': 0, 'required': True, 'repeatable': False},
    {'slot_key': 'emitter', 'label': "Point d'émission", 'asset_slot_hint': 'detail', 'default_x': 18, 'default_y': -20, 'required': True, 'repeatable': False},
]

REST = {'dx': 0, 'dy': 0, 'rotationDeg': 0}

DEFAULT_SKILLS = [
    {
        'name': 'Immobile', 'type': 'idle',
        'steps': [
            {'durationMs': 700, 'poses': {'body': {'dx': 0, 'dy': -1, 'rotationDeg': 0}}},
            {'durationMs': 700, 'poses': {'body': dict(REST)}},
        ],
    },
    {
        'name': 'Tir', 'type': 'attack',
        'steps': [
            {'durationMs': 100, 'poses': {
                'emitter': {'dx': 6, 'dy': -4, 'rotationDeg': 12},
                'body': {'dx': -2, 'dy': 0, 'rotationDeg': 0},
            }},
            {'durationMs': 100, 'poses': {'emitter': dict(REST), 'body': dict(REST)}},
        ],
    },
]


def load_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.update_or_create(
        name=TEMPLATE_NAME,
        defaults={
            'description': "Corps fixe et point d'émission — aucun déplacement, attaque à distance (dégrade en contact sans le Lot 12).",
            'slots': SLOTS,
            'default_skills': DEFAULT_SKILLS,
        },
    )


def unload_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.filter(name=TEMPLATE_NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0018_rigtemplate_volant'),
    ]

    operations = [
        migrations.RunPython(load_data, unload_data),
    ]
