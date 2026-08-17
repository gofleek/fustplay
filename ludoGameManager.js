const GameLogic = require('./ludoGameLogic');
const { chooseTokenToMove } = require('./ludoAI');

// Set by ludoRoomManager.js — called once per finished match so PHP can
// pull it via the same /internal/rooms/live-status mechanism the 29 game
// already uses (see reportMatchResult() below).
let matchOverHandler = null;
function setMatchOverHandler(fn) { matchOverHandler = fn; }

// How long an AI seat "thinks" before acting — purely cosmetic, so the
// board doesn't flicker faster than a human could follow.
const AI_ROLL_DELAY_MS = 1100;
const AI_MOVE_DELAY_MS = 900;

class LudoGameManager {
    constructor(roomId, io) {
        this.roomId = roomId;
        this.io = io;
        this.logic = new GameLogic();
        this.aiActionPending = false;
    }

    startGame(humanPlayers, maxPlayers) {
        this.logic.initGame(humanPlayers, maxPlayers);
        this.broadcastState();
    }

    rollDice(playerId) {
        const result = this.logic.rollDice(playerId);
        if (!result.success) {
            // A rejected roll used to just silently do nothing — if the
            // requesting client's local state was stale for any reason
            // (e.g. a missed broadcast), they'd be stuck seeing a
            // clickable dice that does nothing, forever, with zero
            // feedback. Push them the authoritative state so they
            // self-correct instead of needing a manual reload.
            this.io.to(playerId).emit('gameState', this.logic.getState());
            return;
        }

        this.io.to(this.roomId).emit('diceRolled', {
            value: result.value,
            playerId,
            animate: true
        });

        if (result.skip) {
            setTimeout(() => {
                this.logic.nextTurn();
                this.broadcastState();
            }, 1500);
            return;
        }

        if (!this.logic.hasValidMoves()) {
            setTimeout(() => {
                this.logic.nextTurn();
                this.broadcastState();
            }, 1200);
        } else {
            setTimeout(() => this.broadcastState(), 800);
        }
    }

    moveToken(playerId, tokenIndex) {
        const result = this.logic.moveToken(playerId, tokenIndex);
        if (!result.success) {
            // Same reasoning as rollDice() above — a rejected move must
            // never be a silent dead end. Resync the requester instead
            // of leaving their dice/tokens looking clickable-but-dead.
            this.io.to(playerId).emit('gameState', this.logic.getState());
            return;
        }

        this.io.to(this.roomId).emit('tokenMoved', {
            playerId,
            tokenIndex,
            path: result.path,
            captured: result.captured
        });

        if (result.captured.length > 0) {
            this.io.to(this.roomId).emit('playSound', 'capture');
        } else if (result.isHome) {
            this.io.to(this.roomId).emit('playSound', 'victory');
        } else {
            this.io.to(this.roomId).emit('playSound', 'move');
        }

        setTimeout(() => {
            if (this.logic.checkWin(playerId)) {
                this.io.to(this.roomId).emit('gameOver', { winner: playerId });
                if (matchOverHandler) matchOverHandler(this.roomId, this.logic, playerId);
            } else {
                if (!result.extraTurn) {
                    this.logic.nextTurn();
                }
                this.broadcastState();
            }
        }, result.path.length * 200 + 400);
    }

    // ── Seat control handoff — game state (tokens/turn order) never
    //    changes here, only who's driving a given seat. ─────────────────

    setConnected(playerId, connected) {
        this.logic.setConnected(playerId, connected);
    }

    reassignId(oldId, newId) {
        return this.logic.reassignId(oldId, newId);
    }

    // Called after the disconnect grace period expires with no reconnect,
    // or immediately on an explicit "Leave".
    convertToAI(playerId, forgetOwner) {
        const color = this.logic.convertToAI(playerId, forgetOwner);
        if (color) this.broadcastState(); // also kicks off maybeRunAI() if it's this seat's turn
        return color;
    }

    // A human takes over an AI seat mid-game (or reclaims their own seat
    // by clientId, handled by the caller before this is invoked).
    sitIn(humanData, preferredColor) {
        const color = this.logic.sitIn(humanData, preferredColor);
        if (color) this.broadcastState();
        return color;
    }

    broadcastState() {
        this.io.to(this.roomId).emit('gameState', this.logic.getState());
        this.maybeRunAI();
    }

    getState() {
        return this.logic.getState();
    }

    // ── AI driving loop — checked after every state-settle point. ───────
    maybeRunAI() {
        if (this.aiActionPending) return;
        const current = this.logic.getCurrentPlayer();
        if (!current || !current.isAI) return;

        this.aiActionPending = true;
        if (!this.logic.diceRolled) {
            setTimeout(() => {
                this.aiActionPending = false;
                try {
                    // Re-check: the seat may have been sat into by a
                    // human, or the match may have ended, while this
                    // was pending.
                    const stillCurrent = this.logic.getCurrentPlayer();
                    if (stillCurrent && stillCurrent.id === current.id && stillCurrent.isAI) {
                        this.rollDice(current.id);
                    }
                } catch (err) {
                    // A bug here must never take down every other room
                    // on the server (see the process-level note in
                    // server.js) — contain it to this one match instead.
                    console.error(`[ludo:${this.roomId}] AI roll step failed:`, err);
                }
            }, AI_ROLL_DELAY_MS);
        } else {
            setTimeout(() => {
                this.aiActionPending = false;
                try {
                    const stillCurrent = this.logic.getCurrentPlayer();
                    if (stillCurrent && stillCurrent.id === current.id && stillCurrent.isAI && this.logic.diceRolled) {
                        const idx = chooseTokenToMove(stillCurrent, this.logic.diceValue, this.logic);
                        if (idx !== -1) {
                            this.moveToken(current.id, idx);
                        } else {
                            // Shouldn't happen — the server only reaches
                            // this "waiting for a move" state because it
                            // already confirmed a valid move exists. But
                            // if the AI heuristic ever disagrees for any
                            // reason, this is exactly the kind of silent
                            // dead end that used to freeze the match for
                            // everyone until someone reloaded. Force the
                            // turn forward instead of trusting that can
                            // never happen.
                            this.logic.nextTurn();
                            this.broadcastState();
                        }
                    }
                } catch (err) {
                    console.error(`[ludo:${this.roomId}] AI move step failed:`, err);
                    // Best-effort recovery: try to keep the match moving
                    // rather than leaving it stuck on this AI's turn.
                    try { this.logic.nextTurn(); this.broadcastState(); } catch (e2) { /* out of options — process-level handler is the final backstop */ }
                }
            }, AI_MOVE_DELAY_MS);
        }
    }
}

module.exports = LudoGameManager;
module.exports.setMatchOverHandler = setMatchOverHandler;
