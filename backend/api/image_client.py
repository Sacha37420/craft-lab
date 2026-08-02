"""
Génération d'image IA (Lot 3, cahier des charges section 2) — l'utilisateur
choisit son fournisseur parmi ceux configurés en Paramétrage (Gemini, Mistral,
OpenAI) : aucun n'était réellement gratuit sans carte au moment du choix
(2026-08-02), donc autant laisser le choix plutôt qu'en imposer un seul.

Volontairement séparé de ai_client.py : la sortie (bytes d'image) n'a rien à
voir avec le JSON structuré des fournisseurs texte — seule la résolution
clé/retry est mutualisée (`_config`, `RETRY_DELAYS`, `_is_transient`).
"""
import time

from .ai_client import DEFAULT_MODELS, AIError, RETRY_DELAYS, _config, _is_transient, _mistral_class

# Seul mistral a un modèle image distinct de son modèle texte par défaut
# (DEFAULT_MODELS['mistral'] sert Lot 2) — mistral-medium-latest est, au
# moment de l'écriture, le seul modèle Mistral à exposer l'outil
# `image_generation` (cf. docs.mistral.ai/studio-api/agents/agent-tools/image_generation).
_IMAGE_MODEL_OVERRIDES = {'mistral': 'mistral-medium-latest'}


def _resolve_model(config, provider: str) -> str:
    override = config.model_name.strip()
    if override:
        return override
    return _IMAGE_MODEL_OVERRIDES.get(provider) or DEFAULT_MODELS[provider]


def _call_gemini(api_key: str, model: str, prompt: str) -> tuple[bytes, str]:
    from google import genai  # import tardif : dépendance lourde, inutile hors assistant image
    from google.genai import types

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(response_modalities=['IMAGE']),
    )
    candidates = getattr(response, 'candidates', None) or []
    for candidate in candidates:
        parts = getattr(candidate.content, 'parts', None) or []
        for part in parts:
            inline_data = getattr(part, 'inline_data', None)
            if inline_data and inline_data.data:
                return inline_data.data, inline_data.mime_type or 'image/png'
    raise AIError("Gemini n'a renvoyé aucune image — reformulez la description.")


def _call_mistral(api_key: str, model: str, prompt: str) -> tuple[bytes, str]:
    """
    Mistral n'a pas d'endpoint images/generate façon OpenAI : la génération
    passe par un agent (outil `image_generation`) + une conversation, le
    fichier résultant étant téléchargé séparément via l'API Files.

    Le chunk contenant l'image (`ToolFileChunk` dans le SDK) est identifié
    par duck-typing (présence d'un `file_id`) plutôt que par un `isinstance`
    sur un chemin d'import (`mistralai.client.models` vs `mistralai.models`
    selon la version du SDK, cf. `_mistral_class` pour le même problème sur
    la classe `Mistral` elle-même) — plus robuste aux réorganisations de
    paquet entre versions 1.x/2.x.
    """
    Mistral = _mistral_class()
    client = Mistral(api_key=api_key)

    agent = client.beta.agents.create(
        model=model,
        name='craft-lab-image-agent',
        description='Génère les icônes/textures du catalogue craft-lab.',
        instructions="Utilise l'outil de génération d'image pour répondre à chaque demande.",
        tools=[{'type': 'image_generation'}],
    )
    response = client.beta.conversations.start(agent_id=agent.id, inputs=prompt)

    outputs = getattr(response, 'outputs', None) or []
    if not outputs:
        raise AIError("Mistral n'a renvoyé aucune sortie.")
    content = getattr(outputs[-1], 'content', None) or []
    for chunk in content:
        file_id = getattr(chunk, 'file_id', None)
        if file_id:
            file_bytes = client.files.download(file_id=file_id).read()
            return file_bytes, 'image/png'
    raise AIError("Mistral n'a renvoyé aucune image — reformulez la description.")


def _call_openai(api_key: str, model: str, prompt: str) -> tuple[bytes, str]:
    import base64

    from openai import OpenAI  # import tardif : dépendance lourde, inutile hors assistant image

    client = OpenAI(api_key=api_key)
    result = client.images.generate(model=model, prompt=prompt)
    data = getattr(result, 'data', None) or []
    if not data or not data[0].b64_json:
        raise AIError("OpenAI n'a renvoyé aucune image.")
    return base64.b64decode(data[0].b64_json), 'image/png'


_CALLERS = {'gemini': _call_gemini, 'mistral': _call_mistral, 'openai': _call_openai}
IMAGE_PROVIDERS = frozenset(_CALLERS)


def generate_image(owner_email: str, provider: str, prompt: str) -> tuple[bytes, str]:
    """Renvoie (bytes, mime_type) de l'image générée par le fournisseur choisi."""
    if provider not in _CALLERS:
        raise AIError(f"Fournisseur image inconnu : « {provider} ».")
    config = _config(owner_email, provider)
    model = _resolve_model(config, provider)
    caller = _CALLERS[provider]

    last_error = None
    for delay in RETRY_DELAYS + [None]:
        try:
            return caller(config.api_key, model, prompt)
        except AIError:
            raise
        except Exception as exc:                    # noqa: BLE001 — SDK tiers, erreurs hétérogènes
            last_error = exc
            if delay is None or not _is_transient(exc):
                raise AIError(f'Appel {provider} en échec : {exc}') from exc
            time.sleep(delay)
    raise AIError(f'Appel {provider} en échec : {last_error}')
