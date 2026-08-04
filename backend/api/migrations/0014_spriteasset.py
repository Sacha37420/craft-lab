from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0013_monster_attack_range_tiles_monster_chase_speed_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='SpriteAsset',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=200)),
                ('category', models.CharField(choices=[
                    ('block', 'Block'),
                    ('character', 'Personnage'),
                    ('monster-creature', 'Monstre (assemblé)'),
                    ('monster-part', 'Pièce de monstre'),
                    ('weapon', 'Arme'),
                    ('tool', 'Outil'),
                    ('effect', 'Effet'),
                    ('other', 'Autre'),
                ], max_length=20)),
                ('slot_hint', models.CharField(blank=True, max_length=50)),
                ('file_path', models.CharField(max_length=1024)),
                ('source', models.CharField(choices=[
                    ('cc0-bundled', 'Pack CC0 embarqué'),
                    ('ai-generated', 'Généré par IA'),
                    ('upload', 'Upload manuel'),
                ], max_length=20)),
                ('tags', models.JSONField(blank=True, default=list)),
                ('created_by_email', models.CharField(blank=True, max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'sprite_assets',
                'ordering': ['category', 'name'],
            },
        ),
    ]
