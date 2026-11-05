
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// קוד חדר - רק 6 ספרות!
function makeCode(){
  let c = '';
  for(let i=0;i<6;i++) c += Math.floor(Math.random()*10);
  return c;
}

function createBot(id, index){
  const colors = ['#ff4757','#ffa502','#2ed573','#1e90ff','#eccc68','#ff6b81','#7bed9f','#70a1ff','#5352ed','#ff6348'];
  return {
    id: id, name: 'Bot ' + (index+1), isBot: true, color: colors[index % colors.length],
    x: 100 + Math.random()*600, y: 100 + Math.random()*600,
    dirX: 1, dirY: 0, trail: [], territory: [], alive: true, score: 0
  };
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({name}) => {
    const code = makeCode();
    rooms[code] = { players: {}, started: false };
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name || 'Player';
    rooms[code].players[socket.id] = { id: socket.id, name: socket.data.name, x: 200+Math.random()*400, y: 200+Math.random()*400, color: '#ff4757', trail: [], alive: true, isBot: false };
    socket.emit('roomCreated', { code, players: Object.values(rooms[code].players).length });
    io.to(code).emit('playerList', Object.values(rooms[code].players));
  });

  socket.on('joinRoom', ({name, code}) => {
    code = (code||'').trim();
    if(!rooms[code]){ socket.emit('errorMsg', 'קוד לא קיים!'); return; }
    if(Object.keys(rooms[code].players).length >= 10){ socket.emit('errorMsg', 'החדר מלא!'); return; }
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name || 'Player';
    const colors = ['#ff4757','#ffa502','#2ed573','#1e90ff','#eccc68','#ff6b81','#7bed9f','#70a1ff','#5352ed','#ff6348'];
    const idx = Object.keys(rooms[code].players).length;
    rooms[code].players[socket.id] = { id: socket.id, name: socket.data.name, x: 100+Math.random()*600, y: 100+Math.random()*600, color: colors[idx % colors.length], trail: [], alive: true, isBot: false };
    socket.emit('roomJoined', { code });
    io.to(code).emit('playerList', Object.values(rooms[code].players));
  });

  socket.on('startGame', () => {
    const code = socket.data.room;
    if(!rooms[code]) return;
    const room = rooms[code];
    room.started = true;
    let count = Object.keys(room.players).length;
    let botIndex = 1;
    while(count < 10){
      const botId = 'bot_' + code + '_' + botIndex;
      room.players[botId] = createBot(botId, count);
      count++; botIndex++;
    }
    io.to(code).emit('gameStarted', { players: room.players });
  });

  socket.on('move', ({x, y, dirX, dirY}) => {
    const code = socket.data.room;
    if(!rooms[code] || !rooms[code].players[socket.id]) return;
    const p = rooms[code].players[socket.id];
    if(dirX !== undefined){ p.dirX = dirX; p.dirY = dirY; }
    if(x !== undefined && y !== undefined){
      const dx = x - p.x, dy = y - p.y;
      const len = Math.sqrt(dx*dx+dy*dy) || 1;
      p.dirX = dx/len; p.dirY = dy/len;
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if(code && rooms[code]){
      delete rooms[code].players[socket.id];
      if(Object.keys(rooms[code].players).filter(id=>!id.startsWith('bot_')).length === 0) delete rooms[code];
      else io.to(code).emit('playerList', Object.values(rooms[code].players));
    }
  });
});

setInterval(() => {
  for(const code in rooms){
    const room = rooms[code];
    if(!room.started) continue;
    for(const id in room.players){
      const p = room.players[id];
      if(!p.alive) continue;
      if(p.isBot){
        if(Math.random() < 0.02){
          const a = Math.random()*Math.PI*2;
          p.dirX = Math.cos(a); p.dirY = Math.sin(a);
        }
      }
      p.x += p.dirX * 3;
      p.y += p.dirY * 3;
      if(p.x < 0) p.x = 0; if(p.x > 800) p.x = 800;
      if(p.y < 0) p.y = 0; if(p.y > 800) p.y = 800;
    }
    io.to(code).emit('gameUpdate', room.players);
  }
}, 1000/30);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Paper.io 2 clone listening on port ' + PORT));
