const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const WORLD = 2000;
const GRID = 40;
const N = WORLD / GRID; // 50 x 50 cells
const FPS = 30;
const SPEED = 6; // pixels per tick (180 px/s)
const RESPAWN_MS = 2000;
const BOT_COUNT = 5;

const COLORS = [
  '#ff4d6d', '#2f9bff', '#2fc45a', '#ff9f2e', '#a678ff',
  '#12b5cb', '#ff6fae', '#f5c400', '#82c91e', '#ff6b35'
];
const BOT_NAMES = ['Nova', 'Pixel', 'Ziggy', 'Mochi', 'Turbo', 'Blip', 'Comet', 'Waffle'];

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const owner = new Array(N * N).fill(-1);      // territory owner (pid) per cell
const trailOwner = new Array(N * N).fill(-1); // trail owner (pid) per cell
const players = {};                           // by socket / bot id
const byPid = {};                             // by numeric pid
let nextPid = 0;
let gridDirty = true;

function pickColor() {
  const used = new Set(Object.values(players).map((p) => p.color));
  const free = COLORS.filter((c) => !used.has(c));
  const list = free.length ? free : COLORS;
  return list[Math.floor(Math.random() * list.length)];
}

function cleanName(raw) {
  let n = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, '').trim() : '';
  if (!n) n = 'Player';
  return n.slice(0, 14);
}

function createPlayer(id, name, bot) {
  const p = {
    id,
    pid: nextPid++,
    name,
    x: 0, y: 0, dx: 1, dy: 0,
    color: pickColor(),
    trail: [],
    territory: [],
    alive: false,
    score: 0,
    bot: !!bot,
    respawnAt: 0,
    cx: 0, cy: 0,
    out: 0, maxOut: 6, decided: -1,
    home: { x: 0, y: 0 }
  };
  players[id] = p;
  byPid[p.pid] = p;
  spawn(p);
  return p;
}

function spawn(p) {
  let gx = 0;
  let gy = 0;
  let ok = false;
  for (let t = 0; t < 100 && !ok; t++) {
    gx = 2 + Math.floor(Math.random() * (N - 4));
    gy = 2 + Math.floor(Math.random() * (N - 4));
    ok = true;
    for (let y = gy - 2; y <= gy + 2 && ok; y++) {
      for (let x = gx - 2; x <= gx + 2; x++) {
        const i = y * N + x;
        if (owner[i] !== -1 || trailOwner[i] !== -1) { ok = false; break; }
      }
    }
  }
  for (let y = gy - 1; y <= gy + 1; y++) {
    for (let x = gx - 1; x <= gx + 1; x++) owner[y * N + x] = p.pid;
  }
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const d = dirs[Math.floor(Math.random() * 4)];
  p.dx = d[0];
  p.dy = d[1];
  p.x = (gx + 0.5) * GRID;
  p.y = (gy + 0.5) * GRID;
  p.cx = gx;
  p.cy = gy;
  p.trail = [];
  p.alive = true;
  p.out = 0;
  p.maxOut = 4 + Math.floor(Math.random() * 8);
  p.decided = -1;
  gridDirty = true;
}

function clearTrail(p) {
  for (const c of p.trail) {
    const i = c[1] * N + c[0];
    if (trailOwner[i] === p.pid) trailOwner[i] = -1;
  }
  p.trail = [];
}

function die(p) {
  if (!p.alive) return;
  p.alive = false;
  clearTrail(p);
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === p.pid) owner[i] = -1;
  }
  p.territory = [];
  p.score = 0;
  p.respawnAt = Date.now() + RESPAWN_MS;
  gridDirty = true;
}

function closeArea(p) {
  const barrier = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) if (owner[i] === p.pid) barrier[i] = 1;
  for (const c of p.trail) barrier[c[1] * N + c[0]] = 1;

  const outside = new Uint8Array(N * N);
  const stack = [];
  const push = (x, y) => {
    const i = y * N + x;
    if (!barrier[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let k = 0; k < N; k++) { push(k, 0); push(k, N - 1); push(0, k); push(N - 1, k); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % N;
    const y = (i - x) / N;
    if (x > 0) push(x - 1, y);
    if (x < N - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < N - 1) push(x, y + 1);
  }
  for (let i = 0; i < N * N; i++) {
    if (!barrier[i] && !outside[i]) owner[i] = p.pid; // enclosed area, steals from others
  }
  for (const c of p.trail) {
    const i = c[1] * N + c[0];
    owner[i] = p.pid;
    trailOwner[i] = -1;
  }
  p.trail = [];
  gridDirty = true;
}

function recomputeTerritories() {
  const sums = {};
  for (const p of Object.values(players)) {
    p.territory = [];
    sums[p.pid] = { x: 0, y: 0 };
  }
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (o < 0) continue;
    const p = byPid[o];
    if (!p) { owner[i] = -1; continue; }
    p.territory.push(i);
    const x = i % N;
    sums[o].x += x;
    sums[o].y += (i - x) / N;
  }
  for (const p of Object.values(players)) {
    p.score = p.territory.length;
    if (p.score > 0) {
      p.home = { x: Math.round(sums[p.pid].x / p.score), y: Math.round(sums[p.pid].y / p.score) };
    }
  }
}

