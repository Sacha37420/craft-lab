from django.db import models

from .fields import EncryptedTextField

PROVIDER_CHOICES = [
    ('claude', 'Claude'),
    ('mistral', 'Mistral'),
    # Fournisseurs image (Lot 3, cf. api/image_client.py) — l'utilisateur
    # choisit celui qu'il configure. Aucun n'est réellement gratuit sans
    # carte au moment du choix (2026-08-02) : Gemini demande un compte de
    # facturation Google lié (reste à 0$ dans le quota, mais carte requise),
    # Mistral facture 0,10$/image, OpenAI n'a pas d'offre gratuite. Même
    # AIProviderConfig que les fournisseurs texte : une clé chiffrée par
    # utilisateur, jamais partagée. `mistral` sert donc double emploi (texte
    # ET image) — cf. image_client.py pour la résolution de modèle par tâche.
    ('gemini', 'Gemini (Google) — images'),
    ('openai', 'OpenAI — images'),
]


class AIProviderConfig(models.Model):
    """
    Clé API d'un fournisseur IA, propre à un utilisateur (Lot 2, cahier des
    charges section 2) — repris tel quel du patron robot-lab.

    Une config par (utilisateur, fournisseur) : chacun garde sa propre clé
    Claude et/ou Mistral, jamais de clé partagée pour tout le lab.
    """

    owner_email = models.EmailField()
    provider = models.CharField(max_length=20, choices=PROVIDER_CHOICES)
    api_key = EncryptedTextField(blank=True)
    model_name = models.CharField(max_length=100, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'ai_provider_configs'
        unique_together = [('owner_email', 'provider')]
        ordering = ['provider']

    def __str__(self) -> str:
        return f'{self.owner_email} — {self.provider}'


class Department(models.Model):
    """Département ou équipe de l'organisation."""

    name = models.CharField(max_length=100, unique=True)
    description = models.TextField(blank=True)

    class Meta:
        db_table = 'departments'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


class UserRecord(models.Model):
    """Enregistrement d'un utilisateur Keycloak, créé automatiquement à la première connexion."""

    email = models.EmailField(primary_key=True, max_length=255)
    display_name = models.CharField(max_length=200, blank=True)
    department = models.ForeignKey(
        Department,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='members',
    )
    registered_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'user_records'
        ordering = ['email']

    def __str__(self) -> str:
        return self.display_name or self.email


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 0 : squelette du catalogue (cahier des charges, section 1)
#
# Catalogue unique partagé par le groupe requis de l'app (Share.required_groups,
# façon carto-lab — cf. CLAUDE.md racine) : pas de cloisonnement individuel ici,
# tout membre du groupe lit/écrit tout le catalogue. Aucune UI d'édition ni
# assistant IA à ce stade (Lots 1-3) — seule la structure des modèles.
# ──────────────────────────────────────────────────────────────────────────────


class CombatStyle(models.TextChoices):
    """
    Triplet/quadruplet réutilisé à plusieurs endroits du catalogue (armes 1.2,
    cible des effets d'artefact 1.4.4/1.4.8, type d'attaque des monstres 1.8) —
    le cahier des charges demande explicitement de ne pas dupliquer cette
    énumération. SUMMON (invocation) ne s'applique qu'aux armes/effets, jamais
    aux monstres (cf. Monster.attack_type, qui exclut cette valeur).
    """

    MELEE = 'melee', 'Corps à corps'
    RANGED = 'ranged', 'À distance'
    MAGIC = 'magic', 'Magique'
    SUMMON = 'summon', "D'invocation"


class StatusEffect(models.Model):
    """
    Effet de statut extensible (poison, feu, gel, chute...) — cf. 1.4.6
    (immunité portée par un artefact) et 1.7 (effet de contact d'un liquide).
    Table de référence plutôt qu'un choix figé : la liste est explicitement
    « extensible » dans le cahier des charges.
    """

    code = models.SlugField(max_length=50, unique=True)
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True)

    class Meta:
        db_table = 'status_effects'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


# ── 1.1 Objets et recettes ──────────────────────────────────────────────────


