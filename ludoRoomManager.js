/**
 * ludoRoomManager.js — Ludo's lobby/room layer, mounted on the SAME
 * Render Node process as the 29 card game engine (see server.js).
 *
 * Rooms start playing IMMEDIATELY on creation: the host picks how many
 * seats the match has (2-4), and every seat besides theirs is filled
 * with an AI bot right away — no waiting in a lobby for other humans.
 * A person browsing the open-room list can sit into any AI seat at any
 * point mid-match (paying the same sit-cost a fresh join would), and if
 * a human disconnects or leaves, AI takes their seat over so the match
 * always finishes. See ludoGameLogic.js for the seat-control model this
 * all rests on (seats are permanent; only who's driving one changes).
 *
 * Two things ARE shared with the 29 game and PHP, per the integration
 * requirements:
 *   - IDENTITY: every action requires a signed `engineToken` from PHP's
 *     /api/auth/engine-token.php (same endpoint the 29 game uses,
 *     unmodified) so chips/wins are credited to the real account.
 *   - CHIPS: sitting as a player costs CHIPS_SIT_COST, verified via the
 *     same signed sit-voucher PHP already issues at /api/chips/sit-voucher.php
 *     for the 29 game. Match wins are queued here and picked up by PHP
 *     through the exact same /internal/rooms/live-status + ack-reports
 *     pull mechanism (see server.js), crediting CHIPS_WIN_EACH to the
 *     winner's shared `users.chips` balance.
 */
'use strict';

const crypto = require('crypto');
const GameManager = require('./ludoGameManager');
const engineToken = require('./engineToken');

// How long a disconnected human's seat waits before AI takes the wheel —
// short, so the match doesn't just stall out waiting on a dropped
// connection (mirrors the 29 engine's AI_TAKEOVER_MS pattern).
const AI_TAKEOVER_MS = 20 * 1000;
// How long AFTER that the seat stays "reserved" for the same person to
// reclaim by reconnecting, before it opens up for anyone to sit into.
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const RESERVATION_TTL_MS = 60 * 1000;
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sanitize(str, maxLen) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"'`]/g, '').trim().slice(0, maxLen);
}

function randomId(len) {
    const bytes = crypto.randomBytes(len);
    let id = '';
    for (let i = 0; i < len; i++) id += ROOM_ID_CHARS[bytes[i] % ROOM_ID_CHARS.length];
    return id;
}

// ── MATCH RESULTS — queued in memory; PHP PULLS these the same way it
//    already does for the 29 game (see server.js's /internal routes). ──
const pendingMatchReports = []; // { reportId, payload }

