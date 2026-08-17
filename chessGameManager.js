const { ChessLogic } = require('./chessLogic');
const { chooseMove } = require('./chessAI');

// Set by chessRoomManager.js — called once per finished match so PHP
// can pull it via the same /internal/rooms/live-status mechanism the
// 29 game and Ludo already use.
let matchOverHandler = null;
function setMatchOverHandler(fn) { matchOverHandler = fn; }

const AI_MOVE_DELAY_MS = 900; // purely cosmetic — the AI "thinks" briefly so it doesn't feel instant
const AI_SEARCH_DEPTH = 3;

class ChessGameManager {
    constructor(roomId, io) {
        this.roomId = roomId;
        this.io = io;
        this.logic = new ChessLogic();
        this.players = []; // [{ id, clientId, name, username, color, isAI, connected }]
        this.aiActionPending = false;
    }

    startGame(players) {
        // players[0] is always the host/white, players[1] (human or AI
        // filler) is black. Must iterate over the fixed 2-color list,
        // NOT players.map() — startGame is normally called with just
        // ONE human (the host) and relies on this to fill the second
        // seat with AI; mapping over the input array alone would only
        // ever produce as many seats as humans were actually passed.
        const colors = ['w', 'b'];
        this.players = colors.map((color, i) => {
            const p = players[i];
            return {
                id: p ? p.id : `ai_${color}`,
                clientId: p ? p.clientId : null,
                name: p ? p.name : `Bot (${color === 'w' ? 'White' : 'Black'})`,
                username: p ? (p.username || null) : null,
                color,
                isAI: !p,
                connected: true,
            };
        });
        this.broadcastState();
    }

    getPlayerById(playerId) { return this.players.find(p => p.id === playerId); }
    getPlayerByColor(color) { return this.players.find(p => p.color === color); }

    move(playerId, from, to, promotion) {
        const player = this.getPlayerById(playerId);
        if (!player) return;
        const result = this.logic.move(player.color, from, to, promotion);
        if (!result.success) {
            // Never fail silently — see the equivalent fix in Ludo's
            // manager for why (a stale client with zero feedback looks
            // exactly like a frozen game).
            this.io.to(playerId).emit('gameState', this.buildStatePayload());
            this.io.to(playerId).emit('error', result.error);
            return;
        }

        this.io.to(this.roomId).emit('chessMove', { move: result.move, byColor: player.color });
        this.io.to(this.roomId).emit('playSound', result.move.capture ? 'capture' : 'move');

        if (result.status === 'checkmate') {
            this.io.to(this.roomId).emit('playSound', 'victory');
            this.broadcastState();
            const winnerPlayer = this.getPlayerByColor(result.winner);
            if (matchOverHandler && winnerPlayer) matchOverHandler(this.roomId, this, winnerPlayer.id);
        } else if (result.status === 'stalemate' || result.status === 'draw') {
            this.broadcastState();
            if (matchOverHandler) matchOverHandler(this.roomId, this, null); // draw — no winner to credit
        } else {
            this.broadcastState();
        }
    }

    // ── Seat control handoff (same model as Ludo) ───────────────────
    setConnected(playerId, connected) {
        const p = this.getPlayerById(playerId);
        if (p) p.connected = connected;
    }

    reassignId(oldId, newId) {
        const p = this.getPlayerById(oldId);
        if (!p) return false;
        p.id = newId;
        p.connected = true;
        return true;
    }

    convertToAI(playerId, forgetOwner) {
        const p = this.getPlayerById(playerId);
        if (!p || p.isAI) return null;
        const color = p.color;
        p.isAI = true;
        p.id = `ai_${color}`;
        p.name = `Bot (${color === 'w' ? 'White' : 'Black'})`;
        if (forgetOwner) { p.clientId = null; p.username = null; }
        p.connected = true;
        this.broadcastState();
        return color;
    }

    sitIn(humanData) {
        const seat = this.players.find(p => p.isAI);
        if (!seat) return null;
        seat.isAI = false;
        seat.id = humanData.id;
        seat.clientId = humanData.clientId;
        seat.name = humanData.name;
        seat.username = humanData.username || null;
        seat.connected = true;
        this.broadcastState();
        return seat.color;
    }

    findSeatByClientId(clientId) { return this.players.find(p => p.clientId === clientId); }
    hasAnyHumanSeat() { return this.players.some(p => !p.isAI); }

    buildStatePayload() {
        const state = this.logic.getState();
        return { ...state, players: this.players };
    }

    broadcastState() {
        this.io.to(this.roomId).emit('gameState', this.buildStatePayload());
        this.maybeRunAI();
    }

    getState() { return this.buildStatePayload(); }

    // ── AI driving loop ───────────────────────────────────────────
    maybeRunAI() {
        if (this.aiActionPending) return;
        if (this.logic.status !== 'ongoing') return;
        const current = this.getPlayerByColor(this.logic.turn);
        if (!current || !current.isAI) return;

        this.aiActionPending = true;
        setTimeout(() => {
            this.aiActionPending = false;
            try {
                if (this.logic.status !== 'ongoing') return;
                const stillCurrent = this.getPlayerByColor(this.logic.turn);
                if (!stillCurrent || stillCurrent.id !== current.id || !stillCurrent.isAI) return;
                const chosen = chooseMove(this.logic, this.logic, this.logic.turn, AI_SEARCH_DEPTH);
                if (chosen) {
                    this.move(current.id, chosen.from, chosen.to, chosen.promotion);
                }
                // If chosen is null, generateLegalMoves already found no
                // moves — refreshStatus() inside the prior move() call
                // would have already flagged checkmate/stalemate, so
                // there's nothing to force here (unlike Ludo, there's no
                // "turn" to hand off in a 2-player finished chess game).
            } catch (err) {
                // Contain a bug to this one room — see the process-level
                // safety net in server.js for the last-resort backstop.
                console.error(`[chess:${this.roomId}] AI move failed:`, err);
            }
        }, AI_MOVE_DELAY_MS);
    }
}

module.exports = ChessGameManager;
module.exports.setMatchOverHandler = setMatchOverHandler;
