import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * Service relais temps réel (Lot 8, cahier des charges section 3) : relaie
 * les messages d'état entre les clients connectés à un même monde (position,
 * changements de blocks, monstres/combat au Lot 8b) sans jamais interpréter
 * le contenu ni toucher la base directement — un simple `broadcast`, la
 * simulation reste entièrement côté client (GameScene).
 *
 * Authentification par billet à usage unique (cf. api/models.py::RelayTicket) :
 * un navigateur ne peut pas poser de header Authorization sur un handshake WS,
 * donc Django reste le seul point qui valide le JWT Keycloak (et le groupe
 * requis — même verrou que toute API du lab), et ce service vérifie le billet
 * par un callback interne (X-Relay-Key) plutôt que revalider un JWT lui-même.
 * Patron directement repris de robot-lab/engine (déjà éprouvé dans ce lab
 * pour exactement ce problème), adapté ici pour des salons multi-clients
 * (un monde = un salon) plutôt qu'une session exclusive globale.
 */

const PORT = 4310;
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://craft-lab-backend:8000';
const RELAY_KEY = process.env.RELAY_INTERNAL_KEY || '';

// world_id (string) -> Map<connId, { ws, ownerEmail, isHost }>
const rooms = new Map();

const app = express();
app.get('/healthz', (_req, res) => {
  const roomSizes = Object.fromEntries([...rooms.entries()].map(([id, room]) => [id, room.size]));
  res.json({ ok: true, rooms: roomSizes });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

async function verifyTicket(token) {
  const res = await fetch(`${BACKEND_URL}/api/internal/verify-relay-ticket/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Key': RELAY_KEY },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Billet refusé (${res.status})`);
  }
  return res.json(); // { world_id, owner_email }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(worldId, payload, exceptConnId) {
  const room = rooms.get(worldId);
  if (!room) return;
  for (const [connId, client] of room) {
    if (connId !== exceptConnId) send(client.ws, payload);
  }
}

function roster(worldId) {
  const room = rooms.get(worldId);
  return room ? [...room.entries()].map(([id, c]) => ({ id, ownerEmail: c.ownerEmail })) : [];
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const token = url.searchParams.get('ticket');
  if (!token) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, token));
});

wss.on('connection', async (ws, token) => {
  let worldId;
  let ownerEmail;
  try {
    const result = await verifyTicket(token);
    worldId = String(result.world_id);
    ownerEmail = result.owner_email;
  } catch (err) {
    send(ws, { type: 'error', detail: err.message });
    ws.close(1008, 'billet invalide');
    return;
  }

  const connId = crypto.randomUUID();
  let room = rooms.get(worldId);
  if (!room) { room = new Map(); rooms.set(worldId, room); }

  // Premier arrivé dans le salon = hôte (cf. cahier des charges section 3 :
  // "autorité distribuée à un client hôte par monde actif") — utilisé au
  // Lot 8b pour les monstres/combat, pas encore exploité par ce lot-ci.
  const isHost = room.size === 0;
  room.set(connId, { ws, ownerEmail, isHost });
  const hostId = [...room.entries()].find(([, c]) => c.isHost)?.[0] ?? connId;

  send(ws, { type: 'welcome', selfId: connId, hostId, players: roster(worldId) });
  broadcast(worldId, { type: 'player-joined', id: connId, ownerEmail }, connId);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    // Relais pur, protocole ouvert à extension (même principe que robot-lab/engine) :
    // aucune validation/interprétation du contenu au-delà de la présence d'un `type`.
    // `id` est TOUJOURS réécrit avec l'identifiant serveur de la connexion — un client
    // ne peut jamais usurper l'identité d'un autre en falsifiant ce champ.
    broadcast(worldId, { ...msg, id: connId }, connId);
  });

  ws.on('close', () => {
    const wasHost = room.get(connId)?.isHost;
    room.delete(connId);
    broadcast(worldId, { type: 'player-left', id: connId });
    if (room.size === 0) {
      rooms.delete(worldId);
    } else if (wasHost) {
      const [nextId, nextClient] = [...room.entries()][0];
      nextClient.isHost = true;
      broadcast(worldId, { type: 'host-changed', hostId: nextId });
    }
  });
});

server.listen(PORT, () => console.log(`craft-lab-relay en écoute sur :${PORT}`));
