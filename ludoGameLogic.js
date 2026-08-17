class GameLogic {
    constructor() {
        this.players = [];
        this.turnIndex = 0;
        this.diceValue = 0;
        this.diceRolled = false;
        this.consecutiveSixes = 0;
        this.safeSquares = [0, 8, 13, 21, 26, 34, 39, 47];
        this.colors = ['RED', 'GREEN', 'YELLOW', 'BLUE'];

        // Start offsets on the shared 52-step outer track
        this.startOffsets = { RED: 0, GREEN: 13, YELLOW: 26, BLUE: 39 };

        // A token's `position` is always relative to its own player:
        //   0-50  -> outer track (51 squares — see note below)
        //   51-55 -> home column (5 squares)
        //   56    -> arrived home
        //
        // Why 51 and not 52: the shared track has 52 physical squares,
        // but each color only ever travels 51 of them before turning
        // into its own home column — the 52nd (the square immediately
        // before that color's own entry square) is never reached by
        // that color, since it diverts home first. The doorway into a
        // color's home lane is only orthogonally adjacent to the track
        // square at *their* relative position 50 — using 51 here (one
        // square later) meant every color's token visually jumped
        // diagonally into its home lane instead of stepping into it.
    }

    // ── SEATS ──────────────────────────────────────────────────────────
    // Seats are permanent for the life of a match — a color slot never
    // disappears once the match starts. `isAI` just toggles who's
    // driving it. This is what makes mid-game sit-in and AI-takeover-on-
    // disconnect possible: there's always a full set of players, some
    // human, some bot, and control can move between the two without
    // touching turn order, tokens, or board state at all.
    initGame(humanData, maxPlayers) {
        const seatCount = Math.max(2, Math.min(4, maxPlayers || humanData.length || 4));
        this.players = [];
        for (let i = 0; i < seatCount; i++) {
            const color = this.colors[i];
            const human = humanData[i];
            this.players.push({
                id: human ? human.id : `ai_${color}`,
                clientId: human ? human.clientId : null,
                name: human ? human.name : `Bot (${color})`,
                username: human ? (human.username || null) : null,
                color,
                isAI: !human,
                connected: true,
                tokens: [
                    { id: 0, state: 'BASE', position: -1 },
                    { id: 1, state: 'BASE', position: -1 },
                    { id: 2, state: 'BASE', position: -1 },
                    { id: 3, state: 'BASE', position: -1 }
                ]
            });
        }
        this.turnIndex = 0;
        this.diceValue = 0;
        this.diceRolled = false;
        this.consecutiveSixes = 0;
    }

    getPlayerById(playerId) {
        return this.players.find(p => p.id === playerId);
    }

    getCurrentPlayer() {
        return this.players[this.turnIndex];
    }

    // --- Seat control handoff ---------------------------------------------

    setConnected(playerId, connected) {
        const player = this.getPlayerById(playerId);
        if (player) player.connected = connected;
    }

    // Swap a player's live socket id (used on reconnect within the grace
    // window) without touching their board state at all.
    reassignId(oldId, newId) {
        const player = this.getPlayerById(oldId);
        if (!player) return false;
        player.id = newId;
        player.connected = true;
        return true;
    }

    // A human seat goes AI-controlled — used both when they disconnect
    // (after the takeover grace period) and when they explicitly leave.
    // Tokens/position are untouched; the seat just keeps playing.
    // `forgetOwner` clears clientId too, opening the seat for ANYONE to
    // sit into later (explicit leave); otherwise the clientId is kept so
    // the same person can reclaim their seat on reconnect even after AI
    // has taken over it for a while.
    convertToAI(playerId, forgetOwner) {
        const player = this.getPlayerById(playerId);
        if (!player || player.isAI) return null;
        const color = player.color;
        player.isAI = true;
        player.id = `ai_${color}`;
        player.name = `Bot (${color})`;
        if (forgetOwner) { player.clientId = null; player.username = null; }
        player.connected = true;
        return color;
    }

    // A human sits into whichever AI seat is offered (first available,
    // unless a specific color is requested). Tokens/position untouched —
    // they're simply taking the wheel on an already-in-progress seat.
    sitIn(humanData, preferredColor) {
        const seat = preferredColor
            ? this.players.find(p => p.isAI && p.color === preferredColor)
            : this.players.find(p => p.isAI);
        if (!seat) return null;
        seat.isAI = false;
        seat.id = humanData.id;
        seat.clientId = humanData.clientId;
        seat.name = humanData.name;
        seat.username = humanData.username || null;
        seat.connected = true;
        return seat.color;
    }

    // Does this clientId already control a seat (human or was, before AI
    // took over) — used to let a reconnecting player reclaim their exact
    // seat instead of being treated as a brand new sit-in.
    findSeatByClientId(clientId) {
        return this.players.find(p => p.clientId === clientId);
    }

    // After the long reconnect-grace window fully expires with no
    // reconnect, the seat stops being reserved for that person and
    // becomes sit-in-able by anyone.
    forgetSeatOwnerByClientId(clientId) {
        const seat = this.players.find(p => p.isAI && p.clientId === clientId);
        if (seat) { seat.clientId = null; seat.username = null; }
    }

    hasAnyHumanSeat() {
        return this.players.some(p => !p.isAI);
    }

    // --- Turn / dice -----------------------------------------------------

    rollDice(playerId) {
        const current = this.getCurrentPlayer();
        if (!current || current.id !== playerId || this.diceRolled) return { success: false };

        this.diceValue = Math.floor(Math.random() * 6) + 1;
        this.diceRolled = true;

        if (this.diceValue === 6) {
            this.consecutiveSixes++;
            if (this.consecutiveSixes === 3) {
                // Three sixes in a row forfeits the turn entirely.
                this.consecutiveSixes = 0;
                this.diceRolled = false;
                this.diceValue = 0;
                return { success: true, value: 6, skip: true };
            }
        } else {
            this.consecutiveSixes = 0;
        }

        return { success: true, value: this.diceValue };
    }

    hasValidMoves() {
        const player = this.getCurrentPlayer();
        if (!player) return false;
        return player.tokens.some((_, idx) => this.isValidMove(player, idx, this.diceValue));
    }

    isValidMove(player, tokenIndex, roll) {
        const token = player.tokens[tokenIndex];
        if (!token || token.state === 'HOME') return false;
        if (token.state === 'BASE') return roll === 6;

        if (token.state === 'ACTIVE') {
            const currentPos = token.position;
            if (currentPos >= 51) { // in home column, needs an exact count to finish
                return currentPos + roll <= 56;
            }
            return true;
        }
        return false;
    }

    moveToken(playerId, tokenIndex) {
        const player = this.getCurrentPlayer();
        if (!player || player.id !== playerId || !this.diceRolled) return { success: false };

        if (typeof tokenIndex !== 'number' || tokenIndex < 0 || tokenIndex >= player.tokens.length) {
            return { success: false };
        }

        const token = player.tokens[tokenIndex];
        if (!this.isValidMove(player, tokenIndex, this.diceValue)) return { success: false };

        const path = [];
        const captured = [];
        let isHome = false;
        let extraTurn = this.diceValue === 6;

        if (token.state === 'BASE') {
            token.state = 'ACTIVE';
            token.position = 0;
            path.push({ state: 'ACTIVE', position: 0 });
        } else {
            for (let i = 1; i <= this.diceValue; i++) {
                token.position++;
                path.push({ state: 'ACTIVE', position: token.position });
            }
            if (token.position === 56) {
                token.state = 'HOME';
                isHome = true;
                extraTurn = true; // bonus turn for getting a token all the way home
            }
        }

        if (token.state === 'ACTIVE') {
            const globalPos = this.getGlobalPosition(player.color, token.position);

            if (globalPos !== -1 && !this.safeSquares.includes(globalPos)) {
                this.players.forEach(p => {
                    if (p.id === player.id) return;
                    p.tokens.forEach(t => {
                        if (t.state === 'ACTIVE' && this.getGlobalPosition(p.color, t.position) === globalPos) {
                            t.state = 'BASE';
                            t.position = -1;
                            captured.push({ playerId: p.id, tokenId: t.id });
                        }
                    });
                });
                if (captured.length > 0) extraTurn = true;
            }
        }

        this.diceRolled = false;
        this.diceValue = 0;
        if (!extraTurn) this.consecutiveSixes = 0;

        return { success: true, path, captured, isHome, extraTurn };
    }

    getGlobalPosition(color, relativePos) {
        if (relativePos < 0 || relativePos > 50) return -1;
        const offset = this.startOffsets[color];
        return (relativePos + offset) % 52;
    }

    nextTurn() {
        this.turnIndex = (this.turnIndex + 1) % this.players.length;
        this.diceRolled = false;
        this.diceValue = 0;
        this.consecutiveSixes = 0;
        // No skip-logic needed any more — every seat is always playable
        // (AI or human), so there's never a "gone" player to skip past.
    }

    checkWin(playerId) {
        const player = this.getPlayerById(playerId);
        if (!player) return false;
        return player.tokens.every(t => t.state === 'HOME');
    }

    getState() {
        return {
            players: this.players,
            turnIndex: this.turnIndex,
            activePlayerId: this.getCurrentPlayer()?.id,
            diceValue: this.diceValue,
            diceRolled: this.diceRolled
        };
    }
}
module.exports = GameLogic;