function botSteer(p) {
  const gx = p.cx;
  const gy = p.cy;
  const cxp = (gx + 0.5) * GRID;
  const cyp = (gy + 0.5) * GRID;
  if (Math.abs(p.x - cxp) > SPEED / 2 + 0.01 || Math.abs(p.y - cyp) > SPEED / 2 + 0.01) return;
  const key = gy * N + gx;
  if (p.decided === key) return;
  p.decided = key;

  const inside = owner[key] === p.pid;
  if (inside) {
    p.out = 0;
    if (p.trail.length === 0 && Math.random() < 0.3) p.maxOut = 4 + Math.floor(Math.random() * 8);
  } else {
    p.out++;
  }

  const all = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const opts = [];
  for (const d of all) {
    const reverse = d[0] === -p.dx && d[1] === -p.dy;
    if (reverse && p.trail.length) continue;
    const nx = gx + d[0];
    const ny = gy + d[1];
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    if (trailOwner[ny * N + nx] === p.pid) continue;
    opts.push({ d, nx, ny, reverse });
  }
  if (!opts.length) return;

  const forward = opts.filter((o) => !o.reverse);
  const pool = forward.length ? forward : opts;
  let pick;
  if (!inside && p.out > p.maxOut) {
    pool.sort((a, b) =>
      Math.hypot(a.nx - p.home.x, a.ny - p.home.y) - Math.hypot(b.nx - p.home.x, b.ny - p.home.y));
    pick = pool[0];
  } else {
    const straight = pool.find((o) => o.d[0] === p.dx && o.d[1] === p.dy);
    if (straight && Math.random() > 0.12) pick = straight;
    else pick = pool[Math.floor(Math.random() * pool.length)];
  }
  p.dx = pick.d[0];
  p.dy = pick.d[1];
}

function tick() {
  const now = Date.now();
  for (const p of Object.values(players)) {
    if (!p.alive) {
      if (now >= p.respawnAt) spawn(p);
      continue;
    }
    if (p.bot) botSteer(p);

    p.x = Math.min(WORLD - 0.5, Math.max(0.5, p.x + p.dx * SPEED));
    p.y = Math.min(WORLD - 0.5, Math.max(0.5, p.y + p.dy * SPEED));
    const gx = Math.min(N - 1, Math.floor(p.x / GRID));
    const gy = Math.min(N - 1, Math.floor(p.y / GRID));
    if (gx === p.cx && gy === p.cy) continue;
    p.cx = gx;
    p.cy = gy;

    const idx = gy * N + gx;
    const t = trailOwner[idx];
    if (t !== -1) {
      const victim = byPid[t];
      if (victim === p) { die(p); continue; }
      if (victim) die(victim);
    }

    if (owner[idx] === p.pid) {
      if (p.trail.length) closeArea(p);
    } else {
      p.trail.push([gx, gy]);
      trailOwner[idx] = p.pid;
    }
  }

  if (gridDirty) recomputeTerritories();

  io.emit('state', {
    t: now,
    players: Object.values(players).map((p) => ({
      id: p.id,
      pid: p.pid,
      name: p.name,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      dx: p.dx,
      dy: p.dy,
      color: p.color,
      trail: p.trail,
      alive: p.alive,
      score: p.score
    })),
    grid: gridDirty ? owner : null
  });
  gridDirty = false;
}

io.on('connection', (socket) => {
  gridDirty = true;

  socket.on('setName', (raw) => {
    const name = cleanName(raw);
    const existing = players[socket.id];
    if (existing) existing.name = name;
    else createPlayer(socket.id, name, false);
    gridDirty = true;
  });

  socket.on('move', (d) => {
    const p = players[socket.id];
    if (!p || !p.alive || !d) return;
    const dx = Math.sign(Number(d.dx) || 0);
    const dy = Math.sign(Number(d.dy) || 0);
    if ((dx !== 0) === (dy !== 0)) return; // exactly one axis
    if (p.trail.length && dx === -p.dx && dy === -p.dy) return; // no 180 turns while drawing
    p.dx = dx;
    p.dy = dy;
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (!p) return;
    clearTrail(p);
    for (let i = 0; i < owner.length; i++) if (owner[i] === p.pid) owner[i] = -1;
    delete byPid[p.pid];
    delete players[socket.id];
    gridDirty = true;
  });
});

for (let i = 0; i < BOT_COUNT; i++) {
  createPlayer('bot-' + i, BOT_NAMES[i % BOT_NAMES.length], true);
}
recomputeTerritories();

setInterval(tick, 1000 / FPS);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Paper.io 2 clone listening on port ' + PORT);
});
