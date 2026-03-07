const fs = require('fs');
const path = 'c:/Users/Asus/Downloads/carromm/server/ccpvp.html';
let content = fs.readFileSync(path, 'utf8');

// 1. Precise Section Replacement to clear mess
// We target the block from 'let currentRoom' down to physics setup
const startMark = 'let currentRoom = ""';
const endMark = 'const { Engine, Render, Runner, World, Bodies, Body, Vector, Events } = Matter;';

const startIndex = content.indexOf(startMark);
const endIndex = content.indexOf(endMark);

if (startIndex !== -1 && endIndex !== -1) {
    const newSection = `let currentRoom = "", amReady = false;
    function openTournamentPanel() { 
      document.getElementById('roomPanel').style.display = 'block'; 
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (_tourneyId) {
        socket.emit('joinTournamentRoom', { tournamentId: _tourneyId, playerId: _myPlayerId });
      }
    }
    function closeTournamentPanel() { document.getElementById('roomPanel').style.display = 'none'; }
    document.getElementById('closePanel').addEventListener('click', closeTournamentPanel);
    
    document.getElementById('battleBtn').addEventListener('click', () => {
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (!_tourneyId) { alert('No active tournament found'); return; }

      // Authoritative toggle
      socket.emit('toggleReady', { tournamentId: _tourneyId, playerId: _myPlayerId });
      
      const btn = document.getElementById('battleBtn');
      btn.disabled = true;
      setTimeout(() => btn.disabled = false, 1000);
    });

    function setBattleButtonState(isReady) {
      const btn = document.getElementById('battleBtn'); if (!btn) return;
      if (isReady) { btn.textContent = 'Searching...'; btn.classList.add('searching'); }
      else { btn.textContent = 'Battle'; btn.classList.remove('searching'); }
    }
    `;

    content = content.substring(0, startIndex) + newSection + content.substring(endIndex);
    fs.writeFileSync(path, content);
    console.log('CCPVP.HTML CLEANUP SUCCESSFUL');
} else {
    console.log('COULD NOT FIND SECTION IN CCPVP.HTML');
}
