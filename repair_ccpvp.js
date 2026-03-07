const fs = require('fs');
const path = 'c:/Users/Asus/Downloads/carromm/server/ccpvp.html';
let content = fs.readFileSync(path, 'utf8');

// 1. Repair and Update Battle Button Section (Localization-based)
// We find the bracketed mess and replace with the new authoritative logic
const battlePattern = /let currentRoom = ""[\s\S]*?const \{ Engine, Render, Runner, World, Bodies, Body, Vector, Events \} = Matter;/;
const newBattleSection = `let currentRoom = "", amReady = false;
    function openTournamentPanel() { document.getElementById('roomPanel').style.display = 'block'; }
    function closeTournamentPanel() { document.getElementById('roomPanel').style.display = 'none'; }
    document.getElementById('closePanel').addEventListener('click', closeTournamentPanel);
    document.getElementById('battleBtn').addEventListener('click', () => {
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      socket.emit('toggleReady', { tournamentId: _tourneyId, playerId: _myPlayerId });
      const btn = document.getElementById('battleBtn'); btn.disabled = true;
      setTimeout(() => btn.disabled = false, 1200);
    });
    function setBattleButtonState(isReady) {
      const btn = document.getElementById('battleBtn'); if (!btn) return;
      if (isReady) { btn.textContent = 'Searching…'; btn.classList.add('searching'); }
      else { btn.textContent = 'Battle'; btn.classList.remove('searching'); }
    }
    const { Engine, Render, Runner, World, Bodies, Body, Vector, Events } = Matter;`;

content = content.replace(battlePattern, newBattleSection);

// 2. Repair and Update Match Ended Section
const matchEndedPattern = /socket\.on\('match_end[\s\S]*?slider\.addEventListener\('input'/;
const newMatchEndedSection = `socket.on('match_ended', (data) => {
      if (data && data.matchId && data.matchId !== matchRoom) return;
      console.log('[CLIENT] match_ended received for', matchRoom);
      if (isSpectator) {
        document.getElementById('spectatorEndPopup').style.display = 'flex';
        return;
      }
      onMatchEnded();
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (_tourneyId) {
        socket.emit('joinTournamentRoom', { tournamentId: _tourneyId, playerId: _myPlayerId });
      }
    });
    slider.addEventListener('input'`;

content = content.replace(matchEndedPattern, newMatchEndedSection);

// 3. Add Lobby Rendering and Tournament Update handlers (near startMatch)
const startMatchPattern = /function startMatch\(data\) \{[\s\S]*?\}/;
const newLobbyLogic = `function startMatch(data) {
      if (isSpectator) exitSpectate();
      resetAimUI();
      // ... existing logic ...
    }
    function renderTournamentLobby(players) {
      const container = document.getElementById('lobbyPlayers');
      if (!container) return;
      container.innerHTML = '';
      players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'playerRow';
        row.innerHTML = \`
          <div class="name">\${p.name} \${p.playerId === myPlayerId ? '(YOU)' : ''}</div>
          <div class="stat">Wins: \${p.wins}</div>
          <div class="stat">Lives: \${p.lives}</div>
          <div class="status">\${p.ready ? 'Searching...' : 'Lobby'}</div>
        \`;
        container.appendChild(row);
      });
    }
    socket.on('tournamentUpdate', (t) => {
      if (!t) return;
      currentTournament = t;
      renderTournamentLobby(t.players || []);
      const me = (t.players || []).find(p => p.playerId === myPlayerId);
      if (me) setBattleButtonState(me.ready);
    });
    socket.on('playerUpdate', (data) => {
      console.log('[CLIENT] playerUpdate:', data);
    });`;

content = content.replace(startMatchPattern, newLobbyLogic);

fs.writeFileSync(path, content);
console.log('REPAIR AND UPDATE SUCCESSFUL');