class Item(models.Model):
    """
    Entité de base du catalogue (1.1) : tout objet — block, arme, projectile,
    artefact, outil — a un nom, une description, une icône/texture et une
    catégorie. Les champs propres à chaque catégorie vivent dans une table
    d'extension 1-1 (Weapon/Projectile/Artifact/Tool/Block ci-dessous),
    choisie par `category` — même patron que l'héritage multi-table Django.
    """

    class Category(models.TextChoices):
        BLOCK = 'block', 'Block'
        WEAPON = 'weapon', 'Arme'
        PROJECTILE = 'projectile', 'Projectile'
        ARTIFACT = 'artifact', 'Artefact'
        TOOL = 'tool', 'Outil'

    name = models.CharField(max_length=200, unique=True)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=10, choices=Category.choices)
    # Chemin relatif dans le partage storage 'craft-lab' (Share.required_groups
    # = groupe requis de l'app, même patron que carto-lab) — vide tant qu'aucune
    # icône n'a été générée/uploadée (Lot 3). Pas de storage_client.py à ce stade.
    icon_path = models.CharField(max_length=1024, blank=True)
    created_by_email = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'items'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


class RecipeIngredient(models.Model):
    """
    Une ligne de recette de craft (1.1) : `item` référence l'objet obtenu par le
    craft, `ingredient` un composant consommé. Un `item` sans `RecipeIngredient`
    n'est pas craftable (obtenu autrement — drop de monstre, drop de bloc...).
    """

    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name='recipe_ingredients')
    ingredient = models.ForeignKey(Item, on_delete=models.PROTECT, related_name='used_in_recipes')
    quantity = models.PositiveIntegerField(default=1)

    class Meta:
        db_table = 'recipe_ingredients'
        constraints = [
            models.UniqueConstraint(fields=['item', 'ingredient'], name='uniq_ingredient_per_item'),
        ]

    def __str__(self) -> str:
        return f'{self.quantity}x {self.ingredient} → {self.item}'


# ── 1.2 Armes / 1.3 Projectiles ─────────────────────────────────────────────


class Weapon(models.Model):
    """Extension d'un Item de catégorie WEAPON (1.2)."""

    item = models.OneToOneField(Item, on_delete=models.CASCADE, related_name='weapon', primary_key=True)
    style = models.CharField(max_length=10, choices=CombatStyle.choices)
    damage = models.FloatField(default=0)
    # Portée (armes à distance/magiques) et/ou cadence — selon le type, cf.
    # cahier des charges 1.2 ; les deux restent nuls pour une arme de corps à
    # corps pure.
    attack_range = models.FloatField(null=True, blank=True)
    attack_rate = models.FloatField(null=True, blank=True)

    class Meta:
        db_table = 'weapons'

    def __str__(self) -> str:
        return self.item.name


class Projectile(models.Model):
    """Extension d'un Item de catégorie PROJECTILE (1.3)."""

    item = models.OneToOneField(Item, on_delete=models.CASCADE, related_name='projectile', primary_key=True)
    damage = models.FloatField(default=0)
    # Effets complémentaires (statut, zone...) — liste de
    # {"status_effect": <code>, ...} ; structure fine à trancher à l'usage,
    # cf. ArtifactEffect.parameters pour le même choix de modélisation.
    effects = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = 'projectiles'

    def __str__(self) -> str:
        return self.item.name


class WeaponProjectile(models.Model):
    """
    Quel(s) projectile(s) une arme à distance peut tirer, et sa consommation
    par tir (1.3) — modifiable en jeu par un effet d'artefact 1.4.5, jamais
    directement ici (cette valeur est la consommation de BASE).
    """

    weapon = models.ForeignKey(Weapon, on_delete=models.CASCADE, related_name='projectiles')
    projectile = models.ForeignKey(Projectile, on_delete=models.PROTECT, related_name='used_by_weapons')
    consumption_per_shot = models.PositiveIntegerField(default=1)

    class Meta:
        db_table = 'weapon_projectiles'
        constraints = [
            models.UniqueConstraint(fields=['weapon', 'projectile'], name='uniq_projectile_per_weapon'),
        ]

    def __str__(self) -> str:
        return f'{self.weapon} → {self.projectile}'


# ── 1.4 Artefacts ────────────────────────────────────────────────────────────


class Artifact(models.Model):
    """
    Extension d'un Item de catégorie ARTIFACT (1.4) — n'a pas d'effet en soi
    dans le monde (pas posable). Les effets vivent dans ArtifactEffect
    ci-dessous : un artefact = une LISTE de (type_effet, paramètres), jamais un
    effet unique, pour permettre le cumul (cf. cahier des charges 1.4).
    """

    item = models.OneToOneField(Item, on_delete=models.CASCADE, related_name='artifact', primary_key=True)

    class Meta:
        db_table = 'artifacts'

    def __str__(self) -> str:
        return self.item.name


