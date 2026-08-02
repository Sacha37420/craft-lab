"""
Assistant IA texte du catalogue (Lot 2, cahier des charges section 2) :
suggère nom/description et valeurs de stats, à partir du schéma de l'entité
éditée et d'un extrait du catalogue existant de la même catégorie — pour
rester cohérent avec le lore déjà construit et équilibré par comparaison,
plutôt que de proposer hors-sol.

Ne persiste jamais rien lui-même : la vue renvoie une proposition, c'est au
frontend de l'appliquer (ou non) au formulaire avant un enregistrement
explicite de l'utilisateur — même principe que l'assistant de robot-lab.
"""
from .ai_client import complete_json
from .models import Artifact, Block, Monster, Projectile, Tool, Weapon

# Pour chaque catégorie éditable : les champs de stats que l'IA peut
# proposer, leur documentation (injectée dans le prompt) et le sous-schéma
# JSON correspondant. Armes/projectiles/artefacts/outils/blocks/monstres —
# cartes/portails n'ont pas de suggestion IA (pas de « stats » simples à
# proposer, cf. to_do_craft_lab.md Lot 4 : la carte est un jeu de règles par
# palier, pas une entité avec nom/description/stats comparable aux autres).
CATEGORY_SPECS = {
    'block': {
        'label': 'block',
        'model': Block,
        'fields_doc': (
            "- hardness (nombre) : dureté du bloc, comparée à la puissance de "
            "l'outil nécessaire pour le casser. Reste à une échelle cohérente "
            "avec les blocks déjà catalogués ci-dessous."
        ),
        'schema_props': {'hardness': {'type': 'number'}},
        'required': ['hardness'],
    },
    'weapon': {
        'label': 'arme',
        'model': Weapon,
        'fields_doc': (
            "- style : une valeur parmi melee/ranged/magic/summon\n"
            "- damage (nombre) : dégâts de base\n"
            "- attack_range (nombre ou null) : portée, pertinente surtout pour "
            "ranged/magic\n"
            "- attack_rate (nombre ou null) : cadence d'attaque"
        ),
        'schema_props': {
            'style': {'type': 'string', 'enum': ['melee', 'ranged', 'magic', 'summon']},
            'damage': {'type': 'number'},
            'attack_range': {'type': ['number', 'null']},
            'attack_rate': {'type': ['number', 'null']},
        },
        'required': ['style', 'damage'],
    },
    'projectile': {
        'label': 'projectile',
        'model': Projectile,
        'fields_doc': "- damage (nombre) : dégâts infligés par le projectile",
        'schema_props': {'damage': {'type': 'number'}},
        'required': ['damage'],
    },
    'tool': {
        'label': 'outil',
        'model': Tool,
        'fields_doc': (
            "- tool_type : une valeur parmi pickaxe/axe\n"
            "- power (nombre) : puissance (détermine quels blocks l'outil peut "
            "casser)\n"
            "- speed (nombre) : vitesse de cassage"
        ),
        'schema_props': {
            'tool_type': {'type': 'string', 'enum': ['pickaxe', 'axe']},
            'power': {'type': 'number'},
            'speed': {'type': 'number'},
        },
        'required': ['tool_type', 'power', 'speed'],
    },
    'artifact': {
        'label': 'artefact',
        'model': Artifact,
        'fields_doc': (
            "Un artefact n'a pas de stats directes ici — seuls le nom et la "
            "description sont à proposer (ses effets se configurent séparément, "
            "par type d'effet, une fois l'artefact créé)."
        ),
        'schema_props': {},
        'required': [],
    },
    'monster': {
        'label': 'monstre',
        'model': Monster,
        # Monster n'est pas un Item (cf. models.py) : name/description vivent
        # directement dessus, pas de recette — `standalone` bascule
        # _catalogue_excerpt() sur le chemin sans `.item`.
        'standalone': True,
        'fields_doc': (
            "- level (entier) : niveau de difficulté/puissance relative\n"
            "- detection_range (nombre) : portée de détection d'un personnage "
            "ennemi\n"
            "- attack_type : une valeur parmi melee/ranged/magic\n"
            "- attack_damage (nombre) : dégâts par attaque\n"
            "- attack_rate (nombre) : cadence d'attaque"
        ),
        'schema_props': {
            'level': {'type': 'integer'},
            'detection_range': {'type': 'number'},
            'attack_type': {'type': 'string', 'enum': ['melee', 'ranged', 'magic']},
            'attack_damage': {'type': 'number'},
            'attack_rate': {'type': 'number'},
        },
        'required': ['level', 'detection_range', 'attack_type', 'attack_damage', 'attack_rate'],
    },
}


