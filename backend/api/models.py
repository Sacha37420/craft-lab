import secrets

from django.db import models
from django.utils import timezone

from .fields import EncryptedTextField

RELAY_TICKET_TTL_SECONDS = 30

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
    # Absent du cahier des charges section 1.8 (seuls détection/attaque y sont listés) mais
    # indispensable dès qu'un combat doit pouvoir se terminer — trou trouvé et corrigé au Lot 6b,
    # même famille que les trous IA carte/portail (Lot 5) et armes/projectiles (Lot 1).
    hp = models.FloatField(default=10)

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
    # Portée de contact (en cases) pour la résolution par distance (GameScene.tickMonsterAI) — sans
    # effet pour un monstre dont au moins une pièce du montage est `isWeapon` (résolution par contact
    # réel à la place, cf. tickRigCollisions). Défaut identique à l'ancienne constante fixe
    # MONSTER_ATTACK_RANGE_TILES, pour qu'un monstre existant sans valeur explicite garde le même
    # comportement qu'avant l'ajout de ce champ.
    attack_range_tiles = models.FloatField(default=1.2)

    # Patterns de déplacement (au sol, vol, saut, poursuite, fuite...) — liste
    # extensible de codes libres (ex: ["ground", "chase"]), pas de table dédiée
    # tant que Lot 4 n'a pas fixé le vocabulaire définitif.
    movement_patterns = models.JSONField(default=list, blank=True)
    # Vitesses de déplacement (px/s) — défauts identiques aux anciennes constantes fixes du moteur
    # (35 en maraude, 70 en poursuite/fuite active), désormais réglables par monstre.
    move_speed = models.FloatField(default=35)
    chase_speed = models.FloatField(default=70)
    # Vitesse verticale d'impulsion de saut (px/s, positif — appliquée en négatif côté moteur) —
    # défaut identique à l'ancienne constante fixe (320), pertinent seulement si movement_patterns
    # contient "jumping".
    jump_strength = models.FloatField(default=320)

    # Montage optionnel à partir de pièces séparées de la bibliothèque d'assets (SpriteAsset, Lot 10
    # — cf. MonsterBuilderComponent côté frontend) — chaque pièce garde son assetId ET sa position
    # (Kenney ne fournit aucun point d'ancrage officiel : réglés à la main par glisser-déposer dans
    # l'éditeur, pas une donnée du pack). Vide pour un monstre utilisant une icône plate classique
    # (IA/upload/pack libre) — le moteur de jeu retombe alors sur `icon_path` comme avant.
    # Structure : {"parts": [{"id", "assetId", "x", "y", "flip", "isWeapon", "collidesTerrain"}, ...],
    # "skills": [{"id", "name", "type", "steps": [{"durationMs", "poses": {partId: {"dx", "dy",
    # "rotationDeg", "tempAssetId"}}}]}]} — cf. api.service.ts (MonsterRig/RigSkill) pour le contrat
    # complet côté frontend, seul endroit qui valide vraiment cette structure (JSONField libre ici).
    rig = models.JSONField(default=dict, blank=True)

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


# ── Lot 10 : bibliothèque d'assets centralisée ──────────────────────────────


