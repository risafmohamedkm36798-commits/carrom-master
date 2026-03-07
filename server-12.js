require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const session = require('express-session');
const MongoStorePkg = require('connect-mongo'); // defensive import
const MongoStore = (MongoStorePkg && MongoStorePkg.default) ? MongoStorePkg.default : MongoStorePkg;
const cors = require("cors");
const bcrypt = require("bcryptjs");
const http = require("http");
const { Server } = require("socket.io");
const RedeemCode = require("./models/RedeemCode");
// connect to MongoDB (do not call models yet)
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('FATAL: MONGO_URI env var is not set');
  process.exit(1);
}
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Failed:", err);
    process.exit(1);
  });

// --- UTILITY: safeRunMatchOp (Mutex) ---
// Run an async match operation only if not already running. If running, return false.
async function safeRunMatchOp(match, op) {
  if (!match) return false; // Added this check for safety
  if (match.processing) return false;
  match.processing = true;
  return (async () => {
    try { await op(); } finally { match.processing = false; }
    return true;
  })();
}

// --- SERVER: helper to broadcast authoritative tournament state to all lobby clients ---
function emitTournamentUpdate(tournamentId, tournamentObj) {
  try {
    const roomName = tournamentId;
    const payload = tournamentObj || null;
    if (!payload) {
      console.warn('[emitTournamentUpdate] no payload available for', tournamentId);
      return;
    }
    io.to(roomName).emit('tournamentUpdate', payload);
    console.log('[emitTournamentUpdate] tournament:', tournamentId, 'players:', (payload.players || []).length);
  } catch (err) {
    console.error('[emitTournamentUpdate] error', err);
  }
}

// canonical helper for stable player-to-socket lookup

// --- MATCH NOTIFICATION HELPER ---
function emitToMatchRooms(matchRoom, event, payload) {
  io.to(matchRoom).emit(event, payload);
  io.to(`match_${matchRoom}`).emit(event, payload);
}

function getSocketForPlayer(match, playerId) {
  if (!match || !match.playerSockets) return null;
  return match.playerSockets[playerId] || null;
}

// --- UTILITY: Turn Timer Centralization ---
function startTurnTimeout(matchRoom, ms = 15000) {
  const match = matches[matchRoom];
  if (!match) return;
  if (match.turnTimer) { clearTimeout(match.turnTimer); match.turnTimer = null; }
  match.turnTimer = setTimeout(() => {
    safeRunMatchOp(match, async () => { await processEndTurn(matchRoom, { auto: true }, null); });
  }, ms);
}

function clearTurnTimeout(matchRoom) {
  const match = matches[matchRoom];
  if (!match) return;
  if (match.turnTimer) { clearTimeout(match.turnTimer); match.turnTimer = null; }
}

function emitBoardState(match, matchRoom) {
  match.turnSeq = (match.turnSeq || 0) + 1;
  const shooterPid = match.currentShooterPlayerId;
  emitToMatchRooms(matchRoom, 'boardState', {
    boardState: match.boardState || [],
    scores: match.scores || { white: 0, black: 0 },
    matchId: matchRoom,
    seq: match.turnSeq,
    nextShooterPlayerId: shooterPid,
    nextShooterRole: match.roleByPlayer ? match.roleByPlayer[shooterPid] : null
  });
}

const userSchema = new mongoose.Schema({
  playerId: String,
  name: String,
  email: { type: String, unique: true },
  password: String,
  coins: { type: Number, default: 0 },
  points: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  lives: { type: Number, default: 3 },
  winStreak: { type: Number, default: 0 }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);

// Legacy Redeem model removed

const tournamentSchema = new mongoose.Schema({
  name: String,
  creatorId: String,
  capacity: { type: Number, default: 60 },
  entryFee: { type: Number, default: 100 },
  startTime: Date,
  endTime: Date,
  status: { type: String, default: "waiting" }, // waiting | live | ended
  prizePool: { type: Number, default: 0 },

  players: [
    {
      playerId: String,
      name: String,
      wins: { type: Number, default: 0 },
      score: { type: Number, default: 0 },
      lives: { type: Number, default: 3 },
      ready: { type: Boolean, default: false },
      eliminated: { type: Boolean, default: false },

      // ✅ ADD THESE
      socketId: { type: String, default: null },
      connected: { type: Boolean, default: false },
      lastSeen: { type: Date }
    }
  ]
});

const Tournament = mongoose.model("Tournament", tournamentSchema);

// once the Tournament model exists and the DB connection is open, schedule tournaments
mongoose.connection.once('open', async () => {
  try {
    const waiting = await Tournament.find({ status: 'waiting' });
    waiting.forEach(t => scheduleTournamentTimers(t._id));
    console.log(`[STARTUP] scheduled ${waiting.length} waiting tournaments`);
  } catch (err) {
    console.error('[STARTUP] error scheduling tournaments:', err);
  }
});

const tournamentTimers = new Map(); // tournamentId -> { startTimer, endTimer }

// session setup (defensive)

const app = express();
app.use(cors({ origin: true, credentials: true })); // Allow credentials
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
// session middleware (production-ready store)
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: (typeof MongoStore.create === 'function' && process.env.MONGO_URI)
    ? MongoStore.create({ mongoUrl: process.env.MONGO_URI })
    : undefined,
  cookie: {
    httpOnly: true,
    secure: (process.env.NODE_ENV === 'production'),
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(__dirname));

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), now: Date.now() });
});
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};
const matches = {};
const MATCH_DURATION_MS = 4 * 60 * 1000; // 4 minutes
const WIN_SCORE = 9;

// --- helper: find match by socket id ----------
// Returns an object { match, matchRoom, playerId, role } or null if not found.
function findMatch(socketId) {
  if (!socketId) return null;
  for (const roomId of Object.keys(matches || {})) {
    const match = matches[roomId];
    if (!match) continue;

    // 1) check legacy players array of socket ids
    if (Array.isArray(match.players) && match.players.includes(socketId)) {
      // try to get playerId if mapped
      const pid = (match.playersWithIds && match.playersWithIds[socketId]) || null;
      const role = pid && match.roleByPlayer ? match.roleByPlayer[pid] : (match.roleBySocket && match.roleBySocket[socketId]) || null;
      return { match, matchRoom: roomId, playerId: pid, role };
    }

    // 2) check playerSockets map: playerId -> socketId
    if (match.playerSockets) {
      for (const pid of Object.keys(match.playerSockets)) {
        if (match.playerSockets[pid] === socketId) {
          const role = match.roleByPlayer ? match.roleByPlayer[pid] : null;
          return { match, matchRoom: roomId, playerId: pid, role };
        }
      }
    }

    // 3) check spectators list
    if (Array.isArray(match.spectators) && match.spectators.includes(socketId)) {
      return { match, matchRoom: roomId, playerId: null, role: 'spectator' };
    }
  }
  return null;
}

// --- Backwards-compat wrapper so both names work ---
async function handleEndTurn(matchOrRoom, payload = {}, socket = null) {
  // if a match object was passed accidentally, convert to roomId
  const matchRoom = (typeof matchOrRoom === 'string') ? matchOrRoom : (matchOrRoom && matchOrRoom.matchRoom) || (matchOrRoom && matchOrRoom.roomId) || null;
  // prefer processEndTurn if present (authoritative resolver)
  if (typeof processEndTurn === 'function') {
    return await processEndTurn(matchRoom, payload, socket);
  }
  console.warn('[SERVER] handleEndTurn called but no implementation found');
}

