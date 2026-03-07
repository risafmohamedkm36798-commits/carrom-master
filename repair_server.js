const fs = require('fs');
const path = 'c:/Users/Asus/Downloads/carromm/server/server-12.js';
let content = fs.readFileSync(path, 'utf8');

// 1. Authoritative joinTournamentRoom
const joinPattern = /socket\.on\('joinTournamentRoom'[\s\S]*?console\.log\(\`\[JOIN_TOURNAMENT\] \$\{playerId\} socket=\$\{socket\.id\}\`[\s\S]*?\);[\s\S]*?\}\);/;
const newJoin = `socket.on('joinTournamentRoom', async ({ tournamentId, playerId }) => {
    const t = await Tournament.findById(tournamentId);
    if (!t) return;

    socket.join(\`tournament_\${tournamentId}\`);
    // AUTHORITATIVE: send only to joining socket
    socket.emit('tournamentUpdate', t);
    
    console.log(\`[JOIN_TOURNAMENT] \${playerId} joined room tournament_\${tournamentId}\`);
  });`;

content = content.replace(joinPattern, newJoin);

// 2. toggleReady + Matchmaking logic
const readyHandlersPattern = /socket\.on\('cancelTournamentReady'[\s\S]*?claimed = await Tournament\.findOneAndUpdate\([\s\S]*?\{[\s\S]*?arrayFilters: \[[\s\S]*?\}\s*\);/;
const newReadySection = `socket.on('toggleReady', async ({ tournamentId, playerId }) => {
    try {
      const t = await Tournament.findById(tournamentId);
      if (!t) return;
      
      const p = t.players.find(x => x.playerId === playerId);
      if (!p || p.lives <= 0) return;

      p.ready = !p.ready;
      p.socketId = socket.id;
      await t.save();

      io.to(\`tournament_\${tournamentId}\`).emit('tournamentUpdate', t);
      console.log(\`[TOGGLE_READY] \${playerId} now ready=\${p.ready}\`);

      if (p.ready) {
        checkAndStartTournamentMatches(tournamentId);
      }
    } catch (err) { console.error(err); }
  });

  async function checkAndStartTournamentMatches(tournamentId) {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament || tournament.status !== "live") return;

    const readyPlayers = tournament.players.filter(p => p.ready && p.lives > 0 && p.socketId);
    if (readyPlayers.length < 2) return;

    const p1 = readyPlayers[0];
    const p2 = readyPlayers[1];

    const claimed = await Tournament.findOneAndUpdate(
      {
        _id: tournamentId,
        "players": { $elemMatch: { playerId: p1.playerId, ready: true, lives: { $gt: 0 } } }
      },
      {
        $set: {
          "players.$[first].ready": false,
          "players.$[second].ready": false
        }
      },
      {
        arrayFilters: [{ "first.playerId": p1.playerId }, { "second.playerId": p2.playerId }],
        new: true
      }
    );`;

content = content.replace(readyHandlersPattern, newReadySection);

fs.writeFileSync(path, content);
console.log('SERVER-12.JS REPAIR SUCCESSFUL');
