// server/server.js
// Authoritative Battleship server + static file host
// Start with: npm start  (see package.json scripts)

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

// ----- Paths -----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT   = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// ----- Static file server -----
const httpServer = createServer((req, res) => {
  try {
    const raw = (req.url || '/').split('?')[0];
    // Very basic traversal guard
    const safe = raw.replace(/\.\.(\/|\\)?/g, '');
    const filePath = path.join(PUBLIC, safe === '/' ? 'index.html' : safe);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const type =
        ext === '.html' ? 'text/html' :
        ext === '.css'  ? 'text/css'  :
        ext === '.js'   ? 'text/javascript' :
        'text/plain';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  } catch {
    res.writeHead(500);
    res.end('Server error');
  }
});

// ----- WebSocket server -----
const wss  = new WebSocketServer({ server: httpServer });
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on', PORT);
});

// ----- Game state (in-memory) -----
/**
 * rooms: Map<code, {
 *   createdAt:number,
 *   phase:'placing'|'battle'|'gameover',
 *   turn: playerId|null,
 *   winner: playerId|null,
 *   players: {
 *     [playerId]: {
 *       id:string,
 *       board:number[10][10],
 *       ships:Array<{id:number,length:number,cells:number[][],hits?:string[]}>,
 *       marks:number[10][10], // 0 unknown, 2 hit, 3 miss (my view of enemy)
 *       ready:boolean
 *     }
 *   }
 * }>
 */
const rooms = new Map();

// ----- Constants & helpers -----
const SIZE  = 10;
const EMPTY = 0;
const SHIPS = [5, 4, 3, 3, 2];

const now   = () => Date.now();
const code6 = () => Math.floor(100000 + Math.random() * 900000).toString();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}
function otherPlayerId(room, pid) {
  return Object.keys(room.players).find(id => id !== pid) || null;
}
function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function getRoom(ws) {
  if (!ws.room) return null;
  return rooms.get(ws.room) || null;
}

// Per-socket basic rate limit (defense-in-depth)
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 15; // msgs / second
function rateLimiter() {
  let windowStart = now();
  let count = 0;
  return function ok() {
    const t = now();
    if (t - windowStart > RATE_LIMIT_WINDOW_MS) { windowStart = t; count = 0; }
    count++;
    return count <= RATE_LIMIT_MAX;
  };
}

// Mask opponent board so client only sees confirmed hits
function maskOpponentBoard(board, myMarks) {
  if (!board) return null;
  const out = board.map(row => row.slice());
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const seenHit = myMarks && myMarks[r][c] === 2;
      if (!seenHit) out[r][c] = EMPTY;
    }
  }
  return out;
}

function roomStateFor(ws, room) {
  const meId = ws.playerId;
  const oppId = otherPlayerId(room, meId);
  const me  = meId ? room.players[meId]  : null;
  const opp = oppId ? room.players[oppId] : null;

  const safeOppBoard = opp ? maskOpponentBoard(opp.board, me?.marks) : null;
  const code = [...rooms.entries()].find(([, v]) => v === room)?.[0] || null;

  return {
    type: 'ROOM_STATE',
    code,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    players: {
      me: me ? {
        id: meId,
        board: me.board,
        marks: me.marks,
        ships: me.ships.map(s => ({ id: s.id, length: s.length, hits: s.hits || [] })),
        ready: me.ready
      } : null,
      opp: opp ? {
        id: oppId,
        board: safeOppBoard,
        marks: opp.marks,
        ships: opp.ships.map(s => ({ id: s.id, length: s.length, hits: s.hits || [] })),
        ready: opp.ready
      } : null
    }
  };
}

function broadcastRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  wss.clients.forEach(ws => {
    if (ws.room !== code) return;
    send(ws, roomStateFor(ws, room));
  });
}

/**
 * Rebuilds and validates the fleet from the incoming board.
 * Accepts { board } and reconstructs ships as straight contiguous lines.
 * Enforces standard lengths [5,4,3,3,2], no overlaps, no branches, no single-cell ships.
 * Normalizes ship IDs to 1..N and returns { board, ships } or {} if invalid.
 */
function sanitizeFleet(payload){
  try{
    if (!payload) return {};
    const board = payload.board;
    if (!Array.isArray(board) || board.length !== SIZE) return {};

    // Validate board shape and numbers
    for (let r = 0; r < SIZE; r++) {
      if (!Array.isArray(board[r]) || board[r].length !== SIZE) return {};
      for (let c = 0; c < SIZE; c++) {
        const v = board[r][c];
        if (!Number.isInteger(v) || v < 0) return {};
      }
    }

    // Rebuild ships from contiguous straight lines of same id
    const visited = Array.from({length: SIZE}, () => Array(SIZE).fill(false));
    const ships = [];
    const inb = (rr,cc) => rr>=0 && rr<SIZE && cc>=0 && cc<SIZE;

    for (let r=0; r<SIZE; r++){
      for (let c=0; c<SIZE; c++){
        const id = board[r][c];
        if (id === EMPTY || visited[r][c]) continue;

        // Decide orientation (H / V / S)
        let orient = null;
        if (inb(r, c+1) && board[r][c+1] === id) orient = 'H';
        else if (inb(r+1, c) && board[r+1][c] === id) orient = 'V';
        else orient = 'S'; // single-cell — invalid for our fleet

        const cells = [];
        if (orient === 'H'){
          let cc = c;
          while (inb(r, cc) && board[r][cc] === id && !visited[r][cc]) {
            cells.push([r, cc]);
            visited[r][cc] = true;
            cc++;
          }
        } else if (orient === 'V'){
          let rr = r;
          while (inb(rr, c) && board[rr][c] === id && !visited[rr][c]) {
            cells.push([rr, c]);
            visited[rr][c] = true;
            rr++;
          }
        } else {
          // single cell ship -> mark visited and invalid (reject later)
          visited[r][c] = true;
          cells.push([r, c]);
        }

        // No branches: ensure no same-id neighbor outside the traced line
        for (const [rr, cc] of cells){
          const nbrs = [[rr,cc-1],[rr,cc+1],[rr-1,cc],[rr+1,cc]];
          for (const [nr, nc] of nbrs){
            if (inb(nr,nc) && board[nr][nc] === id){
              if (!cells.some(([xr,xc]) => xr===nr && xc===nc)) {
                return {}; // branch/corner detected
              }
            }
          }
        }

        const length = cells.length;
        ships.push({ id, length, cells, hits: [] });
      }
    }

    // Validate fleet lengths against standard set [5,4,3,3,2]
    const wanted = [5,4,3,3,2].sort((a,b)=>b-a).join(',');
    const got    = ships.map(s => s.length).sort((a,b)=>b-a).join(',');
    if (got !== wanted) return {};

    // Normalize IDs to 1..N and rebuild the board
    ships.sort((a,b)=>a.id-b.id);
    for (let i=0; i<ships.length; i++){
      ships[i].id = i+1;
    }
    const normBoard = emptyBoard();
    for (const s of ships){
      for (const [rr,cc] of s.cells) normBoard[rr][cc] = s.id;
    }

    return { board: normBoard, ships };
  } catch {
    return {};
  }
}

