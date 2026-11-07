'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const WORLD = 2000;            // world size in pixels (0..2000)
const GRID = 40;               // cell size in pixels
const N = WORLD / GRID;        // 50 x 50 cells
const SPEED = 6;               // x += dx*6, y += dy*6
const TPS = 30;                // server loop: 30 ticks per second
const MAX_PLAYERS = 10;        // max real players per room (and total in "fill" mode)
const RESPAWN_MS = 2000;       // respawn delay for humans and bots
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Noa', 'Eli', 'Mia', 'Leo', 'Maya', 'Tom', 'Ari', 'Zoe', 'Dan', 'Kim'];
const COLORS = [
  '#ef4444', '#22c55e', '#3b82f6', '#f97316', '#a855f7', '#06b6d4',
  '#ec4899', '#eab308', '#14b8a6', '#84cc16', '#6366f1', '#78716c'
];

// ---------------------------------------------------------------------------
// HTTP + Socket.IO
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = new Map(); // code -> room

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rand(n) { return Math.floor(Math.random() * n); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function cleanName(n) {
  n = String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return n || 'Player';
}

function genCode() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 6; i++) s += CODE_CHARS[rand(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
}

function newRoom(mode, quick) {
  const code = genCode();
  const room = {
    code,
    grid: new Uint16Array(N * N),   // owner id per cell (0 = nobody)
    players: new Map(),             // id -> player (humans + bots)
    hostId: null,
    mode,                           // 'fill' | 'only'
    started: false,
    quick: !!quick,                 // PLAY NOW rooms are private
    nextId: 1,
    dirty: false,
    tick: 0
  };
  rooms.set(code, room);
  return room;
}

function humansOf(room) {
  const a = [];
  for (const p of room.players.values()) if (!p.bot) a.push(p);
  return a;
}

function pickColor(room) {
  const used = new Set();
  for (const p of room.players.values()) used.add(p.color);
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[room.players.size % COLORS.length];
}

function pickBotName(room) {
  const used = new Set();
  for (const p of room.players.values()) used.add(p.name);
  const free = BOT_NAMES.filter(n => !used.has(n));
  return free.length ? free[rand(free.length)] : BOT_NAMES[rand(BOT_NAMES.length)];
}

function makePlayer(room, opts) {
  const p = {
    id: room.nextId++,
    name: opts.name,
    color: pickColor(room),
    bot: !!opts.bot,
    sid: opts.sid || null,
    x: 0, y: 0, dx: 0, dy: 0,
    pending: null,
    alive: false,
    trail: [],
    trailSet: new Set(),
    respawnAt: 0,
    score: 0,
    ai: { last: -1, mode: 'out', tx: 0, ty: 0, maxTrail: 20 }
  };
  room.players.set(p.id, p);
  return p;
}

function socketOf(p) {
  return p.sid ? io.sockets.sockets.get(p.sid) : null;
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------
function emitRoster(room) {
  const list = [];
  for (const p of room.players.values()) {
    list.push({ id: p.id, name: p.name, color: p.color, bot: p.bot });
  }
  io.to(room.code).emit('roster', list);
}

function emitLobby(room) {
  const players = humansOf(room).map(p => ({ id: p.id, name: p.name }));
  for (const p of humansOf(room)) {
    const s = socketOf(p);
    if (!s) continue;
    s.emit('lobby', {
      code: room.code,
      mode: room.mode,
      hostId: room.hostId,
      you: p.id,
      max: MAX_PLAYERS,
      players
    });
  }
}

function emitGrid(room) {
  io.to(room.code).emit('grid', Buffer.from(room.grid.slice().buffer));
}

function emitState(room) {
  const ps = [];
  for (const p of room.players.values()) {
    ps.push({
      i: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      a: p.alive ? 1 : 0,
      s: p.score,
      r: p.alive ? p.trail : []
    });
  }
  io.to(room.code).emit('state', { t: room.tick, p: ps });
}

// ---------------------------------------------------------------------------
// Game logic
// ---------------------------------------------------------------------------
function spawn(room, p) {
  const g = room.grid;
  const trailCells = new Set();
  const heads = [];
  for (const q of room.players.values()) {
    if (!q.alive || q === p) continue;
    for (const c of q.trail) trailCells.add(c);
    heads.push([Math.floor(q.x / GRID), Math.floor(q.y / GRID)]);
  }

  let cx = -1, cy = -1;
  for (let tries = 0; tries < 400 && cx < 0; tries++) {
    const x = 3 + rand(N - 6);
    const y = 3 + rand(N - 6);
    const r = tries < 250 ? 3 : 2;
    let ok = true;
    for (let yy = y - r; yy <= y + r && ok; yy++) {
      for (let xx = x - r; xx <= x + r; xx++) {
        const c = yy * N + xx;
        if (g[c] !== 0 || trailCells.has(c)) { ok = false; break; }
      }
    }
    if (ok && tries < 250) {
      for (const h of heads) {
        if (Math.abs(h[0] - x) + Math.abs(h[1] - y) < 7) { ok = false; break; }
      }
    }
    if (ok) { cx = x; cy = y; }
  }
  if (cx < 0) { cx = 3 + rand(N - 6); cy = 3 + rand(N - 6); } // crowded map: take over a spot

  for (let yy = cy - 1; yy <= cy + 1; yy++) {
    for (let xx = cx - 1; xx <= cx + 1; xx++) g[yy * N + xx] = p.id;
  }
  p.x = (cx + 0.5) * GRID;
  p.y = (cy + 0.5) * GRID;
  if (Math.random() < 0.5) { p.dx = cx < N / 2 ? 1 : -1; p.dy = 0; }
  else { p.dx = 0; p.dy = cy < N / 2 ? 1 : -1; }
  p.pending = null;
  p.alive = true;
  p.trail = [];
  p.trailSet = new Set();
  p.ai.last = -1;
  p.ai.mode = 'out';
  room.dirty = true;
}

function clearTerritory(room, p) {
  const g = room.grid;
  for (let c = 0; c < g.length; c++) if (g[c] === p.id) g[c] = 0;
  room.dirty = true;
}

function killPlayer(room, p, killer) {
  if (!p.alive) return;
  p.alive = false;
  p.trail = [];
  p.trailSet = new Set();
  p.score = 0;
  p.respawnAt = Date.now() + RESPAWN_MS;
  clearTerritory(room, p);
  if (!p.bot) {
    const s = socketOf(p);
    if (s) s.emit('died', { by: killer ? killer.name : '' });
  }
}

function removePlayer(room, p) {
  p.alive = false;
  clearTerritory(room, p);
  room.players.delete(p.id);
}

function addBot(room) {
  const p = makePlayer(room, { name: pickBotName(room), bot: true });
  spawn(room, p);
  return p;
}

// Close the area: trail becomes territory + everything enclosed (steals from others).
function closeArea(room, p) {
  const g = room.grid;
  for (const c of p.trail) g[c] = p.id;

  const outside = new Uint8Array(N * N);
  const stack = [];
  const push = (c) => {
    if (!outside[c] && g[c] !== p.id) { outside[c] = 1; stack.push(c); }
  };
  for (let i = 0; i < N; i++) {
    push(i); push((N - 1) * N + i); push(i * N); push(i * N + N - 1);
  }
  while (stack.length) {
    const c = stack.pop();
    const x = c % N, y = (c / N) | 0;
    if (x > 0) push(c - 1);
    if (x < N - 1) push(c + 1);
    if (y > 0) push(c - N);
    if (y < N - 1) push(c + N);
  }
  for (let c = 0; c < g.length; c++) {
    if (!outside[c]) g[c] = p.id;
  }
  p.trail = [];
  p.trailSet = new Set();
  room.dirty = true;
}

function recount(room) {
  const cnt = new Uint16Array(room.nextId + 1);
  const g = room.grid;
  for (let c = 0; c < g.length; c++) cnt[g[c]]++;
  for (const p of room.players.values()) p.score = p.alive ? cnt[p.id] : 0;
}

// ---------------------------------------------------------------------------
// Bot AI
// ---------------------------------------------------------------------------
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function threatened(room, p) {
  if (!p.trail.length) return false;
  for (const q of room.players.values()) {
    if (q === p || !q.alive) continue;
    const qx = Math.floor(q.x / GRID), qy = Math.floor(q.y / GRID);
    for (const c of p.trail) {
      const tx = c % N, ty = (c / N) | 0;
      if (Math.abs(tx - qx) + Math.abs(ty - qy) <= 3) return true;
    }
  }
  return false;
}

function pickTarget(room, p, cx, cy) {
  const a = p.ai;
  const g = room.grid;
  a.maxTrail = 10 + rand(26);

  // sometimes hunt an enemy trail that is close by
  if (Math.random() < 0.3) {
    const cand = [];
    for (const q of room.players.values()) {
      if (q === p || !q.alive) continue;
      for (const c of q.trail) {
        const tx = c % N, ty = (c / N) | 0;
        if (Math.abs(tx - cx) + Math.abs(ty - cy) <= 14) cand.push(c);
      }
    }
    if (cand.length) {
      const c = cand[rand(cand.length)];
      a.tx = c % N; a.ty = (c / N) | 0;
      return;
    }
  }
  // otherwise a random point outside the own territory
  for (let i = 0; i < 40; i++) {
    const tx = clamp(cx + rand(25) - 12, 1, N - 2);
    const ty = clamp(cy + rand(25) - 12, 1, N - 2);
    if (Math.abs(tx - cx) + Math.abs(ty - cy) >= 4 && g[ty * N + tx] !== p.id) {
      a.tx = tx; a.ty = ty;
      return;
    }
  }
  a.tx = 1 + rand(N - 2);
  a.ty = 1 + rand(N - 2);
}

function nearestOwn(room, p, cx, cy) {
  const g = room.grid;
  let best = -1, bd = 1e9;
  for (let c = 0; c < g.length; c++) {
    if (g[c] !== p.id) continue;
    const d = Math.abs((c % N) - cx) + Math.abs(((c / N) | 0) - cy);
    if (d < bd) { bd = d; best = c; }
  }
  if (best < 0) return [cx, cy];
  return [best % N, (best / N) | 0];
}

function botThink(room, p) {
  const a = p.ai;
  const g = room.grid;
  const cx = clamp(Math.floor(p.x / GRID), 0, N - 1);
  const cy = clamp(Math.floor(p.y / GRID), 0, N - 1);
  const cur = cy * N + cx;
  if (a.last === cur) return;       // decide only when entering a new cell
  a.last = cur;

  const inHome = g[cur] === p.id;
  if (inHome && p.trail.length === 0) {
    a.mode = 'out';
    pickTarget(room, p, cx, cy);
  } else if (!inHome && a.mode === 'out') {
    const d = Math.abs(a.tx - cx) + Math.abs(a.ty - cy);
    if (d <= 0 || p.trail.length >= a.maxTrail || threatened(room, p)) a.mode = 'home';
  } else if (!inHome && p.trail.length > 0 && threatened(room, p)) {
    a.mode = 'home';
  }

  let tx = a.tx, ty = a.ty;
  if (a.mode === 'home') {
    const t = nearestOwn(room, p, cx, cy);
    tx = t[0]; ty = t[1];
  }

  // positions of other heads (avoid head-on crashes while outside)
  const heads = [];
  for (const q of room.players.values()) {
    if (q !== p && q.alive) heads.push([Math.floor(q.x / GRID), Math.floor(q.y / GRID)]);
  }

  let best = null, bestScore = -1e9;
  for (const d of DIRS) {
    if (d[0] === -p.dx && d[1] === -p.dy) continue;   // never 180
    let score = 0;
    for (let k = 1; k <= 4; k++) {
      const nx = cx + d[0] * k, ny = cy + d[1] * k;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) {
        score -= k === 1 ? 1000 : 300 / k;
        break;
      }
      const c = ny * N + nx;
      if (p.trailSet.has(c)) score -= k === 1 ? 1000 : 250 / k;
    }
    const n1x = cx + d[0], n1y = cy + d[1];
    if (!inHome) {
      for (const h of heads) {
        if (Math.abs(h[0] - n1x) + Math.abs(h[1] - n1y) <= 1) { score -= 40; break; }
      }
    }
    score -= (Math.abs(tx - n1x) + Math.abs(ty - n1y)) * 2;
    if (d[0] === p.dx && d[1] === p.dy) score += 1.5;
    score += Math.random();
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best) { p.dx = best[0]; p.dy = best[1]; }
}

// ---------------------------------------------------------------------------
// Game tick
// ---------------------------------------------------------------------------
function tickRoom(room) {
  room.tick++;
  const now = Date.now();
  const g = room.grid;
  const alive = [];

  // respawns + movement
  for (const p of room.players.values()) {
    if (!p.alive) {
      if (now >= p.respawnAt) spawn(room, p);
      continue;
    }
    if (p.bot) botThink(room, p);
    if (p.pending) {
      if (!(p.pending.dx === -p.dx && p.pending.dy === -p.dy)) {
        p.dx = p.pending.dx; p.dy = p.pending.dy;
      }
      p.pending = null;
    }
    p.x = clamp(p.x + p.dx * SPEED, 0, WORLD - 0.01);
    p.y = clamp(p.y + p.dy * SPEED, 0, WORLD - 0.01);
    p.cell = Math.floor(p.y / GRID) * N + Math.floor(p.x / GRID);
    alive.push(p);
  }

  // trail building + self collision
  const deaths = new Map(); // victim -> killer (or null)
  for (const p of alive) {
    const c = p.cell;
    if (g[c] === p.id) continue;
    if (p.trailSet.has(c)) {
      if (p.trail[p.trail.length - 1] !== c) deaths.set(p, null);   // stepped on own trail
    } else {
      p.trail.push(c);
      p.trailSet.add(c);
    }
  }

  // stepping on someone else's trail kills the owner of the trail
  for (const p of alive) {
    for (const q of alive) {
      if (q === p) continue;
      if (q.trailSet.has(p.cell) && g[q.cell] !== q.id) {
        if (!deaths.has(q)) deaths.set(q, p);
      }
    }
  }
  for (const [victim, killer] of deaths) killPlayer(room, victim, killer);

  // closing areas
  for (const p of alive) {
    if (!p.alive) continue;
    if (g[p.cell] === p.id && p.trail.length > 0) closeArea(room, p);
  }

  // scores, wiped-out players
  if (room.dirty) {
    recount(room);
    let again = false;
    for (const p of room.players.values()) {
      if (p.alive && p.score === 0) { killPlayer(room, p, null); again = true; }
    }
    if (again) recount(room);
    emitGrid(room);
    room.dirty = false;
  }

  emitState(room);
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;
    try { tickRoom(room); } catch (e) { console.error('tick error', e); }
  }
}, 1000 / TPS);

