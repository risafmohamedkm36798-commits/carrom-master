const fs = require('fs');
const file = 'c:/Users/Asus/Downloads/carromm/server/ccpvp-34.html';
let content = fs.readFileSync(file, 'utf8');

// 3) Client: accept incoming messages whether server uses matchId or match_<matchId>
// Replace standard guard checks
const guardSearch = /if\s*\(\s*data\.matchId\s*&&\s*matchRoom\s*&&\s*data\.matchId\s*!==\s*matchRoom\s*\)\s*return;/g;
const guardReplace = `const payloadId = data.matchId || data.matchRoom || null;
      if (payloadId && matchRoom && payloadId !== matchRoom && payloadId !== \`match_\${matchRoom}\`) return;`;
content = content.replace(guardSearch, guardReplace);

// Specifically handle spectate_started guard which might be custom:
const specGuardFind = `if (data.matchId && matchRoom && data.matchId !== matchRoom) return;`;
if (content.includes(specGuardFind)) {
    content = content.replace(specGuardFind, `const payloadId = data.matchId || data.matchRoom || null;
      if (payloadId && matchRoom && payloadId !== matchRoom && payloadId !== \`match_\${matchRoom}\`) return;`);
}

// 4) Fix spectator "Back to Lobby" button
if (!content.includes('function leaveSpectate()')) {
    // Add it near the top of the script
    content = content.replace('<script>', `<script>\n// make both names available & point them to the canonical cleanup function\nfunction leaveSpectate() {\n  if (typeof exitSpectate === 'function') return exitSpectate();\n  // fallback: manual cleanup\n  if (matchRoom) {\n    try { socket.emit('leave_spectate', { matchId: matchRoom }); } catch(e) {}\n  }\n  isSpectator = false;\n  matchRoom = null;\n  const hud = document.getElementById('spectateHud'); if (hud) hud.style.display = 'none';\n  const popup = document.getElementById('spectatorEndPopup'); if (popup) popup.style.display = 'none';\n  window.returnToRoom && window.returnToRoom();\n}\n`);
}

// 5) Update client to show spectator board updates
const specEmitFind = `socket.on("spectate_started", (data) => {
      if (!data) return;`;
const specEmitRep = `socket.on("spectate_started", (data) => {
      if (!data) return;
      socket.emit('requestBoardState', { matchRoom: matchRoom });`;
if (content.includes(specEmitFind)) {
    content = content.replace(specEmitFind, specEmitRep);
}

// 6) Lobby: ensure wins/hearts update live for users who haven't played
const playerUpdateFind = `socket.on('playerUpdate', (data) => {
      if (!data || !currentUser) return;
      if (data.playerId === currentUser.playerId) {
        console.log('[CLIENT] Global playerUpdate received:', data);
        currentUser.coins = data.coins;
        currentUser.wins = data.wins;
        // hearts/lives if applicable
        localStorage.setItem("player", JSON.stringify(currentUser));
        showProfile(currentUser);
      }
    });`;

const playerUpdateRep = `socket.on('playerUpdate', (data) => {
      if (!data) return;
      if (currentUser && data.playerId === currentUser.playerId) {
        console.log('[CLIENT] Global playerUpdate received:', data);
        currentUser.coins = data.coins;
        currentUser.wins = data.wins;
        localStorage.setItem("player", JSON.stringify(currentUser));
        typeof showProfile === 'function' && showProfile(currentUser);
      }
      
      // Update tournament UI if visible
      const row = document.getElementById(\`playerRow_\${data.playerId}\`);
      if (row) {
        const winsEl = row.querySelector('.wins');
        if (winsEl) winsEl.textContent = "🏆 " + (data.wins || 0);
        const coinsEl = row.querySelector('.coins');
        if (coinsEl) coinsEl.textContent = data.coins || coinsEl.textContent;
      } else {
        if (typeof currentTournament !== 'undefined' && currentTournament && currentTournament._id) {
          fetch(\`/my-tournament/\${(JSON.parse(localStorage.getItem('player')||'{}')).playerId || data.playerId}\`)
            .then(r => r.json()).then(d => { if (d.success && d.tournament) typeof refreshLobby === 'function' && refreshLobby(d.tournament); }).catch(e=>console.log(e));
        }
      }
    });`;

if (content.includes(playerUpdateFind)) {
    content = content.replace(playerUpdateFind, playerUpdateRep);
}

// 7) Fix battle button stuck / searching behaviour
const returnFind = `window.returnToRoom = () => {
      document.getElementById('overlay').style.display = 'none';
      if (currentTournament) {
        showScreen("lobbyPopup");
      } else {
        location.reload();
      }
    };`;
const returnRep = `window.returnToRoom = () => {
      document.getElementById('overlay').style.display = 'none';
      if (currentTournament) {
        showScreen("lobbyPopup");
      } else {
        location.reload();
      }
      
      const battleBtn = document.getElementById('lobbyBattleBtn') || document.getElementById('battleBtn');
      if (battleBtn) {
        battleBtn.textContent = '⚔ Battle';
        if (typeof amReady !== 'undefined') amReady = false;
      }
      if (window._resetBattleBtn) { delete window._resetBattleBtn; }
      window.isSearchingBattle = false;
    };`;
if (content.includes(returnFind)) {
    content = content.replace(returnFind, returnRep);
}

fs.writeFileSync(file, content);
console.log("Client PATCH COMPLETE!");