class ArtifactEffect(models.Model):
    """
    Un effet parmi 1.4.1-1.4.8 porté par un artefact. `parameters` est
    volontairement libre (JSON) plutôt qu'une colonne par type d'effet : les
    paramètres pertinents diffèrent totalement d'un type à l'autre (montant de
    PV vs style d'arme ciblé vs liste de StatusEffect...). Exemples indicatifs :
      - HP_BOOST/MP_BOOST/ARMOR_BOOST : {"amount": <float>}
      - DAMAGE_BOOST : {"style": <CombatStyle>, "amount": <float>}
      - PROJECTILE_ECONOMY : {"reduction": <float>}  (0-1)
      - IMMUNITY : {"status_effects": [<StatusEffect.code>, ...]}
      - DOUBLE_JUMP_FLIGHT : {"mode": "double_jump" | "flight"}
      - WEAPON_EFFECT : {"style": <CombatStyle>, "status_effect": <code>, ...}
    """

    class EffectType(models.TextChoices):
        HP_BOOST = 'hp_boost', 'PV'
        MP_BOOST = 'mp_boost', 'PM'
        ARMOR_BOOST = 'armor_boost', 'Armure'
        DAMAGE_BOOST = 'damage_boost', 'Dégâts'
        PROJECTILE_ECONOMY = 'projectile_economy', 'Consommation de projectiles'
        IMMUNITY = 'immunity', 'Immunité'
        DOUBLE_JUMP_FLIGHT = 'double_jump_flight', 'Double saut / vol'
        WEAPON_EFFECT = 'weapon_effect', 'Effet ajouté aux armes'

    artifact = models.ForeignKey(Artifact, on_delete=models.CASCADE, related_name='effects')
    effect_type = models.CharField(max_length=20, choices=EffectType.choices)
    parameters = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = 'artifact_effects'

    def __str__(self) -> str:
        return f'{self.artifact} — {self.get_effect_type_display()}'


# ── 1.5 Outils ────────────────────────────────────────────────────────────────


class Tool(models.Model):
    """Extension d'un Item de catégorie TOOL (1.5) : hache et pioche."""

    class ToolType(models.TextChoices):
        PICKAXE = 'pickaxe', 'Pioche'
        AXE = 'axe', 'Hache'

    item = models.OneToOneField(Item, on_delete=models.CASCADE, related_name='tool', primary_key=True)
    tool_type = models.CharField(max_length=10, choices=ToolType.choices)
    # Comparée à Block.hardness pour savoir si l'outil peut casser le bloc.
    power = models.FloatField(default=0)
    # Vitesse de cassage (temps pour casser un bloc dont la dureté est
    # cassable par cet outil).
    speed = models.FloatField(default=1)

    class Meta:
        db_table = 'tools'

    def __str__(self) -> str:
        return self.item.name


# ── 1.6 Blocks de base / 1.7 Blocks liquides ────────────────────────────────


class Block(models.Model):
    """
    Extension d'un Item de catégorie BLOCK (1.1). Un seul modèle pour tous les
    blocks — « bloc de base » (1.6) n'est pas une table séparée mais un flag
    `is_generated` (apparaît dans la génération de terrain), exactement comme
    demandé par le cahier des charges : un même bloc peut être obtenu par
    craft ET apparaître naturellement, ou l'un des deux seulement.

    `hardness`/`drops` s'appliquent à tout block (posable/cassable dans le
    monde par définition de la catégorie 1.1, généré ou non), pas seulement
    aux blocks de base.
    """

    item = models.OneToOneField(Item, on_delete=models.CASCADE, related_name='block', primary_key=True)
    is_generated = models.BooleanField(default=False)
    is_liquid = models.BooleanField(default=False)
    hardness = models.FloatField(default=0)
    # Comportement d'écoulement (1.7) — propagation vers les cases vides
    # adjacentes ; structure exacte (vitesse, distance max...) laissée ouverte
    # au lot moteur de jeu (Lot 6), pertinent seulement si is_liquid=True.
    flow_behavior = models.JSONField(default=dict, blank=True)
    # Effet de contact sur le personnage (dégâts, ralentissement...), pertinent
    # seulement si is_liquid=True — réutilise StatusEffect pour l'immunité
    # correspondante côté ArtifactEffect.IMMUNITY.
    contact_status_effect = models.ForeignKey(
        StatusEffect, on_delete=models.SET_NULL, null=True, blank=True, related_name='+',
    )

    class Meta:
        db_table = 'blocks'

    def __str__(self) -> str:
        return self.item.name