def _catalogue_excerpt(category: str, limit: int = 15) -> str:
    """
    Résumé compact des entrées existantes de cette catégorie — jamais le
    catalogue entier, pour garder le prompt court (cf. cahier des charges
    section 2 : l'assistant doit connaître « un extrait pertinent », pas une
    page vide).
    """
    spec = CATEGORY_SPECS[category]
    if spec.get('standalone'):
        rows = spec['model'].objects.order_by('-created_at')[:limit]
        lines = []
        for row in rows:
            stats = {field: getattr(row, field) for field in spec['schema_props']}
            description = row.description or '(sans description)'
            lines.append(f"- {row.name} : {description} — {stats}")
        return '\n'.join(lines) if lines else '(catalogue vide pour cette catégorie pour le moment)'

    rows = spec['model'].objects.select_related('item').order_by('-item__created_at')[:limit]
    lines = []
    for row in rows:
        stats = {field: getattr(row, field) for field in spec['schema_props']}
        description = row.item.description or '(sans description)'
        lines.append(f"- {row.item.name} : {description} — {stats}")
    return '\n'.join(lines) if lines else '(catalogue vide pour cette catégorie pour le moment)'


def suggest(owner_email: str, provider: str, category: str, partial: dict) -> dict:
    """Renvoie {name, description, rationale, **stats} pour la catégorie donnée."""
    if category not in CATEGORY_SPECS:
        raise ValueError(f"Catégorie inconnue : {category}")
    spec = CATEGORY_SPECS[category]

    system = (
        "Tu es l'assistant de conception du catalogue de craft-lab, un jeu type "
        "Minecraft/Terraria édité collectivement par son groupe de joueurs. Ton "
        "rôle : proposer un nom, une description et des valeurs de stats pour un "
        "objet du catalogue, cohérents avec l'univers déjà construit (n'invente "
        "pas un lore hors-sol) et équilibrés par comparaison avec les objets déjà "
        "existants de la même catégorie — un objet ne doit pas être extrêmement "
        "plus fort ou plus faible que ses voisins, sauf si l'utilisateur le "
        "demande explicitement.\n\n"
        f"Catégorie éditée : {spec['label']}. Champs de stats à proposer :\n"
        f"{spec['fields_doc']}\n\n"
        f"Objets déjà présents dans le catalogue (catégorie {spec['label']}) :\n"
        f"{_catalogue_excerpt(category)}"
    )
    message = (
        "Voici ce que l'utilisateur a déjà rempli dans son formulaire (peut être "
        f"partiel ou vide) : {partial}\n\n"
        "Propose un nom (garde celui déjà saisi s'il est déjà bon), une "
        "description, et des valeurs de stats. Justifie brièvement ton choix "
        "dans `rationale` (2-3 phrases maximum)."
    )
    schema = {
        'type': 'object',
        'properties': {
            'name': {'type': 'string'},
            'description': {'type': 'string'},
            'rationale': {'type': 'string'},
            **spec['schema_props'],
        },
        'required': ['name', 'description', 'rationale', *spec['required']],
    }
    return complete_json(owner_email, provider, system, message, schema)