// ---------------------------------------------------------------------------
// Room membership
// ---------------------------------------------------------------------------
function joinHuman(socket, room, name) {
  leaveRoom(socket);
  // make space for the newcomer if bots are filling the room
  if (room.started && room.players.size >= MAX_PLAYERS) {
    for (const p of room.players.values()) {
      if (p.bot) { removePlayer(room, p); break; }
    }
  }
  const p = makePlayer(room, { name, sid: socket.id });
  if (!room.hostId) room.hostId = p.id;
  socket.join(room.code);
  socket.data.rc = room.code;
  socket.data.pid = p.id;

  if (room.started) {
    spawn(room, p);
    socket.emit('init', { you: p.id, world: WORLD, grid: GRID });
    emitRoster(room);
  } else {
    emitLobby(room);
  }
  return p;
}

function leaveRoom(socket) {
  const code = socket.data.rc;
  if (!code) return;
  const pid = socket.data.pid;
  socket.leave(code);
  socket.data.rc = null;
  socket.data.pid = null;

  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.get(pid);
  if (p) removePlayer(room, p);

  const humans = humansOf(room);
  if (humans.length === 0) { rooms.delete(code); return; }
  if (room.hostId === pid) room.hostId = humans[0].id;

  if (room.started) {
    if (room.mode === 'fill' && room.players.size < MAX_PLAYERS) addBot(room);
    room.dirty = true;
    emitRoster(room);
  } else {
    emitLobby(room);
  }
}