// --- AUTHORITATIVE END TURN PROCESSOR (Hoisted) ---
async function processEndTurn(matchRoom, payload = {}, socket = null) {
  const match = matches[matchRoom];
  if (!match || match.ended) return false;

  // Prevent concurrent resolution
  if (match.processing_end_turn) return false;
  match.processing_end_turn = true;

  try {
    const { boardState, flags = {}, auto = false, playerId } = payload;
    const shooterPlayerId = playerId || match.currentShooterPlayerId;
    const shooterRole = match.roleByPlayer ? match.roleByPlayer[shooterPlayerId] : (match.roleBySocket && match.roleBySocket[socket && socket.id]) || 'white';

    console.log(auto ? `[TIMEOUT_TURN] ${matchRoom} shooter: ${shooterPlayerId}` : `[END_TURN] ${matchRoom} shooter: ${shooterPlayerId}`);

    // --- 1) Derive authoritative boardState & pocketed list ---
    const prevBoard = Array.isArray(match.previousBoardState) ? match.previousBoardState : (match.boardState || []);
    const currentBoard = boardState || match.boardState || [];

    const labelCounts = (list) => {
      const counts = {};
      (list || []).forEach(c => {
        const lbl = ((c && (c.label || c.id)) || '').toString().toLowerCase();
        if (lbl) counts[lbl] = (counts[lbl] || 0) + 1;
      });
      return counts;
    };
    const prevCounts = labelCounts(prevBoard);
    const currCounts = labelCounts(currentBoard);
    const pocketed = [];
    Object.keys(prevCounts).forEach(lbl => {
      const diff = Math.max(0, prevCounts[lbl] - (currCounts[lbl] || 0));
      for (let i = 0; i < diff; i++) pocketed.push(lbl);
    });
    console.log('[SERVER] computed pocketed this shot:', pocketed);

    // --- 2) Authoritative scoring (apply to both roles) ---
    match.scores = match.scores || { white: 0, black: 0 };
    const counts = { white: 0, black: 0, queen: 0 };
    pocketed.forEach(l => { if (['white', 'black', 'queen'].includes(l)) counts[l]++; });
    match.scores.white += counts.white;
    match.scores.black += counts.black;

    // --- 3) Foul logic (Differentiated) ---
    const isStrikerFoul = !!flags.strikerPocketed;
    const isZoneFoul = !!flags.zoneFoul;
    const isDirectFoul = isStrikerFoul || isZoneFoul || !!flags.directFoul;

    if (isDirectFoul && !isStrikerFoul) {
      // 1) Restore board & scores (preserve undo behaviour)
      match.boardState = JSON.parse(JSON.stringify(match.previousBoardState || []));
      match.scores = JSON.parse(JSON.stringify(match.previousScores || { white: 0, black: 0 }));
      console.log('[SERVER] Direct foul: board and scores restored');

      // 2) PENALTY: if shooter had previous points (>0), deduct 1 and respawn one penalty coin to center
      const prevScore = (match.previousScores || match.scores)[shooterRole] || 0;
      if (prevScore > 0) {
        match.scores[shooterRole] = Math.max(0, (match.scores[shooterRole] || 0) - 1);
        const penaltyId = `penalty_${Date.now()}`;
        match.boardState.push({ id: penaltyId, label: shooterRole, x: 0.5, y: 0.5, penalty: true });
        console.log('[SERVER] Direct foul: -1 point applied and penalty coin respawned for', shooterRole);
      }
    } else if (isStrikerFoul) {
      // Striker foul: deduct 1 point (if >0), respawn penalty coin to center (do NOT undo board)
      match.boardState = currentBoard;
      if ((match.scores[shooterRole] || 0) > 0) {
        match.scores[shooterRole] = Math.max(0, (match.scores[shooterRole] || 0) - 1);
        const penaltyId = `penalty_${Date.now()}`;
        match.boardState.push({ id: penaltyId, label: shooterRole, x: 0.5, y: 0.5 });
        console.log('[SERVER] Striker foul: 1 point deducted, penalty coin spawned');
      }
    } else {
      match.boardState = currentBoard;
    }

    // --- 4) Queen handling (Authoritative) ---
    // normalize pocketed labels (defensive)
    const pocketedLc = pocketed.map(p => (p || '').toString().toLowerCase());

    // server-side derived booleans (from flags)
    let queenPocketedNow = pocketedLc.includes('queen') || !!(flags && flags.queenPocketedThisShot);
    let coveredThisShot = !!(flags && (flags.coverThisShot || flags.queenCoveredThisShot));

    // DEFENSIVE: if both queen and a shooter's-role coin appear in pocketed list,
    // treat as immediate cover even when client flags were missed.
    if (!coveredThisShot && queenPocketedNow && shooterRole && pocketedLc.includes(shooterRole.toString().toLowerCase())) {
      coveredThisShot = true;
      console.log('[SERVER] defensive-detected: queen + cover in same shot -> treated as covered');
    }

    if (queenPocketedNow) {
      if (coveredThisShot && !isDirectFoul) {
        // immediate cover in same shot: award +3 to shooter
        match.scores[shooterRole] += 3;
        match.waitingForCover = false;
        match.queenPocketedBy = null;
        match.turnSeq = (match.turnSeq || 0) + 1;
        emitToMatchRooms(matchRoom, 'queen_covered', { matchId: matchRoom, byRole: shooterRole, seq: match.turnSeq });
        console.log('[SERVER] Queen covered in same shot by', shooterRole);
      } else {
        // queen pocketed and needs cover later, OR foul occurred mid-shot
        if (isDirectFoul) {
          // foul always returns queen
          match.waitingForCover = false;
          match.queenPocketedBy = null;
          match.boardState = (match.boardState || []).filter(c => c.label !== 'queen');
          match.boardState.push({ id: 'queen', label: 'queen', x: 0.5, y: 0.5 });
          match.turnSeq = (match.turnSeq || 0) + 1;
          emitToMatchRooms(matchRoom, 'queen_return', { matchId: matchRoom, seq: match.turnSeq });
          console.log('[SERVER] Queen returned due to foul');
        } else {
          // pocketed queen without cover -> SHOOTER gets immediate extra turn to cover
          match.waitingForCover = true;
          match.queenPocketedBy = shooterPlayerId;
          match.queenPocketedTurnId = Date.now();

          // snapshot + broadcast board so clients render queen gone and waiting state
          match.turnSeq = (match.turnSeq || 0) + 1;
          emitToMatchRooms(matchRoom, 'boardState', { boardState: match.boardState, scores: match.scores, matchId: matchRoom, seq: match.turnSeq });
          emitToMatchRooms(matchRoom, 'queen_pocketed', { matchId: matchRoom, playerId: shooterPlayerId, seq: match.turnSeq });

          // make shooter the next shooter explicitly (extra turn)
          match.previousBoardState = JSON.parse(JSON.stringify(match.boardState || []));
          match.previousScores = JSON.parse(JSON.stringify(match.scores || { white: 0, black: 0 }));
          match.currentShooterPlayerId = shooterPlayerId;

          // Get socket for the shooter
          const sSocket = (match.playerSockets && match.playerSockets[shooterPlayerId]);
          if (sSocket) {
            match.turnSeq = (match.turnSeq || 0) + 1;
            io.to(sSocket).emit('yourTurn', {
              matchId: matchRoom,
              turnSeconds: 15,
              seq: match.turnSeq,
              nextShooterPlayerId: shooterPlayerId
            });
          }

          // start a cover timeout (if not covered within 15s treat as foul)
          if (match.turnTimer) clearTimeout(match.turnTimer);
          match.turnTimer = setTimeout(() => {
            if (!match.waitingForCover || match.queenPocketedBy !== shooterPlayerId) return;
            // timed out on cover => treat as foul by shooter (call processEndTurn)
            processEndTurn(matchRoom, { auto: true, playerId: shooterPlayerId, flags: { directFoul: true } }, null);
          }, 15000);

          // stop further end-turn flow for this shot (we already assigned next shooter)
          match.processing_end_turn = false;
          return;
        }
      }
    } else if (match.waitingForCover) {
      // already waiting for cover from previous turn
      if (!isDirectFoul && pocketed.includes(shooterRole)) {
        match.scores[shooterRole] += 3;
        match.waitingForCover = false;
        match.queenPocketedBy = null;
        match.turnSeq = (match.turnSeq || 0) + 1;
        emitToMatchRooms(matchRoom, 'queen_covered', { matchId: matchRoom, byRole: shooterRole, seq: match.turnSeq });
        console.log('[SERVER] Queen covered by', shooterRole);
      } else {
        // failed to cover or foul
        match.waitingForCover = false;
        match.queenPocketedBy = null;
        match.boardState = (match.boardState || []).filter(c => c.label !== 'queen');
        match.boardState.push({ id: 'queen', label: 'queen', x: 0.5, y: 0.5 });
        match.turnSeq = (match.turnSeq || 0) + 1;
        emitToMatchRooms(matchRoom, 'queen_return', { matchId: matchRoom, seq: match.turnSeq });
        console.log('[SERVER] Queen returned: failed to cover');
      }
    }

    // --- 5) Turn progression ---
    const pocketedAnyCount = pocketed.filter(l => l === 'white' || l === 'black').length;
    const keepTurn = !auto && !isDirectFoul && (pocketedAnyCount > 0 || (queenPocketedNow && coveredThisShot));

    const nextPid = keepTurn ? shooterPlayerId : match.playerIds.find(id => id !== shooterPlayerId);
    match.currentShooterPlayerId = nextPid;

    // --- 6) Broadcast boardState ---
    emitBoardState(match, matchRoom);

    // --- 7) Win Check ---
    if (match.scores.white >= WIN_SCORE || match.scores.black >= WIN_SCORE) {
      const winnerRole = match.scores.white >= WIN_SCORE ? 'white' : 'black';
      emitToMatchRooms(matchRoom, 'gameEnd', { winnerRole, matchId: matchRoom, seq: match.turnSeq });
      endMatchCleanup(matchRoom);
      return true;
    }

    // --- 8) Snapshot for next turn & emit yourTurn ---
    match.previousBoardState = JSON.parse(JSON.stringify(match.boardState));
    match.previousScores = JSON.parse(JSON.stringify(match.scores));

    match.turnSeq = (match.turnSeq || 0) + 1;
    const nextSock = match.playerSockets && match.playerSockets[nextPid];
    if (nextSock) {
      io.to(nextSock).emit('yourTurn', {
        matchId: matchRoom,
        turnSeconds: match.turnSeconds || 15,
        seq: match.turnSeq,
        nextShooterPlayerId: nextPid
      });
    }

    startTurnTimeout(matchRoom, 15000);
    return true;

  } catch (err) {
    console.error('[processEndTurn] error:', err);
    return false;
  } finally {
    match.processing_end_turn = false;
  }
}