// Garbage-collect empty rooms
function cleanupRooms() {
  for (const [code, room] of rooms) {
    const hasClient = [...wss.clients].some(ws => ws.room === code);
    if (!hasClient) rooms.delete(code);
  }
}

// ----- WebSocket lifecycle -----
wss.on('connection', (ws) => {
  ws.id = randomUUID();
  ws.room = null;
  ws.playerId = null;
  ws.okRate = rateLimiter();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    if (!ws.okRate()) return; // drop spammy clients
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    switch (msg.type) {
      case 'CREATE_ROOM': {
        const code = code6();
        rooms.set(code, {
          createdAt: now(),
          phase: 'placing',
          turn: null,
          winner: null,
          players: {}
        });
        send(ws, { type: 'ROOM_CREATED', code });
        break;
      }

      case 'JOIN_ROOM': {
        const code = (msg.code || '').trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'ERROR', error: 'NO_SUCH_ROOM' }); break; }

        const ids = Object.keys(room.players);
        if (ids.length >= 2) { send(ws, { type: 'ERROR', error: 'ROOM_FULL' }); break; }

        const playerId = randomUUID();
        room.players[playerId] = {
          id: playerId,
          board: emptyBoard(),
          ships: [],
          marks: emptyBoard(),
          ready: false
        };

        ws.room = code;
        ws.playerId = playerId;

        send(ws, { type: 'JOINED', code, playerId });
        broadcastRoom(code);
        break;
      }

      case 'PLACE_FLEET': {
        const room = getRoom(ws); if (!room) break;
        if (room.phase !== 'placing') break;

        const p = room.players[ws.playerId]; if (!p) break;
        const clean = sanitizeFleet(msg.payload);
        if (!clean.board || !clean.ships) { send(ws, { type: 'ERROR', error: 'BAD_FLEET' }); break; }

        p.board = clean.board;
        p.ships = clean.ships;
        p.ready = !!msg.ready;

        broadcastRoom(ws.room);

        // If both players are ready, start battle
        const ids = Object.keys(room.players);
        if (ids.length === 2 && ids.every(id => room.players[id].ready)) {
          room.phase = 'battle';
          room.turn = ids[Math.floor(Math.random() * 2)];
          broadcastRoom(ws.room);
        }
        break;
      }

      case 'FIRE': {
        const room = getRoom(ws); if (!room) break;
        if (room.phase !== 'battle') break;
        if (room.turn !== ws.playerId) break; // not your turn

        const me = room.players[ws.playerId]; if (!me) break;
        const oppId = otherPlayerId(room, ws.playerId); if (!oppId) break;
        const opp = room.players[oppId];

        let { r, c } = msg;
        r = clamp(~~r, 0, SIZE - 1);
        c = clamp(~~c, 0, SIZE - 1);

        // Already fired here?
        if (me.marks[r][c] === 2 || me.marks[r][c] === 3) break;

        const id = opp.board[r][c];
        if (id === EMPTY) {
          me.marks[r][c] = 3; // miss
          room.turn = oppId;  // switch turn
        } else {
          me.marks[r][c] = 2; // hit
          const ship = opp.ships.find(s => s.id === id);
          ship.hits = ship.hits || [];
          const key = `${r},${c}`;
          if (!ship.hits.includes(key)) ship.hits.push(key);

          // Win check
          const oppAllSunk = opp.ships.every(s => (s.hits || []).length === s.length);
          if (oppAllSunk) {
            room.phase = 'gameover';
            room.winner = ws.playerId;
          } else {
            room.turn = oppId; // pass turn even on hit
          }
        }

        broadcastRoom(ws.room);
        break;
      }

      case 'REQUEST_STATE': {
        const room = getRoom(ws); if (!room) break;
        send(ws, roomStateFor(ws, room));
        break;
      }

      default:
        // ignore unknown types
        break;
    }
  });

  ws.on('close', () => {
    cleanupRooms(); // GC empty rooms
  });
});

// Heartbeat: terminate dead sockets to keep wss healthy
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 15000);

// Start servers
httpServer.listen(PORT, () => {
  console.log(`Battleship server running at http://localhost:${PORT}`);
  if (req.url === '/healthz') {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('ok');
  return;
}
});