class BlockDrop(models.Model):
    """
    Table de drop d'un block (1.6) : quel(s) objet(s) et quantité il donne
    quand cassé. Le drop peut être le bloc lui-même (cas le plus courant) ou un
    objet différent (ex: un minerai qui drop un lingot) — `dropped_item` référence
    n'importe quel Item, sans restriction de catégorie.
    """

    block = models.ForeignKey(Block, on_delete=models.CASCADE, related_name='drops')
    dropped_item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name='dropped_by_blocks')
    quantity = models.PositiveIntegerField(default=1)
    # Probabilité de ce drop (0-1) — une « table » de drop implique
    # généralement plusieurs lignes concurrentes à quantité/chance variables ;
    # 1.0 = toujours dropé (comportement par défaut, cas le plus courant).
    chance = models.FloatField(default=1.0)

    class Meta:
        db_table = 'block_drops'

    def __str__(self) -> str:
        return f'{self.block} → {self.quantity}x {self.dropped_item} ({self.chance:.0%})'


# ── 1.8 Monstres ─────────────────────────────────────────────────────────────


class Monster(models.Model):
    """
    Entité de catalogue à part entière (1.8) — pas un Item : un monstre n'est
    ni posable ni craftable, mais peut tout de même dropper des Items
    (MonsterDrop) et a besoin d'une icône/texture (assistant IA, section 2),
    d'où les champs name/description/icon_path dupliqués depuis Item plutôt
    qu'un héritage commun forcé entre deux natures d'entités différentes.
    """

    name = models.CharField(max_length=200, unique=True)
    description = models.TextField(blank=True)
    icon_path = models.CharField(max_length=1024, blank=True)

    level = models.PositiveIntegerField(default=1)

    # Mécanique de détection — portée + condition libre (ligne de vue...),
    # structure fine laissée ouverte au Lot 4.
    detection_range = models.FloatField(default=0)
    detection_condition = models.JSONField(default=dict, blank=True)

    # Mécanique d'attaque — même triplet que les armes (1.2), sans SUMMON
    # (invocation non applicable à un monstre, cf. CombatStyle).
    attack_type = models.CharField(
        max_length=10,
        choices=[c for c in CombatStyle.choices if c[0] != CombatStyle.SUMMON],
    )
    attack_damage = models.FloatField(default=0)
    attack_rate = models.FloatField(default=1)

    # Patterns de déplacement (au sol, vol, saut, poursuite, fuite...) — liste
    # extensible de codes libres (ex: ["ground", "chase"]), pas de table dédiée
    # tant que Lot 4 n'a pas fixé le vocabulaire définitif.
    movement_patterns = models.JSONField(default=list, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'monsters'
        ordering = ['level', 'name']

    def __str__(self) -> str:
        return self.name


class MonsterSkill(models.Model):
    """
    Compétence active/passive d'un monstre (1.8). Cahier des charges : « liste
    extensible, structure à définir en Lot correspondant : probablement un
    système similaire aux effets d'artefact » (1.4) — squelette provisoire
    calqué sur ArtifactEffect (nom + paramètres libres) en attendant que le Lot
    4 confirme s'il s'agit bien du même système ou d'un système distinct.
    """

    monster = models.ForeignKey(Monster, on_delete=models.CASCADE, related_name='skills')
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    parameters = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = 'monster_skills'

    def __str__(self) -> str:
        return f'{self.monster} — {self.name}'


class MonsterDrop(models.Model):
    """Table de drop d'un monstre — même structure que BlockDrop (1.1, 1.6)."""

    monster = models.ForeignKey(Monster, on_delete=models.CASCADE, related_name='drops')
    dropped_item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name='dropped_by_monsters')
    quantity = models.PositiveIntegerField(default=1)
    chance = models.FloatField(default=1.0)

    class Meta:
        db_table = 'monster_drops'

    def __str__(self) -> str:
        return f'{self.monster} → {self.quantity}x {self.dropped_item} ({self.chance:.0%})'


# ── 1.9 Cartes — génération par profondeur ──────────────────────────────────