async function handleEndTurn(match, payload, socket = null) {
  const matchRoomId = Object.keys(matches).find(k => matches[k] === match);
  if (!matchRoomId) return;
  await processEndTurn(matchRoomId, payload, socket);
}

function endMatchCleanup(matchRoom) {
  const match = matches[matchRoom];
  if (!match) return;

  console.log(`[CLEANUP] match: ${matchRoom}`);
  match.ended = true;
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
      console.log(`[CLEANUP] match: ${matchRoom} deleted path`);
    }
  }, 15000);
}

io.on("connection", (socket) => {
  console.log("[CONNECT]", socket.id);

  socket.on("RECONNECT_TOURNAMENT", async ({ playerId }) => {
    // Find the tournament the player belongs to
    const tournament = await Tournament.findOne({ "players.playerId": playerId });
    if (!tournament) return;

    // Update socketId and connected status atomically
    await Tournament.updateOne(
      { _id: tournament._id, "players.playerId": playerId },
      {
        $set: {
          "players.$.socketId": socket.id,
          "players.$.connected": true,
          "players.$.lastSeen": new Date()
        }
      }
    );

    socket.join(`tournament_${tournament._id}`);

    // Fetch fresh state to return to client
    const updatedT = await Tournament.findById(tournament._id);
    socket.emit("RETURN_TO_LOBBY", updatedT);

    // Refresh any active matches for this player (stable identity support)
    Object.entries(matches).forEach(([mId, m]) => {
      if (m.playerIds && m.playerIds.includes(playerId)) {
        m.playerSockets = m.playerSockets || {};
        m.playerSockets[playerId] = socket.id;
        // update legacy mapping
        if (m.playersWithIds) m.playersWithIds[socket.id] = playerId;

        // Ensure currentShooterSocket is fresh
        if (m.currentShooterPlayerId === playerId) {
          m.currentShooterSocket = socket.id;
          // Re-emit snapshots to help them catch up
          socket.emit('boardState', {
            boardState: m.boardState,
            scores: m.scores,
            matchId: mId,
            seq: m.turnSeq,
            nextShooterPlayerId: m.currentShooterPlayerId
          });
          socket.emit('yourTurn', {
            matchId: mId,
            turnSeconds: 15,
            seq: m.turnSeq,
            nextShooterPlayerId: playerId
          });
        } else {
          socket.emit('boardState', {
            boardState: m.boardState,
            scores: m.scores,
            matchId: mId,
            seq: m.turnSeq,
            nextShooterPlayerId: m.currentShooterPlayerId
          });
        }
        socket.join(mId);
      }
    });

    console.log(`[RECONNECT_TOURNAMENT] ${playerId} socket=${socket.id}`);
  });

  // ── LOBBY ──────────────────────────────────────────────────────
  socket.on("createRoom", ({ roomName }) => {
    if (rooms[roomName]) { socket.emit("roomError", { msg: "Room already exists" }); return; }
    rooms[roomName] = { players: [socket.id], ready: new Set() };
    socket.join(roomName);
    io.to(roomName).emit("roomUpdate", { players: rooms[roomName].players, ready: [] });
    console.log("[CREATE]", roomName, "by", socket.id);
  });

  socket.on("joinRoom", ({ roomName }) => {
    const room = rooms[roomName];
    if (!room) { socket.emit("roomError", { msg: "Room not found" }); return; }
    if (!room.players.includes(socket.id)) room.players.push(socket.id);
    socket.join(roomName);
    io.to(roomName).emit("roomUpdate", { players: room.players, ready: [...room.ready] });
    console.log("[JOIN]", roomName, "by", socket.id);
  });

  socket.on("setReady", ({ roomName, playerId, cancel }) => {
    const room = rooms[roomName];
    if (!room) return;

    if (cancel) {
      room.ready.delete(socket.id);
      if (room.playerIds) delete room.playerIds[socket.id];
    } else {
      room.ready.add(socket.id);
      if (!room.playerIds) room.playerIds = {};
      room.playerIds[socket.id] = playerId;
    }

    io.to(roomName).emit("roomUpdate", { players: room.players, ready: [...room.ready] });

    if (room.ready.size >= 2) {
      const readyArr = [...room.ready];
      const p1 = readyArr[0], p2 = readyArr[1];
      room.ready.clear();

      const flip = Math.random() > 0.5;
      const p1Role = flip ? "white" : "black";
      const p2Role = p1Role === "white" ? "black" : "white";
      const firstShooter = p1Role === "white" ? p1 : p2; // white always starts

      const matchRoom = "match-" + Date.now() + "-" + Math.floor(Math.random() * 9999);
      io.sockets.sockets.get(p1)?.join(matchRoom);
      io.sockets.sockets.get(p2)?.join(matchRoom);

      matches[matchRoom] = {
        players: [p1, p2],
        playerIds: [room.playerIds?.[p1], room.playerIds?.[p2]],
        playerSockets: {
          [room.playerIds?.[p1]]: p1,
          [room.playerIds?.[p2]]: p2
        },
        playersWithIds: { [p1]: room.playerIds?.[p1], [p2]: room.playerIds?.[p2] },
        scores: { white: 0, black: 0 },
        currentShooterPlayerId: (firstShooter === p1 ? room.playerIds?.[p1] : room.playerIds?.[p2]),
        currentShooterSocket: firstShooter,
        roleBySocket: { [p1]: p1Role, [p2]: p2Role },
        roleByPlayer: { [room.playerIds?.[p1]]: p1Role, [room.playerIds?.[p2]]: p2Role },
        boardState: null,
        parentRoom: roomName,
        turnTimer: null,
        timerRef: null,
        spectators: [],
        startTime: Date.now(),
        // Authoritative queen state (server-owned)
        queenPocketedBy: null,
        waitingForCover: false,
        queenPocketedTurnId: null,
        processing: false,
        turnSeq: 0
      };

      // ── SERVER-SIDE MATCH TIMER ──
      matches[matchRoom].intervalRef = setInterval(() => {
        const m = matches[matchRoom];
        if (!m || m.ended) return clearInterval(matches[matchRoom]?.intervalRef);
        const tp = Math.floor((Date.now() - m.startTime) / 1000);
        const tl = Math.max(0, Math.floor(MATCH_DURATION_MS / 1000) - tp);
        // Always broadcast to all in the room (players + spectators) so timers stay in sync
        emitToMatchRooms(matchRoom, "timer_update", { timeLeft: tl, matchId: matchRoom });
      }, 1000);

      const timerRef = setTimeout(() => {
        const m = matches[matchRoom];
        if (!m || m.ended) return;
        console.log(`[MATCH_TIMEOUT] ${matchRoom}  scores w:${m.scores.white} b:${m.scores.black}`);
        let winnerRole = null;
        if (m.scores.white > m.scores.black) winnerRole = "white";
        else if (m.scores.black > m.scores.white) winnerRole = "black";
        // null = draw
        emitToMatchRooms(matchRoom, "gameEnd", { winnerRole, matchId: matchRoom });
        emitToMatchRooms(matchRoom, "match_ended", { matchId: matchRoom });
        m.ended = true;

        // B1 PATCH: 30s grace period
        setTimeout(() => {
          if (matches[matchRoom]) {
            delete matches[matchRoom];
            console.log(`[MATCH_CLEANUP_TIMER] ${matchRoom} removed after grace`);
          }
        }, 30 * 1000);
      }, MATCH_DURATION_MS);

      matches[matchRoom].timerRef = timerRef;

      // Store endTime on the match so clients can compute remaining time on reconnect
      const matchStartTime = matches[matchRoom].startTime;
      const matchEndTime = matchStartTime + MATCH_DURATION_MS;
      matches[matchRoom].endTime = matchEndTime;

      console.log(`[MATCH] ${matchRoom}  ${p1}(${p1Role}) vs ${p2}(${p2Role})  first=${firstShooter}`);

      io.to(p1).emit("matchStart", { matchRoom, opponentId: p2, role: p1Role, turn: firstShooter === p1, matchId: matchRoom, startTime: matchStartTime, endTime: matchEndTime });
      io.to(p2).emit("matchStart", { matchRoom, opponentId: p1, role: p2Role, turn: firstShooter === p2, matchId: matchRoom, startTime: matchStartTime, endTime: matchEndTime });
    }
  });

  // ✅ TOURNAMENT SOCKET HANDLERS
  socket.on('joinTournamentRoom', async ({ tournamentId, playerId }) => {
    const t = await Tournament.findById(tournamentId);
    if (!t) return;

    const player = t.players.find(p => p.playerId === playerId);
    if (!player) return;

    // ✅ Always save socketId when user joins
    await Tournament.updateOne(
      { _id: tournamentId, "players.playerId": playerId },
      {
        $set: {
          "players.$.socketId": socket.id,
          "players.$.connected": true,
          "players.$.lastSeen": new Date()
        }
      }
    );

    // Refresh t after update for the broadcast
    const updatedT = await Tournament.findById(tournamentId);

    socket.join(`tournament_${tournamentId}`);
    io.to(`tournament_${tournamentId}`).emit('tournamentUpdate', updatedT);

    const activeMatchesList = Object.entries(matches)
      .filter(([, m]) => String(m.tournamentId) === String(tournamentId))
      .flatMap(([mId, m]) => m.playerIds.map(pId => ({ playerId: pId, matchId: mId })));
    socket.emit("active_matches", activeMatchesList);

    console.log(`[JOIN_TOURNAMENT] ${playerId} socket=${socket.id}`);
  });

  socket.on('leaveTournamentRoom', async ({ tournamentId, playerId }) => {
    const t = await Tournament.findById(tournamentId);
    if (!t) return;

    const player = (Array.isArray(t.players) ? t.players.find(p => p.playerId === playerId) : null);
    if (player) {
      player.socketId = null; // only remove socket link
      player.ready = false;
    }

    await t.save();

    socket.leave(`tournament_${tournamentId}`);
    io.to(`tournament_${tournamentId}`).emit('tournamentUpdate', t);
  });

  socket.on('cancelTournamentReady', async ({ tournamentId, playerId }) => {
    try {
      const t = await Tournament.findById(tournamentId);
      if (!t) return;
      // set the player's ready flag false in the array
      await Tournament.updateOne(
        { _id: tournamentId, "players.playerId": playerId },
        { $set: { "players.$.ready": false } }
      );
      const fresh = await Tournament.findById(tournamentId);
      io.to(`tournament_${tournamentId}`).emit('tournamentUpdate', fresh);
      socket.emit('cancelledReady', { success: true });
      console.log(`[CANCEL_READY] ${playerId} cancelled searching in ${tournamentId}`);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("tournamentReady", async ({ tournamentId, playerId }) => {
    // ── Step 1: Quick eligibility check ─────────────────────────────
    const check = await Tournament.findById(tournamentId).lean();
    if (!check) return;
    if (check.status !== "live") {
      socket.emit("tournamentError", { msg: "Tournament is not live yet" });
      return;
    }
    const checkPlayer = check.players.find(p => p.playerId === playerId);
    if (!checkPlayer || checkPlayer.lives <= 0) return;

    // ── Step 2: ATOMIC update — only this player's fields, no overwrite ──
    // Using $set with positional $ so other players' ready flags are untouched
    await Tournament.updateOne(
      { _id: tournamentId, "players.playerId": playerId },
      { $set: { "players.$.ready": true, "players.$.socketId": socket.id } }
    );

    // ── Step 3: Re-fetch fresh state AFTER atomic write settled ─────
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return;

    // After re-fetching and updating, emit fresh state to everyone in the tournament room
    io.to(`tournament_${tournamentId}`).emit('tournamentUpdate', tournament);
    // AND also emit to all connected sockets as a fallback
    io.emit('tournamentUpdate', tournament);

    const readyPlayers = tournament.players.filter(p =>
      p.ready === true &&
      p.lives > 0 &&
      p.socketId
    );

    console.log("Ready players:", readyPlayers.map(p => ({
      id: p.playerId,
      socket: p.socketId,
      ready: p.ready
    })));

    console.log(`[TOURNAMENT_READY] ${playerId} ready. Total ready: ${readyPlayers.length}`);

    if (readyPlayers.length < 2) {
      return; // Do nothing
    }

    // ── Step 4: ATOMIC claim — un-ready both players together ───────
    // Only one handler can win this race; the loser gets null back
    const p1 = readyPlayers[0];
    const p2 = readyPlayers[1];

    console.log("Ready players:", readyPlayers.map(p => ({
      id: p.playerId,
      socket: p.socketId,
      ready: p.ready
    })));

    if (!p1.socketId || !p2.socketId) {
      console.log("One of the players missing socketId");
      return;
    }

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
        arrayFilters: [
          { "first.playerId": p1.playerId },
          { "second.playerId": p2.playerId }
        ],
        returnDocument: 'after'
      }
    );

    if (!claimed) {
      // Another concurrent handler already claimed this match — do nothing
      console.log("[TOURNAMENT] Match already claimed by another handler, skipping");
      const fresh = await Tournament.findById(tournamentId);
      if (fresh) io.to(`tournament_${tournamentId}`).emit("tournamentUpdate", fresh);
      return;
    }

    // ── Step 5: Create real match room (identical to normal PvP) ────
    const flip = Math.random() > 0.5;
    const p1Role = flip ? "white" : "black";
    const p2Role = p1Role === "white" ? "black" : "white";
    const firstShooter = p1Role === "white" ? p1.socketId : p2.socketId;

    const matchRoom = "tmatch-" + Date.now() + "-" + Math.floor(Math.random() * 9999);

    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);
    if (!s1 || !s2) {
      console.warn("[TOURNAMENT] A player socket disconnected during match creation");
      // Re-ready whichever player is still connected so they can retry
      if (s1) await Tournament.updateOne({ _id: tournamentId, "players.playerId": p1.playerId }, { $set: { "players.$.ready": false } });
      if (s2) await Tournament.updateOne({ _id: tournamentId, "players.playerId": p2.playerId }, { $set: { "players.$.ready": false } });
      const fresh = await Tournament.findById(tournamentId);
      if (fresh) io.to(`tournament_${tournamentId}`).emit("tournamentUpdate", fresh);
      return;
    }

    s1.join(matchRoom);
    s2.join(matchRoom);

    matches[matchRoom] = {
      players: [p1.socketId, p2.socketId],
      playerIds: [p1.playerId, p2.playerId],
      playerSockets: { // Map playerId -> socketId (stable mapping)
        [p1.playerId]: p1.socketId,
        [p2.playerId]: p2.socketId
      },
      playersWithIds: { [p1.socketId]: p1.playerId, [p2.socketId]: p2.playerId },
      scores: { white: 0, black: 0 },
      // Store current shooter as stable playerId
      currentShooterPlayerId: (firstShooter === p1.socketId ? p1.playerId : p2.playerId),
      currentShooterSocket: firstShooter,
      roleBySocket: { [p1.socketId]: p1Role, [p2.socketId]: p2Role },
      roleByPlayer: { [p1.playerId]: p1Role, [p2.playerId]: p2Role },
      boardState: null,
      parentRoom: null,
      tournamentId: tournamentId,
      timerRef: null,
      turnTimer: null,
      spectators: [],
      startTime: Date.now(),
      // Authoritative queen state (server-owned)
      queenPocketedBy: null,
      waitingForCover: false,
      queenPocketedTurnId: null,
      // Sync Robustness
      processing: false,          // lock to prevent concurrent endTurn runs
      turnSeq: 0                  // strictly incremented each resolved turn
    };

    matches[matchRoom].intervalRef = setInterval(() => {
      const m = matches[matchRoom];
      if (!m || m.ended) return clearInterval(matches[matchRoom]?.intervalRef);
      const tp = Math.floor((Date.now() - m.startTime) / 1000);
      const tl = Math.max(0, Math.floor(MATCH_DURATION_MS / 1000) - tp);
      // Always broadcast to all in the room (players + spectators) so timers stay in sync
      emitToMatchRooms(matchRoom, "timer_update", { timeLeft: tl, matchId: matchRoom });
    }, 1000);

    const timerRef = setTimeout(() => {
      const m = matches[matchRoom];
      if (!m || m.ended) return;
      let winnerRole = null;
      if (m.scores.white > m.scores.black) winnerRole = "white";
      else if (m.scores.black > m.scores.white) winnerRole = "black";
      emitToMatchRooms(matchRoom, "gameEnd", { winnerRole, matchId: matchRoom });
      emitToMatchRooms(matchRoom, "match_ended", { matchId: matchRoom });
      m.ended = true;
      setTimeout(() => { delete matches[matchRoom]; }, 30 * 1000);
    }, MATCH_DURATION_MS);

    matches[matchRoom].timerRef = timerRef;

    // Store endTime so clients can sync timer from server timestamp
    const tMatchStart = matches[matchRoom].startTime;
    const tMatchEnd = tMatchStart + MATCH_DURATION_MS;
    matches[matchRoom].endTime = tMatchEnd;

    console.log(`[TOURNAMENT_MATCH] ${matchRoom}  ${p1.playerId}(${p1Role}) vs ${p2.playerId}(${p2Role})`);

    const matchDataP1 = {
      matchRoom,
      opponentId: p2.socketId,
      opponentPlayerId: p2.playerId,
      role: p1Role,
      turn: firstShooter === p1.socketId,
      tournamentId,
      matchId: matchRoom,
      startTime: tMatchStart,
      endTime: tMatchEnd
    };
    const matchDataP2 = {
      matchRoom,
      opponentId: p1.socketId,
      opponentPlayerId: p1.playerId,
      role: p2Role,
      turn: firstShooter === p2.socketId,
      tournamentId,
      matchId: matchRoom,
      startTime: tMatchStart,
      endTime: tMatchEnd
    };

    io.to(p1.socketId).emit("matchStart", matchDataP1);
    io.to(p1.socketId).emit("tournament_match_found", matchDataP1);

    io.to(p2.socketId).emit("matchStart", matchDataP2);
    io.to(p2.socketId).emit("tournament_match_found", matchDataP2);

    io.to(`tournament_${tournamentId}`).emit("tournamentUpdate", claimed);

    const activeMatchesList = Object.entries(matches)
      .filter(([, m]) => String(m.tournamentId) === String(tournamentId))
      .flatMap(([mId, m]) => m.playerIds.map(pId => ({ playerId: pId, matchId: mId })));
    io.to(`tournament_${tournamentId}`).emit("active_matches", activeMatchesList);
  });


  socket.on('tournamentMatchResult', async ({ tournamentId, matchId, winnerId, loserId }) => {
    const t = await Tournament.findById(tournamentId);
    if (!t) return;

    const wp = (Array.isArray(t.players) ? t.players.find(x => x.playerId === winnerId) : null);
    const lp = (Array.isArray(t.players) ? t.players.find(x => x.playerId === loserId) : null);

    if (wp) wp.wins += 1;
    if (lp) {
      lp.lives -= 1;
      if (lp.lives <= 0) lp.eliminated = true;
    }

    await t.save();
    io.to(`tournament_${tournamentId}`).emit('tournamentUpdate', t);

    const activeMatchesList = Object.entries(matches)
      .filter(([, m]) => String(m.tournamentId) === String(tournamentId))
      .flatMap(([mId, m]) => m.playerIds.map(pId => ({ playerId: pId, matchId: mId })));
    io.to(`tournament_${tournamentId}`).emit("active_matches", activeMatchesList);

    // ✅ Check if tournament should end
    const activePlayers = t.players.filter(p => p.lives > 0 && !p.eliminated);
    if (activePlayers.length <= 1) {
      await endTournament(t);
    }
  });

  async function endTournament(tournament) {
    // Sort by wins then score
    const sorted = [...tournament.players].sort((a, b) => {
      if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
      return (b.score || 0) - (a.score || 0);
    });

    const first = sorted[0];
    const second = sorted[1];
    const third = sorted[2];

    // Award coins to top 3
    if (first) await User.updateOne({ playerId: first.playerId }, { $inc: { coins: 100 } });
    if (second) await User.updateOne({ playerId: second.playerId }, { $inc: { coins: 50 } });
    if (third) await User.updateOne({ playerId: third.playerId }, { $inc: { coins: 50 } });

    await Tournament.updateOne(
      { _id: tournament._id },
      { status: "ended" }
    );

    io.to(`tournament_${tournament._id}`).emit("tournament_ended", {
      first,
      second,
      third
    });

    console.log(`[TOURNAMENT ENDED] ${tournament._id}`);
  }

  // 🔥 Safety Check: Force end if no one alive (Periodic cleanup)
  setInterval(async () => {
    try {
      const liveTournaments = await Tournament.find({ status: "live" });
      for (let tournament of liveTournaments) {
        const alive = tournament.players.filter(p => p.lives > 0 && !p.eliminated);
        if (alive.length === 0) {
          await endTournament(tournament);
        }
      }
    } catch (err) {
      console.error("Cleanup interval error:", err);
    }
  }, 5000);

  // ── LIVE UPDATE (shooter → opponent, with validation) ──────────
  socket.on("liveUpdate", ({ matchRoom, state }) => {
    if (!matchRoom || !state) return;
    const match = matches[matchRoom];
    if (!match) return;
    if (!match.players.includes(socket.id)) return;

    const shooterPlayerId = match.currentShooterPlayerId;
    const senderPlayerId = match.playersWithIds[socket.id];

    if (senderPlayerId !== shooterPlayerId) {
      // B2 PATCH: log rejected updates
      // console.debug(`[LIVE_IGNORED] ${socket.id} not currentShooter ${match.currentShooter}`);
      return;
    }
    if (state.coins) match.boardState = state.coins;
    socket.to(matchRoom).emit("liveUpdate", { state });
    io.to(`match_${matchRoom}`).emit("liveUpdate", { state });
  });



  socket.on("endTurn", async (payload) => {
    const { matchRoom, playerId } = payload;
    const match = matches[matchRoom];
    if (!match) return;

    if (!match.players.includes(socket.id)) return;

    // Authoritative check using playerId
    const currentShooterId = match.currentShooterPlayerId;
    if (playerId !== currentShooterId) {
      console.warn(`[REJECT endTurn] mismatch. sender:${playerId} expected:${currentShooterId}`);
      socket.emit('endTurnRejected', { reason: 'not_current_shooter', expected: currentShooterId, seq: match.turnSeq });
      return;
    }

    const ok = await safeRunMatchOp(match, () => handleEndTurn(match, payload, socket));
    if (!ok) {
      socket.emit('endTurnRejected', { reason: 'processing', seq: match.turnSeq });
    }
  });

  socket.on("requestBoardState", ({ matchRoom }) => {
    const match = matches[matchRoom];
    if (match) {
      // canonical emission to the requester
      const shooterPid = match.currentShooterPlayerId;
      socket.emit('boardState', {
        boardState: match.boardState || [],
        scores: match.scores || { white: 0, black: 0 },
        matchId: matchRoom,
        seq: match.turnSeq,
        nextShooterPlayerId: shooterPid,
        nextShooterRole: match.roleByPlayer ? match.roleByPlayer[shooterPid] : null
      });
    }
  });

  socket.on('requestYourTurn', ({ matchRoom }) => {
    const match = matches[matchRoom];
    if (!match) return;
    const currentShooterPid = match.currentShooterPlayerId;
    const sock = getSocketForPlayer(match, currentShooterPid);
    if (currentShooterPid && sock) {
      io.to(sock).emit('yourTurn', {
        matchId: matchRoom,
        turnSeconds: 15,
        seq: match.turnSeq,
        nextShooterPlayerId: currentShooterPid
      });
    } else if (match.playersWithIds[socket.id] === currentShooterPid) {
      socket.emit('yourTurn', {
        matchId: matchRoom,
        turnSeconds: 15,
        seq: match.turnSeq,
        nextShooterPlayerId: currentShooterPid
      });
    }
  });

  socket.on("flashMsg", ({ matchRoom, msg }) => {
    if (matchRoom) {
      socket.to(matchRoom).emit("flashMsg", { msg });
    }
  });

  socket.on("leave_match", ({ matchId }) => {
    console.log("[LEAVE_MATCH]", socket.id, matchId);
    const match = matches[matchId];
    if (match) {
      const survivorId = match.players.find(id => id !== socket.id);
      const survivorRole = match.roleBySocket ? match.roleBySocket[survivorId] : null;
      if (survivorId) io.to(survivorId).emit("gameEnd", { winnerRole: survivorRole, matchId });
      endMatchCleanup(matchId);
    }
  });

  socket.on("spectate_match", ({ matchId }) => {
    const match = matches[matchId];
    if (!match) { socket.emit('spectate_failed', { matchId, reason: 'not_found' }); return; }

    socket.join(`match_${matchId}`);
    match.spectators = match.spectators || [];
    if (!match.spectators.includes(socket.id)) match.spectators.push(socket.id);

    const timePassed = Math.floor((Date.now() - (match.startTime || Date.now())) / 1000);
    const timeLeftArg = Math.max(0, Math.floor(MATCH_DURATION_MS / 1000) - timePassed);

    socket.emit('spectate_started', {
      matchId,
      boardState: match.boardState || [],
      players: match.players || [],
      currentTurn: match.currentShooterSocket,
      scores: match.scores || { white: 0, black: 0 },
      timeLeft: match.timeLeft || timeLeftArg,
      spectatorCount: match.spectators.length
    });

    io.to(`match_${matchId}`).emit('spectator_count_update', { count: match.spectators.length });
  });

  socket.on("leave_spectate", ({ matchId }) => {
    const match = matches[matchId];
    if (!match) return;
    if (match.spectators && match.spectators.includes(socket.id)) {
      match.spectators = match.spectators.filter(id => id !== socket.id);
      socket.leave(`match_${matchId}`);
      io.to(`match_${matchId}`).emit('spectator_count_update', { count: match.spectators.length });
    }
  });

  socket.on("disconnect", () => {
    try {
      console.log("[DISCONNECT]", socket.id);
      const entry = findMatch(socket.id);
      if (!entry) {
        console.log('[DISCONNECT] socket not in active match:', socket.id);
        // cleanup rooms if any
        for (const [name, room] of Object.entries(rooms)) {
          room.players = (Array.isArray(room.players) ? room.players.filter(id => id !== socket.id) : []);
          if (room.ready) room.ready.delete(socket.id);
          if (room.players.length === 0) delete rooms[name];
        }
        return;
      }

      const { match, matchRoom, playerId, role } = entry;
      console.log('[DISCONNECT] found match for socket:', socket.id, 'matchRoom=', matchRoom, 'playerId=', playerId);

      if (role === 'spectator') {
        // cleanup spectator entry
        match.spectators = (match.spectators || []).filter(id => id !== socket.id);
        io.to(matchRoom).emit('spectator_count_update', { count: match.spectators.length });
        io.to(`match_${matchRoom}`).emit('spectator_count_update', { count: match.spectators.length });
        return;
      }

      // Mark player disconnected
      match.disconnected = socket.id;
      match.disconnectTime = Date.now();
      const opponentId = match.players.find(id => id !== socket.id);
      if (opponentId) io.to(opponentId).emit("opponentReconnecting");

      match.reconnectTimer = setTimeout(() => {
        if (match.disconnected === socket.id) {
          const winnerId = opponentId;
          const winnerRole = match.roleBySocket ? match.roleBySocket[winnerId] : null;
          emitToMatchRooms(matchRoom, "gameEnd", { winnerRole, matchId: matchRoom });
          endMatchCleanup(matchRoom);
        }
      }, 25000);

      // standard room cleanup
      for (const [name, room] of Object.entries(rooms)) {
        room.players = (Array.isArray(room.players) ? room.players.filter(id => id !== socket.id) : []);
        if (room.ready) room.ready.delete(socket.id);
        if (room.players.length === 0) delete rooms[name];
      }
    } catch (err) {
      console.error('[DISCONNECT] handler error', err);
    }
  });

  socket.on("reconnectMatch", ({ playerId }) => {
    const matchRoom = Object.keys(matches).find(k => (matches[k].playerIds || []).includes(playerId));
    if (!matchRoom) return;
    const match = matches[matchRoom];
    match.playerSockets = match.playerSockets || {};
    match.playerSockets[playerId] = socket.id;
    match.players = (match.players || []).map(sid => (match.playerIds.includes(match.playersWithIds[sid]) ? sid : socket.id));
    match.playersWithIds[socket.id] = playerId;
    if (match.currentShooterPlayerId) {
      match.currentShooterSocket = getSocketForPlayer(match, match.currentShooterPlayerId);
    }
    socket.join(matchRoom);
    if (match.reconnectTimer) {
      clearTimeout(match.reconnectTimer); match.reconnectTimer = null;
    }
    socket.emit('boardState', {
      boardState: match.boardState || [],
      scores: match.scores || { white: 0, black: 0 },
      matchId: matchRoom,
      seq: match.turnSeq,
      nextShooterPlayerId: match.currentShooterPlayerId,
      nextShooterRole: match.roleByPlayer ? match.roleByPlayer[match.currentShooterPlayerId] : null
    });
    if (match.currentShooterPlayerId === playerId) {
      socket.emit('yourTurn', {
        matchId: matchRoom,
        turnSeconds: 15,
        seq: match.turnSeq,
        nextShooterPlayerId: playerId
      });
      startTurnTimeout(matchRoom, 15000);
    }
  });

  socket.on("redeemCode", async ({ playerId, code }) => {
    try {
      if (!playerId || !code) return;
      const redeem = await RedeemCode.findOne({ code: code.trim() });
      if (!redeem) {
        socket.emit("redeemResult", { success: false, message: "Invalid Code" });
        return;
      }
      if (redeem.used) {
        socket.emit("redeemResult", { success: false, message: "Code Already Used" });
        return;
      }
      const user = await User.findOne({ playerId });
      if (!user) {
        socket.emit("redeemResult", { success: false, message: "User Not Found" });
        return;
      }
      user.coins += redeem.coins;
      await user.save();
      redeem.used = true;
      redeem.usedBy = playerId;
      await redeem.save();
      socket.emit("redeemResult", { success: true, message: `+${redeem.coins} Coins Added`, newBalance: user.coins });
    } catch (err) { console.log(err); }
  });
});

