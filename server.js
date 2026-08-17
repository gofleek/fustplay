/**
 * server.js — the 29 card game engine (Render). Pure gameplay HTTP API.
 *
 * ARCHITECTURE NOTE: InfinityFree's free tier blocks all inbound
 * automated/server-to-server requests, so this engine NEVER calls PHP
 * directly. Instead:
 *   - Room config and chip-spend vouchers are signed by PHP and relayed
 *     through the browser (see signedRoomConfig / sitVoucher params below).
 *   - Match results are queued in memory and PULLED by PHP via
 *     /internal/rooms/live-status (PHP-initiated, which works fine).
 *   - Chip BALANCES shown in the UI are supplied by the browser on each
 *     request (myChips param) since the engine has no other way to know
 *     them — PHP is the source of truth and the browser already fetches
 *     its own balance same-origin.
 *
 * Routes for the frontend (gameplay, requires engineToken):
 *   GET  /api/state           ?room&clientId&myChips&signedRoomConfig
 *   POST /api/sit              {roomId,seat,clientId,name,sitVoucher}
 *   POST /api/stand /api/play /api/bid /api/trump /api/reveal-trump /api/start
 *
 * Internal routes for the PHP backend to call (requires X-Engine-Key):
 *   POST /internal/rooms/live-status   { roomIds: [...] }
 *        -> also returns { pendingMatchReports: [...] } for PHP to record
 *   POST /internal/rooms/ack-reports   { reportIds: [...] }
 *   GET  /internal/stats/live
 *
 * Health check:
 *   GET  /healthz   — used by the frontend failsafe layer to "wake up" Render
 *                      and to detect whether the engine is reachable at all.
 */
'use strict';

const http = require('http');
const { URL } = require('url');

// ── LAST-RESORT CRASH PROTECTION ─────────────────────────────────────
// Without this, ANY unhandled exception anywhere in the process (a bug
// in a single Ludo room's AI logic, a rare edge case in the 29 game,
// anything) crashes this ENTIRE Node process — taking down every room
// for every connected user simultaneously, for both games, until the
// host detects the crash and restarts it. That matches "the server
// sometimes freezes / is unresponsive" far better than a genuine
// per-game hang would: it's intermittent (only when some rare edge
// case actually fires), it affects everyone at once, and it resolves
// itself once the process comes back up (which is also why reloading
// the page "fixes" it — by the time you reload, the crash-restart
// cycle has usually already completed).
// This is a coarse safety net, not a substitute for fixing root causes
// (see the per-callback try/catch wrapping in ludoGameManager.js) — but
// it ensures a bug in one room can never take the whole service down.
process.on('uncaughtException', (err) => {
    console.error('[FATAL-CAUGHT] uncaughtException — process would have crashed:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL-CAUGHT] unhandledRejection — process would have crashed:', reason);
});

const cfg = require('./config');
const rules = require('./gameRules');
const engineToken = require('./engineToken');
const rm = require('./roomManager');
const LudoRoomManager = require('./ludoRoomManager');
const ChessRoomManager = require('./chessRoomManager');

function json(res, data, code) {
    res.writeHead(code || 200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': cfg.ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Engine-Key, X-Engine-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    });
    res.end(JSON.stringify(data));
}
function err(res, msg, code) { json(res, { error: msg }, code || 400); }

function readBody(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => b += c);
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    });
}

function requireEngineKey(req) {
    return req.headers['x-engine-key'] === cfg.ENGINE_API_KEY;
}

/** Pulls the engine token from header or query, verifies it, returns payload or null. */
function getIdentity(req, u) {
    const headerToken = req.headers['x-engine-token'];
    const queryToken = u.searchParams.get('engineToken');
    const token = headerToken || queryToken;
    if (!token) return null;
    return engineToken.verifyEngineToken(token);
}

function respondState(room, clientId, username, res, myChips) {
    const chips = (typeof myChips === 'number' && !isNaN(myChips)) ? myChips : 0;
    json(res, rm.publicRoomState(room, clientId, username, chips));
}