class SpriteAsset(models.Model):
    """
    Image 2D réutilisable, indépendante de toute entité du catalogue — unifie deux origines qui ne
    se recoupaient pas jusqu'ici : le pack CC0 embarqué (Kenney/OpenGameArt,
    assets/sprite-library/, importé une fois par la commande `import_sprite_library`) et tout
    contenu produit par un utilisateur (upload direct ou génération IA), stocké dans le partage
    storage 'craft-lab' comme une icône classique (cf. storage_client.upload_bytes).

    Décision Lot 10 (tranchée avec l'utilisateur, cf. to_do_craft_lab.md) : le contenu CC0 n'est
    PAS copié en octets dans storage — pour ces entrées, `file_path` reste le chemin relatif
    STATIQUE déjà existant (assets/sprite-library/<file_path>, servi par Angular, aucune requête
    storage/token) afin de préserver perf/cache navigateur pour la grande majorité des pièces
    utilisées en jeu (montage de monstre). Seul le contenu utilisateur passe réellement par
    storage. `SpriteAssetSerializer.asset_url` est le seul point qui bifurque selon `source` —
    tout consommateur (frontend, moteur de jeu) passe par lui, jamais par une reconstruction locale
    du chemin.

    `Monster.rig.parts[].assetId` / `RigSkillStep.poses[].tempAssetId` référencent cette table par
    id (JSON libre côté Monster, pas de FK — même style de couplage lâche que le reste du rig).
    """

    class Category(models.TextChoices):
        BLOCK = 'block', 'Block'
        CHARACTER = 'character', 'Personnage'
        MONSTER_CREATURE = 'monster-creature', 'Monstre (assemblé)'
        MONSTER_PART = 'monster-part', 'Pièce de monstre'
        WEAPON = 'weapon', 'Arme'
        TOOL = 'tool', 'Outil'
        EFFECT = 'effect', 'Effet'
        OTHER = 'other', 'Autre'

    class Source(models.TextChoices):
        CC0_BUNDLED = 'cc0-bundled', 'Pack CC0 embarqué'
        AI_GENERATED = 'ai-generated', 'Généré par IA'
        UPLOAD = 'upload', 'Upload manuel'

    name = models.CharField(max_length=200)
    category = models.CharField(max_length=20, choices=Category.choices)
    # Slot d'un gabarit de monstre (body/arm/leg/eye/eyebrow/mouth/nose/detail/snot, cf.
    # monster-parts-manifest.json historique) — pertinent seulement si category=MONSTER_PART,
    # réutilisé tel quel par RigTemplate.slots[].slot_key au Lot 11.
    slot_hint = models.CharField(max_length=50, blank=True)
    # cc0-bundled : chemin relatif dans assets/sprite-library/ (ex: "blocks/dirt.png").
    # ai-generated/upload : chemin relatif dans le partage storage 'craft-lab' (ex:
    # "sprite-assets/monster-part/<uuid>.png"), même convention que Item.icon_path.
    file_path = models.CharField(max_length=1024)
    source = models.CharField(max_length=20, choices=Source.choices)
    tags = models.JSONField(default=list, blank=True)
    created_by_email = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'sprite_assets'
        ordering = ['category', 'name']

    def __str__(self) -> str:
        return f'{self.name} ({self.category})'


# ── Lot 11 : gabarits de monstre ─────────────────────────────────────────────


