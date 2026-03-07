const fs = require('fs');
const path = 'c:/Users/Asus/Downloads/carromm/server/ccpvp.html';
let content = fs.readFileSync(path, 'utf8');

// 1. Join tournament room when entering lobby
// Finding openTournamentPanel to append the join call
const openPanelPattern = /function openTournamentPanel\(\) \{ document\.getElementById\('roomPanel'\)\.style\.display = 'block'; \}/;
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

// 2. Enhance exitSpectate for full cleanup
const exitSpecPattern = /function exitSpectate\(\) \{[\s\S]*?window\.returnToRoom\(\);[\s\S]*?\}/;
const newExitSpec = `function exitSpectate() {
      if (!isSpectator) return;
      try { socket.emit('leave_spectate', { matchId: matchRoom }); } catch (e) { console.warn('leave_spectate emit failed', e); }
      
      const specPopup = document.getElementById('spectatorEndPopup') || document.getElementById('matchEndPopup');
      if (specPopup) specPopup.style.display = 'none';
      const specHUD = document.getElementById('spectateHUD') || document.getElementById('spectateHud');
      if (specHUD) specHUD.style.display = 'none';

      isSpectator = false;
      matchRoom = null;

      // hide & remove spectate overlays and blockers
      const overlays = document.querySelectorAll('.spectator-overlay, .spectator-only, .modal-block, #sync-overlay');
      overlays.forEach(n => {
        n.style.display = 'none';
        if (n.classList.contains('spectator-only') && n.parentNode) n.parentNode.removeChild(n);
      });

      // restore controls visually
      const controls = document.getElementById('controls');
      if (controls) {
        controls.style.pointerEvents = 'auto';
        controls.classList.remove('spectator-disabled');
      }

      resetAimUI();
      window.returnToRoom();
    }`;
content = content.replace(exitSpecPattern, newExitSpec);

// 3. Update returnToRoom to hide popups and refresh
const returnToRoomPattern = /function returnToRoom\(\) \{[\s\S]*?window\.isSearchingBattle = false;/;
const newReturnToRoom = `function returnToRoom() {
      // Clean up match state first to prevent stale events
      onMatchEnded();

      // Hide match end popups
      const mp = document.getElementById('matchEndPopup') || document.getElementById('spectatorEndPopup');
      if (mp) mp.style.display = 'none';

      // Request fresh tournament state
      const _savedUser = JSON.parse(localStorage.getItem('player') || '{}');
      const _myPlayerId = (_savedUser && _savedUser.playerId) ? _savedUser.playerId : (window.myPlayerId || '');
      const _tourneyId = window.currentTournamentId || '';
      if (_tourneyId) {
        socket.emit('joinTournamentRoom', { tournamentId: _tourneyId, playerId: _myPlayerId });
      }

      // Remove physics bodies so board is not left visible/stale
      try {
        if (Array.isArray(coins) && coins.length) {
          coins.forEach(c => {
            try { World.remove(engine.world, c); } catch (e) { /*ignore*/ }
          });
          coins = [];
        }
        if (striker) {
          try { World.remove(engine.world, striker); } catch (e) { /*ignore*/ }
          striker = null;
        }
        queenBody = null;
      } catch (e) {
        console.warn('[RETURN_CLEANUP] error removing bodies', e);
      }

      // Hide game UI & overlays
      document.getElementById('overlay').style.display = 'none';
      document.getElementById('ui').style.display = 'none';
      document.getElementById('controls').style.display = 'none';

      // Reset canvas rotation (in case player was black)
      canvas.style.transform = '';

      // Show Home Page and Room Panel if appropriate
      document.getElementById('home-page').style.display = 'flex';
      if (currentRoom) openTournamentPanel();

      // Reset Match/Lobby state
      isMultiplayer = false;
      window.isSearchingBattle = false;`;

content = content.replace(returnToRoomPattern, newReturnToRoom);

fs.writeFileSync(path, content);
console.log('FINAL REPAIR SUCCESSFUL');