const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;

    if (req.method === 'OPTIONS') { json(res, {}, 204); return; }

    // ── HEALTH CHECK (also used by failsafe wake-up pings) ──
    if (pathname === '/healthz' && req.method === 'GET') {
        json(res, { ok: true, time: Date.now(), roomCount: rm.rooms.size });
        return;
    }

    // ════════════════════════════════════════════════════════
    //  INTERNAL ROUTES (PHP -> Engine, server-to-server, PHP-initiated
    //  so these work fine — InfinityFree only blocks the OTHER direction)
    // ════════════════════════════════════════════════════════
    if (pathname === '/internal/rooms/live-status' && req.method === 'POST') {
        if (!requireEngineKey(req)) return err(res, 'Invalid engine key', 403);
        readBody(req).then((b) => {
            const roomIds = Array.isArray(b.roomIds) ? b.roomIds : [];
            json(res, {
                ok: true,
                rooms: rm.lobbyLiveStatusFor(roomIds),
                // Merged from ALL THREE games — PHP's process_pending_match_reports()
                // already branches on each report's `game` field (defaults to
                // '29' when absent), so this one pull mechanism settles
                // reward chips for Ludo and Chess matches too, with no PHP
                // changes needed beyond that field. PHP should record these
                // into MySQL, then call /internal/rooms/ack-reports with the
                // reportIds it processed.
                pendingMatchReports: [...rm.getPendingMatchReports(), ...LudoRoomManager.getPendingMatchReports(), ...ChessRoomManager.getPendingMatchReports()],
            });
        });
        return;
    }
    if (pathname === '/internal/rooms/ack-reports' && req.method === 'POST') {
        if (!requireEngineKey(req)) return err(res, 'Invalid engine key', 403);
        readBody(req).then((b) => {
            const ids = Array.isArray(b.reportIds) ? b.reportIds : [];
            rm.ackMatchReports(ids);
            LudoRoomManager.ackMatchReports(ids);
            ChessRoomManager.ackMatchReports(ids);
            json(res, { ok: true });
        });
        return;
    }
    if (pathname === '/internal/stats/live' && req.method === 'GET') {
        if (!requireEngineKey(req)) return err(res, 'Invalid engine key', 403);
        json(res, Object.assign({ ok: true }, rm.liveAggregateStats()));
        return;
    }

    // ════════════════════════════════════════════════════════
    //  GAMEPLAY ROUTES (Frontend -> Engine, requires engineToken)
    // ════════════════════════════════════════════════════════
    if (pathname === '/api/state' && req.method === 'GET') {
        try {
            const roomId = u.searchParams.get('room');
            const signedRoomConfig = u.searchParams.get('signedRoomConfig');
            const identity = getIdentity(req, u);
            const clientId = u.searchParams.get('clientId') || (identity && identity.clientId) || null;
            const myChips = parseFloat(u.searchParams.get('myChips'));

            let room = rm.getLiveRoom(roomId);
            if (!room && signedRoomConfig) room = rm.acceptSignedRoomConfig(signedRoomConfig);
            if (!room) return err(res, 'Room not found', 404);

            const username = identity ? identity.username : null;
            return respondState(room, clientId, username, res, myChips);
        } catch (e) {
            console.error('[state] error:', e);
            return err(res, 'Internal error', 500);
        }
        return;
    }

    const gameRoutes = ['/api/start', '/api/sit', '/api/stand', '/api/play', '/api/bid', '/api/trump', '/api/reveal-trump'];
    if (gameRoutes.includes(pathname) && req.method === 'POST') {
        readBody(req).then((b) => {
            try {
                const roomId = b.roomId;
                const signedRoomConfig = b.signedRoomConfig;
                const myChips = parseFloat(b.myChips);

                let room = rm.getLiveRoom(roomId);
                if (!room && signedRoomConfig) room = rm.acceptSignedRoomConfig(signedRoomConfig);
                if (!room) return err(res, 'Room not found', 404);

                const identity = getIdentity(req, u) || (b.engineToken ? engineToken.verifyEngineToken(b.engineToken) : null);
                const clientId = b.clientId || (identity && identity.clientId) || null;
                const username = identity ? identity.username : null;
                const { seat, cardIndex, action, value, suit } = b;

                if (pathname === '/api/start') {
                    const hasHuman = room.seats.some((s, i) => s && !room.aiTakeover[i]);
                    if (!hasHuman) return respondState(room, clientId, username, res, myChips);
                    if (room.matchOver) {
                        rules.resetHand(room); room.team1Score = 0; room.team2Score = 0; room.handNumber = 0;
                        room.matchOver = false; room.matchWinner = null; room.gameLog = [];
                        rules.addRoomLog(room, '🆕 New match started!', 'system');
                    }
                    rules.startHand(room);
                    return respondState(room, clientId, username, res, myChips);
                }

                if (pathname === '/api/sit') {
                    const seatN = parseInt(seat, 10);
                    const name = (b.name || 'Player').trim();
                    const existing = room.seats[seatN];
                    if (existing && existing.clientId !== clientId && !room.aiTakeover[seatN]) return err(res, 'Seat taken');
                    if (room.conditions.spectatorMode) return err(res, 'Room is in spectator mode');
                    if (!username && !room.conditions.allowGuests) return err(res, 'This room requires a registered account to play');

                    // PHP already deducted the chips and signed a voucher
                    // proving it (see api/chips/sit-voucher.php). We just
                    // verify the signature here — no outbound call needed.
                    const voucherResult = rm.consumeSitVoucher(b.sitVoucher, room.id, clientId);
                    if (!voucherResult.ok) return err(res, voucherResult.error, 402);

                    rules.sitPlayer(room, seatN, clientId, name, username);
                    // myChips from the client already reflects the post-deduction
                    // balance PHP returned alongside the voucher.
                    return respondState(room, clientId, username, res, myChips);
                }

                if (pathname === '/api/stand') {
                    rules.standPlayer(room, clientId);
                    return respondState(room, clientId, username, res, myChips);
                }

                if (pathname === '/api/play') {
                    const seatN = parseInt(seat, 10), ci = parseInt(cardIndex, 10);
                    if (room.phase === 'playing' && room.seats[seatN] && room.seats[seatN].clientId === clientId &&
                        !room.aiTakeover[seatN] && room.currentTurn === seatN && !room.awaitingTrickClear && !room.matchFinished) {
                        rules.touchSeat(room, seatN);
                        rules.playCard(room, seatN, ci);
                        rules.runAiLoop(room);
                    }
                    return respondState(room, clientId, username, res, myChips);
                }

                if (pathname === '/api/bid') {
                    const seatN = parseInt(seat, 10);
                    if (room.phase === 'bidding' && room.seats[seatN] && room.seats[seatN].clientId === clientId &&
                        !room.aiTakeover[seatN] && room.biddingTurn === seatN && !room.biddingPassedPlayers.includes(seatN)) {
                        rules.touchSeat(room, seatN);
                        rules.processBid(room, seatN, action, value);
                    }
                    return respondState(room, clientId, username, res, myChips);
                }

                if (pathname === '/api/trump') {
                    const seatN = parseInt(seat, 10);
                    if (room.phase === 'trump' && room.seats[seatN] && room.seats[seatN].clientId === clientId &&
                        !room.aiTakeover[seatN] && room.highestBidder === seatN) {
                        rules.touchSeat(room, seatN);
                        rules.setTrump(room, seatN, suit);
                    }
                    return respondState(room, clientId, username, res, myChips);
                }

                if (pathname === '/api/reveal-trump') {
                    const seatN = parseInt(seat, 10);
                    if (room.phase === 'playing' && room.seats[seatN] && room.seats[seatN].clientId === clientId &&
                        !room.aiTakeover[seatN] && !room.trumpRevealed && room.currentTurn === seatN && !room.awaitingTrickClear) {
                        const hand = room.playerHands[seatN];
                        const hasLead = room.leadSuit && hand.some((c) => c.suit === room.leadSuit);
                        if (!hasLead && room.leadSuit) {
                            room.trumpRevealed = true;
                            rules.addRoomLog(room, `🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${rules.getPlayerLabel(room, seatN)}`, 'system');
                        }
                    }
                    return respondState(room, clientId, username, res, myChips);
                }
            } catch (e) {
                console.error(`[${pathname}] error:`, e);
                err(res, 'Internal error', 500);
            }
        });
        return;
    }

    res.writeHead(404); res.end('404');
});