function queueMatchReport(roomId, room, logic, winnerId) {
    const players = logic.players.map(p => ({
        name: p.name,
        clientId: p.clientId,
        username: p.username || null,
        isWinner: p.id === winnerId,
        handsPlayed: 0,
    }));
    const reportId = `ludo_${roomId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
        reportId,
        roomId,
        roomName: room.name || `Ludo Room ${roomId}`,
        handNumber: 0,
        winnerTeam: null,
        team1Score: 0,
        team2Score: 0,
        ownerUsername: room.hostUsername || null,
        game: 'ludo',
        players,
    };
    pendingMatchReports.push({ reportId, payload });
    if (pendingMatchReports.length > 500) pendingMatchReports.shift();
}

function getPendingMatchReports() {
    return pendingMatchReports.map(r => r.payload);
}

function ackMatchReports(reportIds) {
    if (!Array.isArray(reportIds) || reportIds.length === 0) return;
    const idSet = new Set(reportIds);
    for (let i = pendingMatchReports.length - 1; i >= 0; i--) {
        if (idSet.has(pendingMatchReports[i].reportId)) pendingMatchReports.splice(i, 1);
    }
}

GameManager.setMatchOverHandler((roomId, logic, winnerId) => {
    const room = instanceForReport.rooms.get(roomId);
    if (room) queueMatchReport(roomId, room, logic, winnerId);
});

// Set once RoomManager is constructed, so the static setMatchOverHandler
// callback above (registered at module load) can reach live room data.
let instanceForReport = { rooms: new Map() };

class LudoRoomManager {
    constructor(io) {
        this.io = io;
        this.rooms = new Map();
        this.reservations = new Map(); // roomId -> { clientId, maxPlayers, expiresAt }
        this.socketToRoom = new Map();
        this.consumedVouchers = new Set();
        this.takeoverTimers = new Map(); // `${roomId}:${clientId}` -> timeout (AI takes the seat)
        this.forgetTimers = new Map();   // `${roomId}:${clientId}` -> timeout (seat opens to anyone)
        instanceForReport = this;
    }

    // ── IDENTITY ──────────────────────────────────────────────────────
    verifyIdentity(token) {
        const identity = engineToken.verifyEngineToken(token);
        if (!identity || !identity.clientId) return null;
        return identity;
    }

    // ── CHIP VOUCHERS (issued by PHP's /api/chips/sit-voucher.php) ────
    verifySitVoucher(voucher, roomId, clientId) {
        const payload = engineToken.verifySignedPayload(voucher);
        if (!payload || payload.type !== 'sit-voucher') return { ok: false, error: 'Invalid voucher' };
        if (payload.roomId !== roomId) return { ok: false, error: 'Voucher is for a different room' };
        if (payload.clientId !== clientId) return { ok: false, error: 'Voucher does not belong to you' };
        if (this.consumedVouchers.has(payload.voucherId)) return { ok: false, error: 'Voucher already used' };
        this.consumedVouchers.add(payload.voucherId);
        return { ok: true, payload };
    }

    broadcastRoom(room) {
        this.io.to(room.id).emit('roomUpdate', {
            id: room.id,
            players: room.gameManager.logic.players,
            spectators: room.spectators,
            status: room.status,
            maxPlayers: room.maxPlayers
        });
    }

    // "Open" now means "has an AI seat you could sit into" — the room is
    // already playing, but that's the point: no waiting required.
    getOpenRooms() {
        return [...this.rooms.values()]
            .filter(r => r.status === 'PLAYING' && r.gameManager.logic.players.some(p => p.isAI))
            .map(r => {
                const players = r.gameManager.logic.players;
                return {
                    id: r.id,
                    hostName: r.name.replace(/'s Game$/, ''),
                    playerCount: players.filter(p => !p.isAI).length,
                    maxPlayers: players.length
                };
            });
    }

    sendRoomList(socket) {
        socket.emit('roomList', this.getOpenRooms());
    }

    broadcastRoomList() {
        this.io.emit('roomList', this.getOpenRooms());
    }

    // ── ROOM CREATION (two-phase, so PHP can issue a chip voucher for a
    //    room id that doesn't exist until this handshake) ──────────────

    /** Phase 1: reserve a fresh room id, no payment yet. */
    handleReserveRoom(socket, data, ack) {
        const identity = this.verifyIdentity(data && data.engineToken);
        if (!identity) return ack && ack({ ok: false, error: 'Not authenticated' });

        const maxPlayers = Math.max(2, Math.min(4, parseInt(data && data.maxPlayers, 10) || 4));

        // Clear expired reservations opportunistically.
        const now = Date.now();
        for (const [rid, r] of this.reservations) if (r.expiresAt < now) this.reservations.delete(rid);

        let roomId;
        do { roomId = randomId(6); } while (this.rooms.has(roomId) || this.reservations.has(roomId));
        this.reservations.set(roomId, { clientId: identity.clientId, maxPlayers, expiresAt: now + RESERVATION_TTL_MS });
        ack && ack({ ok: true, roomId });
    }

    /** Phase 2: finalize creation — requires a voucher paid against the reserved room id.
     *  The match starts immediately: every seat besides the host's is an AI bot. */
    handleCreate(socket, data, ack) {
        const identity = this.verifyIdentity(data && data.engineToken);
        if (!identity) return ack && ack({ ok: false, error: 'Not authenticated' });

        const roomId = (data && data.roomId || '').toUpperCase();
        const reservation = this.reservations.get(roomId);
        if (!reservation || reservation.clientId !== identity.clientId) {
            return ack && ack({ ok: false, error: 'Room reservation expired — please try again' });
        }

        const voucherCheck = this.verifySitVoucher(data.sitVoucher, roomId, identity.clientId);
        if (!voucherCheck.ok) return ack && ack({ ok: false, error: voucherCheck.error, refundable: !!data.sitVoucher });

        this.reservations.delete(roomId);
        const name = sanitize(data.name, 16) || identity.displayName || 'Player';
        const gameManager = new GameManager(roomId, this.io);
        const room = {
            id: roomId,
            name: `${name}'s Game`,
            hostUsername: identity.username || null,
            spectators: [],
            gameManager,
            status: 'PLAYING',
            maxPlayers: reservation.maxPlayers
        };
        this.rooms.set(roomId, room);

        socket.join(roomId);
        this.socketToRoom.set(socket.id, roomId);

        gameManager.startGame([{
            id: socket.id, clientId: identity.clientId, name, username: identity.username || null
        }], reservation.maxPlayers);

        this.broadcastRoom(room);
        this.broadcastRoomList();
        ack && ack({ ok: true, roomId });
    }

    /** Joining an EXISTING room — reclaim your own seat if you have one,
     *  sit into an open AI seat (paying the same sit-cost a fresh
     *  creation would), or fall back to spectating if the room is full
     *  of humans already. */
    handleJoin(socket, data, ack) {
        const identity = this.verifyIdentity(data && data.engineToken);
        if (!identity) return ack && ack({ ok: false, error: 'Not authenticated' });

        const roomId = (data && data.roomId || '').toUpperCase();
        const room = this.rooms.get(roomId);
        if (!room) return ack && ack({ ok: false, error: 'Room not found' });

        const clientId = identity.clientId;
        const name = sanitize(data.name, 16) || identity.displayName || 'Player';

        // Reclaiming your own seat (human seat you're reconnecting to, or
        // an AI-taken-over seat that's still reserved for you) never
        // needs a new voucher — you already paid for it once.
        const ownSeat = room.gameManager.logic.findSeatByClientId(clientId);
        if (ownSeat) {
            this._clearHandoffTimers(roomId, clientId);
            const wasAI = ownSeat.isAI;
            if (wasAI) room.gameManager.sitIn({ id: socket.id, clientId, name, username: identity.username || null }, ownSeat.color);
            else room.gameManager.reassignId(ownSeat.id, socket.id);
            socket.join(roomId);
            this.socketToRoom.set(socket.id, roomId);
            this.broadcastRoom(room);
            socket.emit('gameState', room.gameManager.getState());
            if (wasAI) this.broadcastRoomList();
            return ack && ack({ ok: true, roomId });
        }

        // Existing spectator reconnecting.
        const existingSpectator = room.spectators.find(p => p.clientId === clientId);
        if (existingSpectator) {
            existingSpectator.id = socket.id;
            socket.join(roomId);
            this.socketToRoom.set(socket.id, roomId);
            this.broadcastRoom(room);
            socket.emit('gameState', room.gameManager.getState());
            return ack && ack({ ok: true, roomId });
        }

        const hasOpenSeat = room.gameManager.logic.players.some(p => p.isAI);
        if (hasOpenSeat) {
            const voucherCheck = this.verifySitVoucher(data.sitVoucher, roomId, clientId);
            if (!voucherCheck.ok) return ack && ack({ ok: false, error: voucherCheck.error, refundable: !!data.sitVoucher });

            room.gameManager.sitIn({ id: socket.id, clientId, name, username: identity.username || null });
            socket.join(roomId);
            this.socketToRoom.set(socket.id, roomId);
            this.broadcastRoom(room);
            socket.emit('gameState', room.gameManager.getState());
            this.broadcastRoomList();
            return ack && ack({ ok: true, roomId });
        }

        // Room is full of humans — spectate instead (free).
        room.spectators.push({ id: socket.id, clientId, name, username: identity.username || null });
        socket.join(roomId);
        this.socketToRoom.set(socket.id, roomId);
        this.broadcastRoom(room);
        socket.emit('gameState', room.gameManager.getState());
        ack && ack({ ok: true, roomId });
    }

    _clearHandoffTimers(roomId, clientId) {
        const key = `${roomId}:${clientId}`;
        if (this.takeoverTimers.has(key)) { clearTimeout(this.takeoverTimers.get(key)); this.takeoverTimers.delete(key); }
        if (this.forgetTimers.has(key)) { clearTimeout(this.forgetTimers.get(key)); this.forgetTimers.delete(key); }
    }

    handleLeave(socket) {
        const roomId = this.socketToRoom.get(socket.id);
        if (!roomId) return;

        const room = this.rooms.get(roomId);
        if (room) {
            const seat = room.gameManager.logic.getPlayerById(socket.id);
            room.spectators = room.spectators.filter(p => p.id !== socket.id);

            if (seat && !seat.isAI) {
                // Explicit leave — give the seat up entirely, no reclaim window.
                const clientId = seat.clientId;
                this._clearHandoffTimers(roomId, clientId);
                room.gameManager.convertToAI(socket.id, true);
                this._deleteRoomIfAbandoned(roomId);
            }
            this.broadcastRoomList();
        }
        this.socketToRoom.delete(socket.id);
        socket.leave(roomId);
    }

    handleDisconnect(socket) {
        const roomId = this.socketToRoom.get(socket.id);
        if (!roomId) return;

        const room = this.rooms.get(roomId);
        if (!room) return;

        const seat = room.gameManager.logic.getPlayerById(socket.id);
        if (!seat || seat.isAI) {
            // A spectator disconnected — nothing to hand off.
            room.spectators = room.spectators.filter(p => p.id !== socket.id);
            this.socketToRoom.delete(socket.id);
            return;
        }

        const clientId = seat.clientId;
        room.gameManager.setConnected(socket.id, false);
        this.broadcastRoom(room);
        this.socketToRoom.delete(socket.id);

        const key = `${roomId}:${clientId}`;
        const takeoverTimer = setTimeout(() => {
            this.takeoverTimers.delete(key);
            const stillSeat = room.gameManager.logic.findSeatByClientId(clientId);
            if (stillSeat && !stillSeat.isAI && stillSeat.connected === false) {
                room.gameManager.convertToAI(stillSeat.id, false); // keep clientId — still reclaimable
                this.broadcastRoomList();

                const forgetTimer = setTimeout(() => {
                    this.forgetTimers.delete(key);
                    room.gameManager.logic.forgetSeatOwnerByClientId(clientId);
                    this._deleteRoomIfAbandoned(roomId);
                }, RECONNECT_GRACE_MS);
                this.forgetTimers.set(key, forgetTimer);
            }
        }, AI_TAKEOVER_MS);
        this.takeoverTimers.set(key, takeoverTimer);
    }

    _deleteRoomIfAbandoned(roomId) {
        const room = this.rooms.get(roomId);
        if (room && !room.gameManager.logic.hasAnyHumanSeat()) {
            this.rooms.delete(roomId);
            this.broadcastRoomList();
        }
    }

    handleChat(socket, message) {
        const roomId = this.socketToRoom.get(socket.id);
        if (!roomId) return;
        const room = this.rooms.get(roomId);
        if (!room) return;
        const user = [...room.gameManager.logic.players, ...room.spectators].find(p => p.id === socket.id);
        const text = sanitize(String(message ?? ''), 300);
        if (!text) return;
        this.io.to(roomId).emit('chatMessage', {
            sender: user ? user.name : 'Unknown',
            text,
            time: new Date().toLocaleTimeString()
        });
    }

    // Voice notes: pure live relay, nothing persisted anywhere. Emitting
    // to `io.to(roomId)` naturally only reaches sockets Socket.IO still
    // has as members of that room — anyone who's left (leaveRoom or
    // disconnect already calls socket.leave()) is not in that set any
    // more, so they simply don't get it. No separate "did they leave"
    // check needed; that's just how room broadcasts work.
    handleVoiceNote(socket, data) {
        const roomId = this.socketToRoom.get(socket.id);
        if (!roomId) return;
        const room = this.rooms.get(roomId);
        if (!room) return;

        const audioData = data && data.audioData;
        const mimeType = sanitize(data && data.mimeType, 40) || 'audio/webm';
        if (typeof audioData !== 'string' || !audioData) return;
        // Base64 payload cap (~1.5MB) — enough for a short voice note at
        // a modest bitrate, small enough not to be usable for abuse
        // given there's no persistence/rate-limiting infra here.
        if (audioData.length > 1_500_000) return;

        const user = [...room.gameManager.logic.players, ...room.spectators].find(p => p.id === socket.id);
        this.io.to(roomId).emit('voiceNote', {
            sender: user ? user.name : 'Unknown',
            audioData,
            mimeType,
            time: new Date().toLocaleTimeString()
        });
    }

    handleRollDice(socket) {
        const roomId = this.socketToRoom.get(socket.id);
        const room = this.rooms.get(roomId);
        if (room && room.status === 'PLAYING') room.gameManager.rollDice(socket.id);
    }

    handleMoveToken(socket, { tokenIndex } = {}) {
        const roomId = this.socketToRoom.get(socket.id);
        const room = this.rooms.get(roomId);
        if (room && room.status === 'PLAYING' && Number.isInteger(tokenIndex)) {
            room.gameManager.moveToken(socket.id, tokenIndex);
        }
    }
}

module.exports = LudoRoomManager;
module.exports.getPendingMatchReports = getPendingMatchReports;
module.exports.ackMatchReports = ackMatchReports;
