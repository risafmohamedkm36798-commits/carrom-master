const fs = require('fs');
const file = 'c:/Users/Asus/Downloads/carromm/server/server-12-14.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Add helper
if (!content.includes('function emitToMatchRooms')) {
    const helper = `\n// --- MATCH NOTIFICATION HELPER ---\nfunction emitToMatchRooms(matchRoom, event, payload) {\n  io.to(matchRoom).emit(event, payload);\n  io.to(\`match_\${matchRoom}\`).emit(event, payload);\n}\n\n`;
    content = content.replace('function getSocketForPlayer', helper + 'function getSocketForPlayer');
}

// 2. Replace io.to(matchRoom).emit
content = content.replace(/io\.to\(matchRoom\)\.emit\('boardState', /g, "emitToMatchRooms(matchRoom, 'boardState', ");
content = content.replace(/io\.to\(matchRoom\)\.emit\('queen_covered', /g, "emitToMatchRooms(matchRoom, 'queen_covered', ");
content = content.replace(/io\.to\(matchRoom\)\.emit\('queen_return', /g, "emitToMatchRooms(matchRoom, 'queen_return', ");
content = content.replace(/io\.to\(matchRoom\)\.emit\('queen_pocketed', /g, "emitToMatchRooms(matchRoom, 'queen_pocketed', ");
content = content.replace(/io\.to\(matchRoom\)\.emit\('gameEnd', /g, "emitToMatchRooms(matchRoom, 'gameEnd', ");
content = content.replace(/io\.to\(matchRoom\)\.emit\('match_ended', /g, "emitToMatchRooms(matchRoom, 'match_ended', ");

// io.to(matchRoom).emit("gameEnd", ... 
content = content.replace(/io\.to\(matchRoom\)\.emit\("gameEnd", /g, 'emitToMatchRooms(matchRoom, "gameEnd", ');
content = content.replace(/io\.to\(matchRoom\)\.emit\("match_ended", /g, 'emitToMatchRooms(matchRoom, "match_ended", ');
content = content.replace(/io\.to\(matchRoom\)\.emit\("timer_update", /g, 'emitToMatchRooms(matchRoom, "timer_update", ');

// 3. liveUpdate
content = content.replace(/socket\.to\(matchRoom\)\.emit\("liveUpdate", (.*?)\);/g, 'socket.to(matchRoom).emit("liveUpdate", $1);\n    io.to(`match_${matchRoom}`).emit("liveUpdate", $1);');

// 4. spectate_match handler
const spectateFind = `socket.join(\`match_\${matchId}\`);
    match.spectators = match.spectators || [];`;
const spectateRep = `socket.join(matchId);
    socket.join(\`match_\${matchId}\`);
    match.spectators = match.spectators || [];`;
if (content.includes(spectateFind)) {
    content = content.replace(spectateFind, spectateRep);
}

// 5. io.to(\`match_\${matchId}\`).emit('spectator_count_update'  -> to both
const countFind1 = `io.to(\`match_\${matchId}\`).emit('spectator_count_update', { count: match.spectators.length });
  });`;
const countRep1 = `io.to(matchId).emit('spectator_count_update', { count: match.spectators.length });
    io.to(\`match_\${matchId}\`).emit('spectator_count_update', { count: match.spectators.length });
  });`;
if (content.includes(countFind1)) {
    content = content.replace(countFind1, countRep1);
}

// And in leave_spectate:
const leaveSpecFind = `socket.leave(\`match_\${matchId}\`);
      io.to(\`match_\${matchId}\`).emit('spectator_count_update', { count: match.spectators.length });`;
const leaveSpecRep = `socket.leave(matchId);
      socket.leave(\`match_\${matchId}\`);
      io.to(matchId).emit('spectator_count_update', { count: match.spectators.length });
      io.to(\`match_\${matchId}\`).emit('spectator_count_update', { count: match.spectators.length });`;
if (content.includes(leaveSpecFind)) {
    content = content.replace(leaveSpecFind, leaveSpecRep);
}

// Also disconnect cleanup for spectator room
const discSpecFind = `io.to(\`match_\${matchRoom}\`).emit('spectator_count_update', { count: match.spectators.length });`;
const discSpecRep = `io.to(matchRoom).emit('spectator_count_update', { count: match.spectators.length });
        io.to(\`match_\${matchRoom}\`).emit('spectator_count_update', { count: match.spectators.length });`;
if (content.includes(discSpecFind)) {
    content = content.replace(discSpecFind, discSpecRep);
}

fs.writeFileSync(file, content);
console.log('Patched correctly!');