function startGame(room) {
  if (room.started) return;
  room.started = true;
  for (const p of humansOf(room)) spawn(room, p);
  if (room.mode === 'fill') {
    while (room.players.size < MAX_PLAYERS) addBot(room);
  }
  for (const p of humansOf(room)) {
    const s = socketOf(p);
    if (s) s.emit('init', { you: p.id, world: WORLD, grid: GRID });
  }
  emitRoster(room);
  room.dirty = true;
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.rc = null;
  socket.data.pid = null;

  socket.on('playNow', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = newRoom('fill', true);
    joinHuman(socket, room, cleanName(data && data.name));
    startGame(room);
    cb({ ok: true });
  });

  socket.on('createRoom', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = newRoom('fill', false);
    joinHuman(socket, room, cleanName(data && data.name));
    cb({ ok: true, code: room.code });
  });

  socket.on('joinRoom', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const code = String((data && data.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) return cb({ ok: false, error: 'קוד חדר לא תקין' });
    const room = rooms.get(code);
    if (!room || room.quick) return cb({ ok: false, error: 'החדר לא נמצא' });
    const already = socket.data.rc === code;
    if (!already && humansOf(room).length >= MAX_PLAYERS) {
      return cb({ ok: false, error: 'החדר מלא' });
    }
    if (already) return cb({ ok: true, code });
    joinHuman(socket, room, cleanName(data && data.name));
    cb({ ok: true, code });
  });

  socket.on('setMode', (mode) => {
    const room = rooms.get(socket.data.rc);
    if (!room || room.started || room.hostId !== socket.data.pid) return;
    if (mode !== 'fill' && mode !== 'only') return;
    room.mode = mode;
    emitLobby(room);
  });

  socket.on('start', () => {
    const room = rooms.get(socket.data.rc);
    if (!room || room.started || room.hostId !== socket.data.pid) return;
    startGame(room);
  });

  socket.on('dir', (d) => {
    const room = rooms.get(socket.data.rc);
    if (!room || !room.started || !d) return;
    const p = room.players.get(socket.data.pid);
    if (!p || !p.alive) return;
    const dx = d.dx | 0, dy = d.dy | 0;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return;
    if (dx === -p.dx && dy === -p.dy) return;   // no 180 turns
    p.pending = { dx, dy };
  });

  socket.on('leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on port ' + PORT);
});
