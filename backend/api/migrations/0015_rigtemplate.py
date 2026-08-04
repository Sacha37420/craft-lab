from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0014_spriteasset'),
    ]

    operations = [
        migrations.CreateModel(
            name='RigTemplate',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=200, unique=True)),
                ('description', models.TextField(blank=True)),
                ('slots', models.JSONField(default=list)),
                ('default_skills', models.JSONField(default=list)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'rig_templates',
                'ordering': ['name'],
            },
        ),
    ]