app.get("/check-auth", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ✅ STEP 2 — REGISTER ROUTE
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.json({ success: false, message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      playerId: "CR" + Math.floor(100000 + Math.random() * 900000),
      name,
      email,
      password: hashedPassword
    });

    await newUser.save();

    // Store in session
    req.session.user = newUser;
    res.json({ success: true, user: newUser });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ STEP 3 — LOGIN ROUTE
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: "Wrong password" });
    }

    // Store in session
    req.session.user = user;
    res.json({ success: true, user });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Legacy redeem routes removed

// ── GET USER (STEP 6) ─────────────────────────
app.get("/user/:playerId", async (req, res) => {
  const user = await User.findOne({ playerId: req.params.playerId });
  res.json(user);
});

// ── CREATE USER TEST ROUTE ─────────────────────────
app.post("/create-user", async (req, res) => {
  const { name } = req.body;

  const newUser = new User({
    playerId: "CR" + Math.floor(100000 + Math.random() * 900000),
    name,
    wins: 0,
    lives: 3,
    winStreak: 0
  });

  await newUser.save();

  res.json({
    message: "User created successfully",
    user: newUser
  });
});

// ── GET USER BY PLAYER ID ─────────────────────────
app.get("/get-user/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;

    const user = await User.findOne({ playerId });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(user);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});