// ════════════════════════════════════════════════════════
//  LUDO + CHESS — both mounted on this SAME http server/process (same
//  Render deployment, same port) via socket.io. Unlike the 29 game's
//  polling REST API, these go browser<->Node directly over websockets,
//  which is unaffected by InfinityFree's inbound-request restriction
//  (that only blocks Render->InfinityFree calls, not browser->Render).
//  See ludoRoomManager.js / chessRoomManager.js for the identity/chips
//  integration details.
//
//  Chess's events are namespaced with a "chess:" prefix — Ludo and
//  Chess pages each open their own separate socket.io connection to
//  this same server, but server-side `socket.on(...)` wiring applies
//  per EVENT NAME across all connected sockets, not per page. Reusing
//  Ludo's plain event names (createRoom, moveToken, etc.) for Chess
//  too would mean both handlers fire for every socket regardless of
//  which game it's actually for.
// ════════════════════════════════════════════════════════
const { Server: SocketIOServer } = require('socket.io');
const io = new SocketIOServer(server, { cors: { origin: cfg.ALLOWED_ORIGIN, methods: ['GET', 'POST'] } });
const ludoRm = new LudoRoomManager(io);
const chessRm = new ChessRoomManager(io);

io.on('connection', (socket) => {
    socket.on('reserveRoom', (data, ack) => ludoRm.handleReserveRoom(socket, data, ack));
    socket.on('createRoom', (data, ack) => ludoRm.handleCreate(socket, data, ack));
    socket.on('joinRoom', (data, ack) => ludoRm.handleJoin(socket, data, ack));
    socket.on('leaveRoom', () => ludoRm.handleLeave(socket));
    socket.on('chatMessage', (data) => ludoRm.handleChat(socket, data));
    socket.on('sendVoice', (data) => ludoRm.handleVoiceNote(socket, data));
    socket.on('rollDice', () => ludoRm.handleRollDice(socket));
    socket.on('moveToken', (data) => ludoRm.handleMoveToken(socket, data));
    socket.on('listRooms', () => ludoRm.sendRoomList(socket));

    socket.on('chess:reserveRoom', (data, ack) => chessRm.handleReserveRoom(socket, data, ack));
    socket.on('chess:createRoom', (data, ack) => chessRm.handleCreate(socket, data, ack));
    socket.on('chess:joinRoom', (data, ack) => chessRm.handleJoin(socket, data, ack));
    socket.on('chess:leaveRoom', () => chessRm.handleLeave(socket));
    socket.on('chess:sendVoice', (data) => chessRm.handleVoiceNote(socket, data));
    socket.on('chess:move', (data) => chessRm.handleMove(socket, data));
    socket.on('chess:legalMoves', (data, ack) => chessRm.handleLegalMoves(socket, data, ack));
    socket.on('chess:listRooms', () => chessRm.sendRoomList(socket));

    // A socket is only ever tracked by whichever ONE of these it
    // actually joined a room in — the other's handleDisconnect no-ops
    // harmlessly, so it's safe to call both unconditionally here.
    socket.on('disconnect', () => {
        ludoRm.handleDisconnect(socket);
        chessRm.handleDisconnect(socket);
    });
});

server.listen(cfg.PORT, () => console.log(`29 Card Game + Ludo + Chess ENGINE listening on port ${cfg.PORT}`));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
