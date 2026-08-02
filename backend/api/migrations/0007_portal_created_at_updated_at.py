import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Ajoute created_at/updated_at à Portal, par cohérence avec le reste du
    catalogue (Lot 0 avait omis ces deux champs sur ce seul modèle — cf.
    Lot 5). Écrite à la main plutôt que via `makemigrations` : la table
    'portals' est vide à ce stade (aucun portail créé), donc le default
    ci-dessous ne backfillera jamais aucune ligne réelle — il ne sert qu'à
    satisfaire la contrainte NOT NULL exigée par l'ALTER TABLE lui-même.
    `makemigrations` ne peut pas s'exécuter en mode non interactif pour ce
    cas précis (`docker compose run`, cf. session du 2026-08-02) : ceci est
    la valeur que son prompt interactif (« Provide a one-off default ») aurait
    produite en choisissant `timezone.now`.
    """

    dependencies = [
        ('api', '0006_alter_aiproviderconfig_provider'),
    ]

    operations = [
        migrations.AddField(
            model_name='portal',
            name='created_at',
            field=models.DateTimeField(auto_now_add=True, default=django.utils.timezone.now),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='portal',
            name='updated_at',
            field=models.DateTimeField(auto_now=True, default=django.utils.timezone.now),
            preserve_default=False,
        ),
    ]
