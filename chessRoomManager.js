/**
 * chessRoomManager.js — Chess's lobby/room layer, mounted on the same
 * Render process as the 29 card game and Ludo engines (see server.js).
 * Same model as ludoRoomManager.js: matches start immediately with an
 * AI opponent, a browsing player can sit into the open (AI) seat at
 * any point, and a human disconnect/leave hands their seat to AI so
 * the match always finishes. Chess only ever has 2 seats (white/black)
 * so there's no player-count picker like Ludo's.
 *
 * Shared with the 29 game and PHP, per the integration requirements:
 *   - IDENTITY via PHP's /api/auth/engine-token.php (unmodified).
 *   - CHIPS via the same signed sit-voucher from /api/chips/sit-voucher.php
 *     and the same /internal/rooms/live-status + ack-reports pull for
 *     match-result chip crediting.
 */
'use strict';

const crypto = require('crypto');
const GameManager = require('./chessGameManager');
const engineToken = require('./engineToken');

const AI_TAKEOVER_MS = 20 * 1000;
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

// ── MATCH RESULTS — same pull-based queue as the 29 game and Ludo. ───
const pendingMatchReports = [];

function queueMatchReport(roomId, room, gm, winnerId) {
    const players = gm.players.map(p => ({
        name: p.name,
        clientId: p.clientId,
        username: p.username || null,
        isWinner: winnerId !== null && p.id === winnerId,
        handsPlayed: 0,
    }));
    const reportId = `chess_${roomId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
        reportId,
        roomId,
        roomName: room.name || `Chess Room ${roomId}`,
        handNumber: 0,
        winnerTeam: null,
        team1Score: 0,
        team2Score: 0,
        ownerUsername: room.hostUsername || null,
        game: 'chess',
        players,
    };
    pendingMatchReports.push({ reportId, payload });
    if (pendingMatchReports.length > 500) pendingMatchReports.shift();
}

function getPendingMatchReports() { return pendingMatchReports.map(r => r.payload); }

function ackMatchReports(reportIds) {
    if (!Array.isArray(reportIds) || reportIds.length === 0) return;
    const idSet = new Set(reportIds);
    for (let i = pendingMatchReports.length - 1; i >= 0; i--) {
        if (idSet.has(pendingMatchReports[i].reportId)) pendingMatchReports.splice(i, 1);
    }
}

GameManager.setMatchOverHandler((roomId, gm, winnerId) => {
    const room = instanceForReport.rooms.get(roomId);
    if (room) queueMatchReport(roomId, room, gm, winnerId);
});

let instanceForReport = { rooms: new Map() };

class ChessRoomManager {
    constructor(io) {
        this.io = io;
        this.rooms = new Map();
        this.reservations = new Map(); // roomId -> { clientId, expiresAt }
        this.socketToRoom = new Map();
        this.consumedVouchers = new Set();
        this.takeoverTimers = new Map();
        this.forgetTimers = new Map();
        instanceForReport = this;
    }

    verifyIdentity(token) {
        const identity = engineToken.verifyEngineToken(token);
        if (!identity || !identity.clientId) return null;
        return identity;
    }

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
            players: room.gameManager.players,
            spectators: room.spectators,
            status: room.status,
        });
    }

    getOpenRooms() {
        return [...this.rooms.values()]
            .filter(r => r.status === 'PLAYING' && r.gameManager.players.some(p => p.isAI))
            .map(r => {
                const players = r.gameManager.players;
                return {
                    id: r.id,
                    hostName: r.name.replace(/'s Game$/, ''),
                    playerCount: players.filter(p => !p.isAI).length,
                    maxPlayers: 2,
                };
            });
    }

    sendRoomList(socket) { socket.emit('roomList', this.getOpenRooms()); }
    broadcastRoomList() { this.io.emit('roomList', this.getOpenRooms()); }

    handleReserveRoom(socket, data, ack) {
        const identity = this.verifyIdentity(data && data.engineToken);
        if (!identity) return ack && ack({ ok: false, error: 'Not authenticated' });

        const now = Date.now();
        for (const [rid, r] of this.reservations) if (r.expiresAt < now) this.reservations.delete(rid);

        let roomId;
        do { roomId = randomId(6); } while (this.rooms.has(roomId) || this.reservations.has(roomId));
        this.reservations.set(roomId, { clientId: identity.clientId, expiresAt: now + RESERVATION_TTL_MS });
        ack && ack({ ok: true, roomId });
    }

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
        };
        this.rooms.set(roomId, room);

        socket.join(roomId);
        this.socketToRoom.set(socket.id, roomId);

        gameManager.startGame([{ id: socket.id, clientId: identity.clientId, name, username: identity.username || null }]);

        this.broadcastRoom(room);
        this.broadcastRoomList();
        ack && ack({ ok: true, roomId });
    }

    handleJoin(socket, data, ack) {
        const identity = this.verifyIdentity(data && data.engineToken);
        if (!identity) return ack && ack({ ok: false, error: 'Not authenticated' });

        const roomId = (data && data.roomId || '').toUpperCase();
        const room = this.rooms.get(roomId);
        if (!room) return ack && ack({ ok: false, error: 'Room not found' });

        const clientId = identity.clientId;
        const name = sanitize(data.name, 16) || identity.displayName || 'Player';

        const ownSeat = room.gameManager.findSeatByClientId(clientId);
        if (ownSeat) {
            this._clearHandoffTimers(roomId, clientId);
            const wasAI = ownSeat.isAI;
            if (wasAI) room.gameManager.sitIn({ id: socket.id, clientId, name, username: identity.username || null });
            else room.gameManager.reassignId(ownSeat.id, socket.id);
            socket.join(roomId);
            this.socketToRoom.set(socket.id, roomId);
            this.broadcastRoom(room);
            socket.emit('gameState', room.gameManager.getState());
            if (wasAI) this.broadcastRoomList();
            return ack && ack({ ok: true, roomId });
        }

        const existingSpectator = room.spectators.find(p => p.clientId === clientId);
        if (existingSpectator) {
            existingSpectator.id = socket.id;
            socket.join(roomId);
            this.socketToRoom.set(socket.id, roomId);
            this.broadcastRoom(room);
            socket.emit('gameState', room.gameManager.getState());
            return ack && ack({ ok: true, roomId });
        }

        const hasOpenSeat = room.gameManager.players.some(p => p.isAI);
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
            const seat = room.gameManager.getPlayerById(socket.id);
            room.spectators = room.spectators.filter(p => p.id !== socket.id);

            if (seat && !seat.isAI) {
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

        const seat = room.gameManager.getPlayerById(socket.id);
        if (!seat || seat.isAI) {
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
            const stillSeat = room.gameManager.findSeatByClientId(clientId);
            if (stillSeat && !stillSeat.isAI && stillSeat.connected === false) {
                room.gameManager.convertToAI(stillSeat.id, false);
                this.broadcastRoomList();

                const forgetTimer = setTimeout(() => {
                    this.forgetTimers.delete(key);
                    const seatNow = room.gameManager.findSeatByClientId(clientId);
                    if (seatNow && seatNow.isAI) { seatNow.clientId = null; seatNow.username = null; }
                    this._deleteRoomIfAbandoned(roomId);
                }, RECONNECT_GRACE_MS);
                this.forgetTimers.set(key, forgetTimer);
            }
        }, AI_TAKEOVER_MS);
        this.takeoverTimers.set(key, takeoverTimer);
    }

    _deleteRoomIfAbandoned(roomId) {
        const room = this.rooms.get(roomId);
        if (room && !room.gameManager.hasAnyHumanSeat()) {
            this.rooms.delete(roomId);
            this.broadcastRoomList();
        }
    }

    handleMove(socket, { from, to, promotion } = {}) {
        const roomId = this.socketToRoom.get(socket.id);
        const room = this.rooms.get(roomId);
        if (room && room.status === 'PLAYING' && typeof from === 'string' && typeof to === 'string') {
            room.gameManager.move(socket.id, from, to, promotion);
        }
    }

    // Lets the client highlight legal destinations before committing to
    // a move — the server remains the sole source of truth (move() is
    // re-validated independently when the client actually sends one),
    // this is purely a UX convenience so tapping a piece shows where it
    // can go.
    handleLegalMoves(socket, { square } = {}, ack) {
        const roomId = this.socketToRoom.get(socket.id);
        const room = this.rooms.get(roomId);
        if (!room || typeof square !== 'string') return ack && ack({ moves: [] });
        const player = room.gameManager.getPlayerById(socket.id);
        if (!player || player.color !== room.gameManager.logic.turn) return ack && ack({ moves: [] });
        ack && ack({ moves: room.gameManager.logic.getLegalMovesFrom(square) });
    }

    // Voice notes: identical pure live relay to Ludo's — see the note
    // there for why no persistence/leave-tracking code is needed.
    handleVoiceNote(socket, data) {
        const roomId = this.socketToRoom.get(socket.id);
        if (!roomId) return;
        const room = this.rooms.get(roomId);
        if (!room) return;

        const audioData = data && data.audioData;
        const mimeType = sanitize(data && data.mimeType, 40) || 'audio/webm';
        if (typeof audioData !== 'string' || !audioData) return;
        if (audioData.length > 1_500_000) return;

        const user = [...room.gameManager.players, ...room.spectators].find(p => p.id === socket.id);
        this.io.to(roomId).emit('voiceNote', {
            sender: user ? user.name : 'Unknown',
            audioData,
            mimeType,
            time: new Date().toLocaleTimeString()
        });
    }
}

module.exports = ChessRoomManager;
module.exports.getPendingMatchReports = getPendingMatchReports;
module.exports.ackMatchReports = ackMatchReports;
