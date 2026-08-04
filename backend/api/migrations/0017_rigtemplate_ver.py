"""Gabarit "Ver / serpent" (Lot 11) — seul gabarit à slot repeatable.

Généralise le besoin de "déphasage continu par index de segment" (cf. to_do_craft_lab.md) SANS
introduire de concept de phase côté moteur de jeu (qui n'en a aucun, cf. mémoire) : chaque étape de
la compétence "Ondulation" porte une PHOTO complète de la vague (une pose par position relative
dans le motif, cf. RigTemplate.default_skills côté models.py) — le segment i lit toujours l'entrée
i % wavelength, et comme cette photo change de forme d'une étape à l'autre, chaque segment rejoue
la même onde avec un déphasage égal à sa position dans la chaîne. Généré par calcul (sinus) plutôt
qu'à la main : bien plus fiable pour obtenir une ondulation visuellement correcte.
"""
import math

from django.db import migrations

TEMPLATE_NAME = 'Ver / serpent'

WAVELENGTH = 6
AMPLITUDE_DY = 7
AMPLITUDE_ROT = 14
STEP_MS = 150

SLOTS = [
    {
        'slot_key': 'segment', 'label': 'Segment', 'asset_slot_hint': 'body',
        'default_x': -30, 'default_y': 0, 'required': True, 'repeatable': True, 'default_count': 6,
    },
]


def _wave_steps():
    steps = []
    for s in range(WAVELENGTH):
        poses_list = []
        for j in range(WAVELENGTH):
            phase = 2 * math.pi * ((j - s) / WAVELENGTH)
            poses_list.append({
                'dx': 0,
                'dy': round(AMPLITUDE_DY * math.sin(phase), 1),
                'rotationDeg': round(AMPLITUDE_ROT * math.sin(phase), 1),
            })
        steps.append({'durationMs': STEP_MS, 'poses': {'segment': poses_list}})
    return steps


def _default_skills():
    return [
        {'name': 'Ondulation', 'type': 'move-lateral', 'steps': _wave_steps()},
        {
            # Liste à 1 entrée = même pose diffusée à TOUS les segments (i % 1 == 0 toujours) — un
            # lunge d'ensemble plutôt qu'une vague, cf. models.py pour la sémantique de la liste.
            'name': 'Attaque', 'type': 'attack',
            'steps': [
                {'durationMs': 90, 'poses': {'segment': [{'dx': 12, 'dy': 0, 'rotationDeg': 0}]}},
                {'durationMs': 110, 'poses': {'segment': [{'dx': 0, 'dy': 0, 'rotationDeg': 0}]}},
            ],
        },
    ]


def load_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.update_or_create(
        name=TEMPLATE_NAME,
        defaults={
            'description': 'N segments empilés, ondulation en vague — pas de bras/jambes.',
            'slots': SLOTS,
            'default_skills': _default_skills(),
        },
    )


def unload_data(apps, schema_editor):
    RigTemplate = apps.get_model('api', 'RigTemplate')
    RigTemplate.objects.filter(name=TEMPLATE_NAME).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0016_rigtemplate_bipede'),
    ]

    operations = [
        migrations.RunPython(load_data, unload_data),
    ]
