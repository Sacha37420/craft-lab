import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0019_rigtemplate_tourelle'),
    ]

    operations = [
        migrations.AddField(
            model_name='projectile',
            name='speed',
            field=models.FloatField(default=400),
        ),
        migrations.AddField(
            model_name='monster',
            name='projectile',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name='used_by_monsters', to='api.projectile',
            ),
        ),
    ]
