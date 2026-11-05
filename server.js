const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
const rooms = {};
function makeCode(){ let c=''; for(let i=0;i<6;i++) c+=Math.floor(Math.random()*10); return c; }
function newPlayer(id,name,color,x,y,isBot){
  return {id,name,color,x,y,dirX:1,dirY:0,trail:[],territory:[],alive:true,score:0,isBot:!!isBot, speed:2.5};
}
io.on('connection',(socket)=>{
  socket.on('createRoom',({name})=>{
    const code=makeCode();
    rooms[code]={players:{},started:false};
    socket.join(code); socket.data.room=code; socket.data.name=name||'Player';
    rooms[code].players[socket.id]=newPlayer(socket.id,socket.data.name,'#ff4757',500+Math.random()*500,500+Math.random()*500,false);
    socket.emit('roomCreated',{code});
    io.to(code).emit('playerList',Object.values(rooms[code].players));
  });
  socket.on('joinRoom',({name,code})=>{
    code=(code||'').trim();
    if(!rooms[code]){socket.emit('errorMsg','קוד לא קיים!');return;}
    if(Object.keys(rooms[code].players).length>=10){socket.emit('errorMsg','החדר מלא!');return;}
    socket.join(code); socket.data.room=code; socket.data.name=name||'Player';
    const colors=['#ff4757','#ffa502','#2ed573','#1e90ff','#eccc68','#ff6b81','#7bed9f','#70a1ff','#5352ed','#ff6348'];
    const idx=Object.keys(rooms[code].players).length;
    rooms[code].players[socket.id]=newPlayer(socket.id,socket.data.name,colors[idx%colors.length],500+Math.random()*500,500+Math.random()*500,false);
    socket.emit('roomJoined',{code});
    io.to(code).emit('playerList',Object.values(rooms[code].players));
  });
  socket.on('startGame',()=>{
    const code=socket.data.room; if(!rooms[code])return;
    const room=rooms[code]; room.started=true;
    const colors=['#ff4757','#ffa502','#2ed573','#1e90ff','#eccc68','#ff6b81','#7bed9f','#70a1ff','#5352ed','#ff6348'];
    let count=Object.keys(room.players).length; let bi=1;
    while(count<10){
      const botId='bot_'+code+'_'+bi;
      room.players[botId]=newPlayer(botId,'Bot '+bi,colors[count%colors.length],300+Math.random()*1400,300+Math.random()*1400,true);
      // שטח התחלתי לבוט
      for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) room.players[botId].territory.push([Math.floor(room.players[botId].x/20)+dx, Math.floor(room.players[botId].y/20)+dy]);
      count++; bi++;
    }
    // שטח התחלתי לשחקנים אמיתיים
    for(const id in room.players){ const p=room.players[id]; if(p.territory.length===0){ for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) p.territory.push([Math.floor(p.x/20)+dx, Math.floor(p.y/20)+dy]); } }
    io.to(code).emit('gameStarted',{players:room.players});
  });
  socket.on('move',({x,y,dirX,dirY})=>{
    const code=socket.data.room; if(!rooms[code]||!rooms[code].players[socket.id])return;
    const p=rooms[code].players[socket.id];
    if(dirX!==undefined){p.dirX=dirX;p.dirY=dirY;}
    if(x!==undefined&&y!==undefined){ const dx=x-p.x,dy=y-p.y; const len=Math.sqrt(dx*dx+dy*dy)||1; p.dirX=dx/len; p.dirY=dy/len; }
  });
  socket.on('disconnect',()=>{
    const code=socket.data.room;
    if(code&&rooms[code]){ delete rooms[code].players[socket.id];
      if(Object.keys(rooms[code].players).filter(id=>!id.startsWith('bot_')).length===0) delete rooms[code];
      else io.to(code).emit('playerList',Object.values(rooms[code].players));
    }
  });
});
setInterval(()=>{
  for(const code in rooms){
    const room=rooms[code]; if(!room.started) continue;
    for(const id in room.players){
      const p=room.players[id]; if(!p.alive) continue;
      if(p.isBot && Math.random()<0.02){ const a=Math.random()*Math.PI*2; p.dirX=Math.cos(a); p.dirY=Math.sin(a); }
      p.x+=p.dirX*p.speed; p.y+=p.dirY*p.speed;
      if(p.x<0)p.x=0; if(p.x>2000)p.x=2000; if(p.y<0)p.y=0; if(p.y>2000)p.y=2000;
      const gx=Math.floor(p.x/20), gy=Math.floor(p.y/20);
      const inTerr = p.territory.some(([tx,ty])=>tx===gx&&ty===gy);
      if(!inTerr){
        const last=p.trail[p.trail.length-1];
        if(!last||last[0]!==gx||last[1]!==gy) p.trail.push([gx,gy]);
      } else if(p.trail.length>0){
        // סגר שטח - מוסיף זנב לשטח
        p.trail.forEach(c=>{ if(!p.territory.some(([tx,ty])=>tx===c[0]&&ty===c[1])) p.territory.push(c); });
        p.score += p.trail.length; p.trail=[];
      }
    }
    // פסילה - מי שדרך על זנב של אחר
    for(const id in room.players){
      const p=room.players[id]; if(!p.alive) continue;
      const gx=Math.floor(p.x/20), gy=Math.floor(p.y/20);
      for(const oid in room.players){
        if(oid===id) continue; const o=room.players[oid]; if(!o.alive) continue;
        if(o.trail.some(([tx,ty])=>tx===gx&&ty===gy)){ o.alive=false; o.trail=[]; }
      }
    }
    io.to(code).emit('gameUpdate',room.players);
  }
},1000/30);
const PORT=process.env.PORT||10000;
server.listen(PORT,()=>console.log('listening '+PORT));