// ✅ TOURNAMENT SCHEDULE HELPERS
function scheduleTournamentTimers(tournamentId) {
  Tournament.findById(tournamentId).then(t => {
    if (!t) return;

    const now = Date.now();
    const startDelay = new Date(t.startTime).getTime() - now;
    const endDelay = new Date(t.endTime).getTime() - now;

    if (startDelay > 0) {
      setTimeout(() => startTournament(tournamentId), startDelay);
    } else {
      startTournament(tournamentId);
    }

    if (endDelay > 0) {
      setTimeout(() => endTournament(tournamentId), endDelay);
    }
  });
}

async function startTournament(tournamentId) {
  const t = await Tournament.findById(tournamentId);
  if (!t) return;

  if (t.status !== "waiting") return;

  t.status = "live";
  await t.save();

  io.to(`tournament_${t._id}`).emit("tournamentStarted", t);
}

// ✅ NEW USER-SPEC ROUTES


function checkTournamentStatus(tournament) {
  const now = new Date();
  const start = new Date(tournament.startTime);
  const end = new Date(tournament.endTime);

  if (now >= start && now <= end) {
    tournament.status = 'live';
  }

  if (now > end) {
    tournament.status = 'ended';
  }
}

app.get("/get-tournaments", async (req, res) => {
  try {
    const tournaments = await Tournament.find({});

    for (let t of tournaments) {
      checkTournamentStatus(t);
      await t.save();
    }

    const active = tournaments.filter(t => t.status !== "ended");

    res.json({
      success: true,
      tournaments: active
    });

  } catch (err) {
    console.log(err);
    res.json({ success: false });
  }
});

