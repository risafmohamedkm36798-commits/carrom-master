const fs = require('fs');

// 1. Fix ccpvp.html encoding and minor UI issues
const ccpvpPath = 'c:/Users/Asus/Downloads/carromm/server/ccpvp.html';
let ccpvpContent = fs.readFileSync(ccvpPath, 'utf8');

ccpvpContent = ccpvpContent.replace(/â¤/g, '❤');
ccpvpContent = ccpvpContent.replace(/Searchingâ€¦/g, 'Searching…');

// Remove the duplicated block I saw in previous view_file (if any)
// Looking at lines 1747-1754, there was some leakage
const leakPattern = /\} \$\{p\.playerId === myPlayerId \? \'\(YOU\)\' : \'\'\}<\/div>[\s\S]*?container\.appendChild\(row\);\s*\}\s*\}/;
ccpvpContent = ccpvpContent.replace(leakPattern, '}');

fs.writeFileSync(ccpvpPath, ccpvpContent);
console.log('Fixed ccpvp.html encoding and leaks');

// 2. Update server-12.js match cleanup
const serverPath = 'c:/Users/Asus/Downloads/carromm/server/server-12.js';
let serverContent = fs.readFileSync(serverPath, 'utf8');

const cleanupPattern = /function endMatchCleanup\(matchRoom\) \{[\s\S]*?emitToMatchRooms\(matchRoom, \'match_ended\', \{ matchId: matchRoom \} \);[\s\S]*?\}/;
const newCleanup = `async function endMatchCleanup(matchRoom) {
  const match = matches[matchRoom];
  if (!match) return;

  console.log(\`[CLEANUP] match: \${matchRoom}\`);
  match.ended = true;

  // Authoritative Tournament Update
  if (match.tournamentId) {
    try {
      const { Tournament } = require('./models/Tournament'); // ensure model is available if needed or assume global
      const t = await Tournament.findById(match.tournamentId);
      if (t) {
        (match.playerIds || []).forEach(pid => {
          const p = t.players.find(x => x.playerId === pid);
          if (p) p.ready = false;
        });
        await t.save();
        io.to('tournament_' + t._id).emit('tournamentUpdate', t);
        console.log(\`[CLEANUP] Cleared ready flags for tournament \${t._id}\`);
      }
    } catch (e) { console.error('[CLEANUP_ERR]', e); }
  }

  if (match.turnTimer) { clearTimeout(match.turnTimer); match.turnTimer = null; }
  if (match.intervalRef) { clearInterval(match.intervalRef); match.intervalRef = null; }
  if (match.timerRef) { clearTimeout(match.timerRef); match.timerRef = null; }

  match.processing_end_turn = false;
  match.turnSeq = 0;
  match.waitingForCover = false;
  match.queenPocketedBy = null;

  emitToMatchRooms(matchRoom, 'match_ended', { matchId: matchRoom });

  setTimeout(() => {
    if (matches[matchRoom]) {
      delete matches[matchRoom];
      console.log(\`[CLEANUP] match: \${matchRoom} deleted path\`);
    }
  }, 15000);
}`;

serverContent = serverContent.replace(cleanupPattern, newCleanup);
fs.writeFileSync(serverPath, serverContent);
console.log('Updated server-12.js cleanup');
