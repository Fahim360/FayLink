import { WebSocketServer } from 'ws';
import http from 'http';

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('FayLink signaling relay is running. Use wss:// or ws:// with ?room=ROOM_ID.\n');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { sockets: new Set(), lastOffer: null, lastAnswer: null });
  return rooms.get(id);
}

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'default';
  const peer = url.searchParams.get('peer') || Math.random().toString(36).slice(2);
  const room = getRoom(roomId);
  socket.roomId = roomId;
  socket.peer = peer;
  room.sockets.add(socket);

  // New joiners receive the last offer/answer if present, so timing is easier.
  if (room.lastOffer) socket.send(JSON.stringify(room.lastOffer));
  if (room.lastAnswer) socket.send(JSON.stringify(room.lastAnswer));

  socket.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    msg.room = roomId;
    msg.peer = peer;
    if (msg.type === 'offer') room.lastOffer = msg;
    if (msg.type === 'answer') room.lastAnswer = msg;
    for (const client of room.sockets) {
      if (client !== socket && client.readyState === client.OPEN) {
        client.send(JSON.stringify(msg));
      }
    }
  });

  socket.on('close', () => {
    room.sockets.delete(socket);
    if (room.sockets.size === 0) {
      setTimeout(() => {
        const latest = rooms.get(roomId);
        if (latest && latest.sockets.size === 0) rooms.delete(roomId);
      }, 5 * 60 * 1000);
    }
  });
});

server.listen(port, () => console.log(`FayLink signaling relay listening on :${port}`));