app.get("/my-tournament/:playerId", async (req, res) => {
  const { playerId } = req.params;

  const tournament = await Tournament.findOne({
    "players.playerId": playerId,
    status: { $ne: "ended" }
  });

  if (!tournament) {
    return res.json({ success: false });
  }

  res.json({
    success: true,
    tournament
  });
});



app.post("/match-result", async (req, res) => {
  const { tournamentId, winnerId, loserId } = req.body;

  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) return res.json({ success: false });

  const winner = (Array.isArray(tournament.players) ? tournament.players.find(p => p.playerId === winnerId) : null);
  const loser = (Array.isArray(tournament.players) ? tournament.players.find(p => p.playerId === loserId) : null);

  if (winner) {
    winner.score += 10;
    winner.wins += 1;
    winner.ready = false;
  }
  if (loser) {
    loser.lives -= 1;
    loser.ready = false;
    if (loser.lives <= 0) loser.eliminated = true;
  }

  await tournament.save();
  io.to(`tournament_${tournament._id}`).emit('tournamentUpdate', tournament);

  // Emit individual player updates for lobby/profile sync
  const winUser = await User.findOne({ playerId: winnerId });
  if (winUser) {
    // Find the socket if possible, or broadcast if not cached (server-side socket-to-player map needed for targeted emit)
    // For now, let's assume global listeners will catch relevant tournamentUpdate, 
    // but the instruction specifically asked for playerUpdate.
    io.emit('playerUpdate', { playerId: winnerId, coins: winUser.coins, wins: winUser.wins });
  }
  const loseUser = await User.findOne({ playerId: loserId });
  if (loseUser) {
    io.emit('playerUpdate', { playerId: loserId, coins: loseUser.coins, wins: loseUser.wins });
  }

  res.json({ success: true });
});