class RigTemplate(models.Model):
    """
    Gabarit de montage de monstre (Lot 11) — un point de départ réutilisable (ossature + choré-
    graphies par défaut), matérialisé en un vrai `Monster.rig` par
    `POST /api/monsters/<id>/apply-template/` (cf. MonsterViewSet.apply_template). Jamais consommé
    directement en jeu — contrairement à SpriteAsset/Monster, un RigTemplate n'a pas de contrepartie
    dans le moteur Phaser, uniquement au moment de la création du montage.

    `slots` — liste de `{"slot_key": str, "label": str, "asset_slot_hint": str, "default_x": float,
    "default_y": float, "required": bool, "repeatable": bool}`. `asset_slot_hint` est le
    `SpriteAsset.slot_hint` (body/arm/leg/eye/...) dont ce slot propose les pièces au choix — DIFFÉRENT
    de `slot_key` : un gabarit peut avoir DEUX slots structurels ("arm-left"/"arm-right") puisant tous
    deux dans la MÊME catégorie de pièces CC0 ("arm", qui n'a pas de variante gauche/droite — le
    flip côté MonsterRigPart s'en charge). `slot_key` reste l'identifiant unique utilisé pour
    l'indexation des poses et la résolution en partId, jamais `asset_slot_hint`.
      - un slot NON repeatable (Bipède/Volant/Tourelle) est instancié UNE fois, à sa position fixe ;
      - un slot repeatable (seul le gabarit "Ver / serpent" l'utilise) peut être instancié N fois
        (N choisi à l'application, cf. `segment_count` du payload d'apply-template) — `default_x`/
        `default_y` représentent alors l'ESPACEMENT entre deux instances consécutives (segment i à
        `i × default_x`, `i × default_y`), pas une position absolue.

    `default_skills` a la même forme qu'un `Monster.rig["skills"]` (liste de RigSkill), à UNE
    différence : chaque pose de `RigSkillStep.poses` est indexée par `slot_key` (le partId réel
    n'existe pas encore à ce stade) — résolue à l'application. Pour un slot NON repeatable, la
    valeur est une pose unique `{dx, dy, rotationDeg, tempAssetId?}` comme dans un Monster.rig
    normal. Pour un slot repeatable, la valeur est une LISTE de poses de longueur `wavelength`
    (une "photo" de la vague à cette étape, un point par position relative dans le motif) — le
    segment i lit toujours l'entrée `i % wavelength` ; comme cette liste change de forme d'une étape
    à l'autre (le motif se décale), chaque segment rejoue la même onde avec un déphasage égal à sa
    position dans la chaîne, sans qu'aucun concept de "phase" n'existe côté moteur de jeu — tout est
    résolu (aplati en poses concrètes par partId) au moment de `apply_template`, jamais rejoué tel
    quel par GameScene.
    """

    name = models.CharField(max_length=200, unique=True)
    description = models.TextField(blank=True)
    slots = models.JSONField(default=list)
    default_skills = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'rig_templates'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


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
    # Composition reconnue (quels blocks, arrangés comment) — cadre rectangulaire
    # d'un seul type de block (même principe qu'un portail Minecraft), seule forme
    # couverte au Lot 5. {"shape": "frame", "width": <int>, "height": <int>,
    # "block": <Item.id, catégorie block>}. Une forme non rectangulaire (Lot 6+)
    # resterait un JSON différent, sans migration de schéma nécessaire.
    frame_pattern = models.JSONField(default=dict, blank=True)
    destination_map = models.ForeignKey(
        GameMap, on_delete=models.SET_NULL, null=True, blank=True, related_name='portals',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'portals'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


# ── Lot 7 : persistance des mondes et personnages (cahier des charges section 3) ────────────────


class World(models.Model):
    """
    Une partie sauvegardée. Les règles de génération sont RECOPIÉES depuis la
    carte au moment de la création (pas de FK vers GameMap) : décision du
    cahier des charges section 3 (« recopie, plus prévisible ») — une
    évolution ultérieure du catalogue (taux ajustés, palier ajouté...) ne doit
    pas faire dériver une partie déjà en cours.

    `generation_rules` porte tout ce qu'il faut pour régénérer le terrain de
    base à l'identique côté client (mêmes formes que consommées par
    generateTerrainPreview + les tables de spawn de monstres par palier,
    cf. frontend `shared/world/terrain-generation.ts` et
    `pages/play/world-types.ts::WorldGenerationRules`) :
        {"tiers": TierRules[], "monsterSpawns": [{"depthIndex": int, "spawns": [...]}]}

    `block_diff` est un DIFF, pas une carte complète (cahier des charges :
    « journal des modifications... un diff, pas une carte complète ») : une
    seule entrée par cellule modifiée depuis la génération, clé "x,y" ->
    id de block (int) ou null (case vidée). Couvre indifféremment le minage/la
    pose par un joueur ET l'écoulement de liquide — un seul point
    d'instrumentation côté GameScene (setCellVoid/setCellBlock), pas de
    distinction de cause à ce stade.
    """

    name = models.CharField(max_length=200)
    source_map_name = models.CharField(max_length=200, blank=True)
    seed = models.IntegerField()
    generation_rules = models.JSONField()
    block_diff = models.JSONField(default=dict, blank=True)
    created_by_email = models.EmailField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'worlds'
        ordering = ['-updated_at']

    def __str__(self) -> str:
        return self.name


class Character(models.Model):
    """
    Avancement d'un joueur dans un monde (cahier des charges section 3 :
    « inventaire, PV/PM courants, position... structuré, en base, pas de
    blob »). Un seul par (monde, utilisateur) — créé à la volée (get_or_create)
    au premier chargement plutôt qu'explicitement à la création du monde,
    pour rester correct si un autre membre du groupe rejoint plus tard un
    monde déjà créé par quelqu'un d'autre (même catalogue partagé que le
    reste de l'app, cf. CLAUDE.md "Partage lié à un groupe Keycloak").
    """

    world = models.ForeignKey(World, on_delete=models.CASCADE, related_name='characters')
    owner_email = models.EmailField()
    hp = models.FloatField(default=100)
    position_x = models.FloatField(default=0)
    position_y = models.FloatField(default=0)
    # {item_id (str): quantity (int)} — mêmes clés-chaînes qu'un JSON standard,
    # cohérent avec block_diff ci-dessus.
    inventory = models.JSONField(default=dict, blank=True)
    equipped_weapon_id = models.IntegerField(null=True, blank=True)
    # Préfixe de fichier dans assets/sprite-library/characters/ (ex: "adventurer", "zombie") — un
    # skin complet du pack Kenney "Platformer Characters" (5 disponibles), jamais un chemin arbitraire
    # : GameScene dérive lui-même <prefix>_idle/_walk1/_walk2/_jump/_fall.png à partir de cette seule
    # valeur (cf. PLAYER_SKINS côté frontend). Par (monde, utilisateur) comme le reste de Character,
    # pas un profil global — aucune entité "compte utilisateur" n'existe ailleurs dans ce schéma.
    appearance_skin = models.CharField(max_length=32, blank=True, default='adventurer')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'characters'
        constraints = [
            models.UniqueConstraint(fields=['world', 'owner_email'], name='uniq_character_per_world_owner'),
        ]

    def __str__(self) -> str:
        return f'{self.owner_email} @ {self.world}'


def _generate_relay_token() -> str:
    return secrets.token_hex(32)


class RelayTicket(models.Model):
    """
    Ticket à usage unique autorisant une connexion WebSocket sur `relay/`
    (Lot 8) — même principe que `EngineTicket` de robot-lab (patron déjà
    éprouvé dans le lab pour ce problème précis) : un navigateur ne peut pas
    poser de header Authorization custom sur un handshake WS, donc Django
    reste le seul point qui valide le JWT Keycloak (l'endpoint qui émet ce
    billet est protégé comme toute API du lab), et `relay/` vérifie ce billet
    par un callback interne (header `X-Relay-Key`, même famille que
    `X-Engine-Key`/`X-Setup-Key`) plutôt que de revalider un JWT lui-même.
    Consommé à la première vérification, expire vite
    (`RELAY_TICKET_TTL_SECONDS`) : la fenêtre d'usage utile se limite au temps
    d'ouvrir la connexion WS juste après l'avoir reçu.
    """

    token = models.CharField(max_length=64, unique=True, default=_generate_relay_token)
    world = models.ForeignKey(World, on_delete=models.CASCADE, related_name='relay_tickets')
    owner_email = models.EmailField()
    created_at = models.DateTimeField(auto_now_add=True)
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'relay_tickets'

    def is_valid(self) -> bool:
        if self.consumed_at is not None:
            return False
        age = (timezone.now() - self.created_at).total_seconds()
        return age <= RELAY_TICKET_TTL_SECONDS

    def consume(self) -> None:
        self.consumed_at = timezone.now()
        self.save(update_fields=['consumed_at'])
