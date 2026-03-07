const fs = require('fs');
const path = 'c:/Users/Asus/Downloads/carromm/server/ccpvp.html';
let content = fs.readFileSync(path, 'utf8');

// 1. Helper: escapeHtml
if (!content.includes('function escapeHtml')) {
    const headEndPattern = /<\/head>/;
    const escapeFn = `<script>
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>\n</head>`;
    content = content.replace(headEndPattern, escapeFn);
}

// 2. Update openTournamentPanel to call joinTournamentRoom
const openPanelPattern = /function openTournamentPanel\(\) \{[\s\S]*?\}/;
const newOpenPanel = `function openTournamentPanel() { 
      document.getElementById('roomPanel').style.display = 'block'; 
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (_tourneyId) {
        socket.emit('joinTournamentRoom', { tournamentId: _tourneyId, playerId: _myPlayerId });
      }
    }`;
content = content.replace(openPanelPattern, newOpenPanel);

// 3. New renderTournamentLobby with name, wins, hearts/lives
const renderLobbyPattern = /function renderTournamentLobby\(players\) \{[\s\S]*?\}/;
const newRenderLobby = `function renderTournamentLobby(players) {
      const list = document.getElementById('lobbyPlayers');
      if (!list) return;
      list.innerHTML = ''; // full redraw
      players.forEach(p => {
        const div = document.createElement('div');
        div.id = \`playerRow_\${p.playerId}\`;
        div.className = 'playerRow';
        div.innerHTML = \`
          <div class="name">\${escapeHtml(p.name || p.playerId)} \${p.playerId === myPlayerId ? '(YOU)' : ''}</div>
          <div class="wins">Wins: \${p.wins || 0}</div>
          <div class="hearts">â¤ \${p.lives || p.hearts || 0}</div>
          <div class="ready">\${p.ready ? '<span class="searching">Searchingâ€¦</span>' : ''}</div>
        \`;
        list.appendChild(div);
      });
    }`;
content = content.replace(renderLobbyPattern, newRenderLobby);

// 4. Update tournamentUpdate to hide spinner and set button state
const tournamentUpdatePattern = /socket\.on\('tournamentUpdate', \(t\) => \{[\s\S]*?\}\);/;
const newTournamentUpdate = `socket.on('tournamentUpdate', (t) => {
      if (!t) return;
      // If you had a spinner: document.getElementById('lobbySpinner').style.display = 'none';
      document.getElementById('lobbyPlayers').style.display = 'block';

      currentTournament = t;
      renderTournamentLobby(t.players || []);
      const me = (t.players || []).find(p => p.playerId === myPlayerId);
      if (me) {
        setBattleButtonState(me.ready);
      }
    });`;
content = content.replace(tournamentUpdatePattern, newTournamentUpdate);

// 5. Battle button click handler - authoritative toggle
const battleBtnPattern = /document\.getElementById\('battleBtn'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);/;
const newBattleBtnHandler = `document.getElementById('battleBtn').addEventListener('click', () => {
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (!_tourneyId) { alert('No active tournament found'); return; }

      // Authoritative toggle
      socket.emit('toggleReady', { tournamentId: _tourneyId, playerId: _myPlayerId });
      
      const btn = document.getElementById('battleBtn');
      btn.disabled = true;
      setTimeout(() => btn.disabled = false, 1000);
    });`;
content = content.replace(battleBtnPattern, newBattleBtnHandler);

// 6. returnToRoom - reset transient state and re-request state
const returnToRoomPattern = /function returnToRoom\(\) \{[\s\S]*?window\.isSearchingBattle = false;/;
const newReturnToRoom = `function returnToRoom() {
      // clean client-side transient state
      onMatchEnded();
      currentTurnSeq = 0;
      waitingForServer = false;
      myTurn = false;
      isAuthoritative = false;
      
      // hide popups
      const matchEndPopup = document.getElementById('matchEndPopup') || document.getElementById('spectatorEndPopup');
      if (matchEndPopup) matchEndPopup.style.display = 'none';

      // reset Battle button visually while waiting for server state
      setBattleButtonState(false);

      // request tournament state
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (_tourneyId) {
        socket.emit('joinTournamentRoom', { tournamentId: _tourneyId, playerId: _myPlayerId });
      }

      // Physics cleanup...
      try {
        if (Array.isArray(coins) && coins.length) {
          coins.forEach(c => World.remove(engine.world, c));
          coins = [];
        }
        if (striker) { World.remove(engine.world, striker); striker = null; }
        queenBody = null;
      } catch (e) {}

      document.getElementById('overlay').style.display = 'none';
      document.getElementById('ui').style.display = 'none';
      document.getElementById('controls').style.display = 'none';
      canvas.style.transform = '';
      document.getElementById('home-page').style.display = 'flex';
      if (currentRoom) openTournamentPanel();

      isMultiplayer = false;
      window.isSearchingBattle = false;`;

content = content.replace(returnToRoomPattern, newReturnToRoom);

fs.writeFileSync(path, content);
console.log('SYNC REFINEMENT PATCH SUCCESSFUL');