app.post("/ready", async (req, res) => {
  const { tournamentId, playerId } = req.body;
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) return res.json({ success: false });

  const player = (Array.isArray(tournament.players) ? tournament.players.find(p => p.playerId === playerId) : null);
  if (player) {
    player.ready = true;
    await tournament.save();

    const match = (Array.isArray(tournament.players) ? tournament.players.filter(p => p.ready === true && p.lives > 0) : []).slice(0, 2);
    if (match.length >= 2) {
      // In a real app we'd emit a socket event here, 
      // but following user's snippet logic for now which returns match in res.
      return res.json({ success: true, matchPlayers: match });
    }
    io.to(`tournament_${tournament._id}`).emit('tournamentUpdate', tournament);
  }

  res.json({ success: true });
});

async function rewardWinners(tournamentId) {
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) return;

  const sorted = (Array.isArray(tournament.players) ? [...tournament.players].sort((a, b) => (b.score || 0) - (a.score || 0)) : []);

  if (sorted[0]) {
    const first = await User.findOne({ playerId: sorted[0].playerId });
    if (first) {
      first.points += 100;
      await first.save();
    }
  }

  if (sorted[1]) {
    const second = await User.findOne({ playerId: sorted[1].playerId });
    if (second) {
      second.coins += 50;
      await second.save();
    }
  }

  if (sorted[2]) {
    const third = await User.findOne({ playerId: sorted[2].playerId });
    if (third) {
      third.coins += 50;
      await third.save();
    }
  }
}

