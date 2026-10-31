"""Retire les comptes d'exemple semés par 0002_example_data (FEUILLE lot 2).

0002 a créé trois `UserRecord` (alice@, bob@, charlie@example.com) et trois
`Department` (Développement, Infrastructure, Qualité). On ne les supprime que
si aucun de ces trois comptes n'apparaît ailleurs dans l'app : toute colonne
`…email` d'un modèle de l'app (clés IA, objets et sprites créés, parties,
personnages, billets du relais…) est examinée, pour qu'un champ ajouté plus tard
soit couvert sans retoucher cette migration. Si l'un d'eux a laissé une trace,
la migration ne fait RIEN (et le journalise). Un département semé n'est retiré
que s'il n'a plus aucun membre et que sa description est celle de 0002.
Retour arrière : rien (ce sont des données d'exemple).
"""
import logging

from django.db import migrations

logger = logging.getLogger(__name__)

EXAMPLE_EMAILS = ['alice@example.com', 'bob@example.com', 'charlie@example.com']
EXAMPLE_DEPARTMENTS = {
    'Développement': 'Conception et développement des applications',
    'Infrastructure': 'Gestion des serveurs, réseaux et déploiements',
    'Qualité': 'Tests, recette et assurance qualité',
}


def other_traces(apps):
    """`{'Modèle.champ': nombre}` des lignes, hors UserRecord, qui citent un compte d'exemple."""
    traces = {}
    for model in apps.get_app_config('api').get_models():
        if model.__name__ == 'UserRecord':
            continue
        for field in model._meta.concrete_fields:
            if field.is_relation or not field.name.endswith('email'):
                continue
            n = model.objects.filter(**{f'{field.name}__in': EXAMPLE_EMAILS}).count()
            if n:
                traces[f'{model.__name__}.{field.name}'] = n
    return traces


def retirer(apps, schema_editor):
    UserRecord = apps.get_model('api', 'UserRecord')
    Department = apps.get_model('api', 'Department')

    traces = other_traces(apps)
    if traces:
        logger.warning("Comptes d'exemple conservés : ils ont des données hors de 0002 (%s).", traces)
        return {'deleted_users': 0, 'deleted_departments': 0, 'traces': traces}

    deleted_users, _ = UserRecord.objects.filter(email__in=EXAMPLE_EMAILS).delete()
    deleted_departments = 0
    for name, description in EXAMPLE_DEPARTMENTS.items():
        dept = Department.objects.filter(name=name, description=description).first()
        if dept is None:
            continue
        if UserRecord.objects.filter(department=dept).exists():
            logger.info("Département d'exemple %r conservé : il a des membres.", name)
            continue
        dept.delete()
        deleted_departments += 1
    logger.info("Comptes d'exemple retirés : %s comptes, %s départements.", deleted_users, deleted_departments)
    return {'deleted_users': deleted_users, 'deleted_departments': deleted_departments, 'traces': {}}


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0021_rechiffrer_coffre'),
    ]

    operations = [
        migrations.RunPython(retirer, migrations.RunPython.noop),
    ]
