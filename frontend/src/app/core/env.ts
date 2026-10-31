/**
 * Configuration injectée au démarrage du conteneur (`assets/env.js`, écrit par
 * `nginx-entrypoint.sh`). UN SEUL endroit lit `window.__env`.
 */
export interface LabEnv {
  keycloakUrl?: string;
  keycloakRealm?: string;
  keycloakClientId?: string;
  appUrl?: string;
  apiUrl?: string;
  /** Base de l'API storage (`https://<DOMAIN>/storage-api`). */
  storageApiUrl?: string;
  /** Adresse WebSocket du relais multijoueur (billet `?ticket=`, jamais le jeton). */
  relayUrl?: string;
}

export function labEnv(): LabEnv {
  return (window as unknown as { __env?: LabEnv }).__env ?? {};
}

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Base de l'API de cette app, sans barre finale. */
export function apiUrl(): string {
  return trimBase(labEnv().apiUrl ?? 'http://localhost:8097');
}

/** Base de l'API storage, sans barre finale (icônes et sprites du catalogue). */
export function storageApiUrl(): string {
  const url = labEnv().storageApiUrl;
  return typeof url === 'string' && url.trim() ? trimBase(url) : 'http://localhost:8093';
}

/** Adresse WebSocket du relais. */
export function relayUrl(): string {
  return labEnv().relayUrl ?? 'ws://localhost:8098/ws';
}

/**
 * Les SEULES adresses auxquelles le jeton de l'utilisateur est joint
 * (`auth.interceptor.ts`, `token-scope.ts`) : l'API de l'app, et storage —
 * le navigateur y lit directement les icônes et sprites envoyés
 * (`ApiService.iconUrl`, lus par `AuthBlobService`).
 */
export function tokenBases(): string[] {
  return [apiUrl(), storageApiUrl()];
}