// Update existing endTournament to use rewardWinners
async function endTournament(tournamentId) {
  const t = await Tournament.findById(tournamentId);
  if (!t) return;

  if (t.status === "ended") return;

  t.status = "ended";

  const sorted = (Array.isArray(t.players) ? [...t.players].sort((a, b) => (b.score || 0) - (a.score || 0)) : []);

  if (sorted[0]) {
    const user = await User.findOne({ playerId: sorted[0].playerId });
    if (user) {
      user.points += 100;
      await user.save();
    }
  }

  if (sorted[1]) {
    const user = await User.findOne({ playerId: sorted[1].playerId });
    if (user) {
      user.coins += 50;
      await user.save();
    }
  }

  if (sorted[2]) {
    const user = await User.findOne({ playerId: sorted[2].playerId });
    if (user) {
      user.coins += 50;
      await user.save();
    }
  }

  await t.save();

  io.to(`tournament_${t._id}`).emit("tournamentEnded", t);
}

// ✅ TOURNAMENT REST API
// ✅ FIX CREATE TOURNAMENT ROUTE (VERY IMPORTANT)
app.post("/create-tournament", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Login required" });
    const { name, capacity, startTime, endTime } = req.body;
    const playerId = req.session.user.playerId;

    const user = await User.findOne({ playerId });
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    if (user.coins < 300) {
      return res.json({ success: false, message: "Not enough coins" });
    }

    // ✅ deduct 300 coins for creating
    user.coins -= 300;
    await user.save();

    const newTournament = new Tournament({
      name,
      creatorId: playerId,
      capacity,
      startTime,
      endTime,
      prizePool: 300
    });

    await newTournament.save();

    scheduleTournamentTimers(newTournament._id);

    res.json({
      success: true,
      tournament: newTournament,
      coins: user.coins
    });

  } catch (err) {
    console.log(err);
    res.json({ success: false });
  }
});

// ✅ FIX JOIN TOURNAMENT ROUTE
app.post("/join-tournament", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Login required" });
    const { tournamentId } = req.body;
    const { playerId, name } = req.session.user;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.json({ success: false });

    if (tournament.status !== "waiting")
      return res.json({ success: false, message: "Tournament already started" });

    const user = await User.findOne({ playerId });
    if (!user) return res.json({ success: false });

    if (user.coins < 100)
      return res.json({ success: false, message: "Not enough coins" });

    if (Array.isArray(tournament.players) && tournament.players.find(p => p.playerId === playerId))
      return res.json({ success: false, message: "Already joined" });

    // ✅ deduct 100 entry
    user.coins -= 100;
    await user.save();

    tournament.players.push({
      playerId,
      name,
      lives: 3,
      wins: 0,
      score: 0,
      ready: false,
      eliminated: false
    });

    tournament.prizePool += 100;
    await tournament.save();

    res.json({
      success: true,
      coins: user.coins,
      tournament
    });

  } catch (err) {
    console.log(err);
    res.json({ success: false });
  }
});

// Get tournament details
app.post("/redeem-code", async (req, res) => {
  try {
    const { playerId, code } = req.body;

    if (!playerId || !code) {
      return res.json({ success: false, message: "Missing playerId or code" });
    }

    const user = await User.findOne({ playerId });
    if (!user) {
      return res.json({ success: false, message: "User not found" });
    }

    const redeem = await RedeemCode.findOne({ code: code.trim() });
    if (!redeem) {
      return res.json({ success: false, message: "Invalid code" });
    }

    if (redeem.used) {
      return res.json({ success: false, message: "Code already used" });
    }

    user.coins += redeem.coins;
    await user.save();

    redeem.used = true;
    redeem.usedBy = playerId;
    await redeem.save();

    res.json({ success: true, coins: user.coins, message: `+${redeem.coins} Coins Added` });

  } catch (err) {
    console.log(err);
    res.json({ success: false });
  }
});

app.get('/tournament/:id', async (req, res) => {
  try {
    const t = await Tournament.findById(req.params.id);
    if (!t) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, tournament: t });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// List waiting tournaments
app.get('/tournaments/waiting', async (req, res) => {
  try {
    const tournaments = await Tournament.find({ status: 'waiting' });
    res.json(tournaments);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