class GameMap(models.Model):
    """
    Une « carte » du catalogue (1.9) n'est pas un plan de blocks mais un jeu de
    règles paramétré par palier de profondeur (DepthTier ci-dessous). Distincte
    d'un monde persisté (World, hors scope Lot 0 — section 3/Lot 7) : GameMap
    est la RECETTE de génération, un monde est une instance générée à partir
    d'elle (+ seed).
    """

    name = models.CharField(max_length=200, unique=True)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'game_maps'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


class DepthTier(models.Model):
    """
    Un palier de profondeur d'une GameMap (1.9). L'algorithme exact de
    génération (bruit corrélé verticalement pour regrouper les ressources en
    filons cohérents entre paliers adjacents) est un détail d'implémentation
    du Lot 6, pas modélisé ici — seuls les taux cibles par palier le sont
    (BlockRate/MonsterSpawnRate ci-dessous), que cet algorithme devra respecter.
    """

    game_map = models.ForeignKey(GameMap, on_delete=models.CASCADE, related_name='depth_tiers')
    # Index du palier (0 = surface, croissant avec la profondeur).
    depth_index = models.PositiveIntegerField()
    void_rate = models.FloatField(default=0)

    class Meta:
        db_table = 'depth_tiers'
        ordering = ['game_map', 'depth_index']
        constraints = [
            models.UniqueConstraint(fields=['game_map', 'depth_index'], name='uniq_depth_index_per_map'),
        ]

    def __str__(self) -> str:
        return f'{self.game_map} — palier {self.depth_index}'


class DepthTierBlockRate(models.Model):
    """Taux d'un type de block de base à un palier donné (1.9, point 1)."""

    depth_tier = models.ForeignKey(DepthTier, on_delete=models.CASCADE, related_name='block_rates')
    block = models.ForeignKey(Block, on_delete=models.PROTECT, related_name='depth_rates')
    rate = models.FloatField()

    class Meta:
        db_table = 'depth_tier_block_rates'
        constraints = [
            models.UniqueConstraint(fields=['depth_tier', 'block'], name='uniq_block_rate_per_tier'),
        ]

    def __str__(self) -> str:
        return f'{self.depth_tier} — {self.block} : {self.rate:.0%}'


class DepthTierMonsterSpawn(models.Model):
    """
    Chance de spawn d'un monstre à un palier donné (1.9, point 2). La règle
    d'évaluation (toutes les 5s, couronne horizontale 10-10 000 blocs, bande
    verticale ±10 blocs autour de chaque personnage, sur tout bloc du palier
    ayant la hauteur libre nécessaire) est une constante du moteur de jeu
    (Lot 6+), pas une donnée de catalogue — seule la chance par palier l'est.
    """

    depth_tier = models.ForeignKey(DepthTier, on_delete=models.CASCADE, related_name='monster_spawns')
    monster = models.ForeignKey(Monster, on_delete=models.PROTECT, related_name='depth_spawns')
    spawn_chance = models.FloatField()

    class Meta:
        db_table = 'depth_tier_monster_spawns'
        constraints = [
            models.UniqueConstraint(fields=['depth_tier', 'monster'], name='uniq_monster_spawn_per_tier'),
        ]

    def __str__(self) -> str:
        return f'{self.depth_tier} — {self.monster} : {self.spawn_chance:.0%}'


# ── 1.10 Portails ────────────────────────────────────────────────────────────


class Portal(models.Model):
    """
    Un portail (1.10) est défini par une composition de blocks reconnue, qui
    ouvre vers une GameMap de destination. Le lien vers un monde PERSISTÉ
    concret (plutôt que sa simple recette GameMap) dépend du modèle World, hors
    scope Lot 0 (section 3, Lot 7) — laissé ouvert au cahier des charges
    (section 7 : « monde généré à la volée à la première utilisation, à
    trancher au lot correspondant »).
    """

    name = models.CharField(max_length=200, unique=True)
    description = models.TextField(blank=True)
    # Composition reconnue (quels blocks, arrangés comment) — structure exacte
    # du pattern laissée au Lot 5 (Portails) ; JSON libre pour l'instant, ex :
    # {"shape": "frame", "width": 4, "height": 5, "block": <Block.item_id>}.
    frame_pattern = models.JSONField(default=dict, blank=True)
    destination_map = models.ForeignKey(
        GameMap, on_delete=models.SET_NULL, null=True, blank=True, related_name='portals',
    )

    class Meta:
        db_table = 'portals'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name
