# Service relais temps réel (Lot 8) — aucun navigateur nécessaire ici
# (contrairement à runner/ ou robot-lab/engine) : juste un serveur WebSocket
# léger qui relaie des messages JSON entre les clients d'un même monde.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 4310
CMD ["node", "server.js"]
