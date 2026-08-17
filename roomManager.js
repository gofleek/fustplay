/**
 * roomManager.js — owns the in-memory `rooms` Map (live card state).
 *
 * IMPORTANT ARCHITECTURE NOTE:
 * InfinityFree's free tier has a mandatory "Browser Security System" that
 * blocks ALL inbound automated/server-to-server requests (including from
 * Render) to PHP — see:
 * https://forum.infinityfree.com/t/browser-security-system-features-and-limitations/49353
 * This means the engine can NEVER successfully call PHP directly. Every
 * exchange below is therefore either:
 *   (a) PHP-initiated (PHP polling the engine's /internal/* routes — this
 *       direction works fine, since it's PHP's own outbound request), or
 *   (b) relayed through the BROWSER, which signs/verifies small HMAC
 *       payloads so the engine can trust data from PHP without calling it.
 *
 * Concretely:
 *   - Room config: browser fetches a SIGNED config from PHP and hands it
 *     to the engine on first /api/state call (see acceptSignedRoomConfig).
 *   - Sit-cost chips: browser fetches a SIGNED voucher from PHP (which
 *     already deducted the chips) and hands it to the engine on /api/sit
 *     (see consumeSitVoucher).
 *   - Match results: the engine queues them in memory; PHP picks them up
 *     the next time it calls /internal/rooms/live-status (which it already
 *     does regularly for the lobby/dashboard) and acks them via
 *     /internal/rooms/ack-reports.
 */
'use strict';

const cfg = require('./config');
const rules = require('./gameRules');
const { verifySignedPayload } = require('./engineToken');

const rooms = new Map();          // roomId -> room (live game state + cached config)
const roomViewers = new Map();    // roomId -> Map(clientId -> lastSeenTs)
const usedVoucherIds = new Set(); // prevents a sit-voucher from being replayed
const VIEWER_TTL = 10000;

const SEAT_NAMES = rules.SEAT_NAMES;

// ════════════════════════════════════════════════════════
//  ROOM CONFIG — supplied by the BROWSER (relaying a PHP-signed payload),
//  never fetched by the engine itself.
// ════════════════════════════════════════════════════════
function defaultTheme() {
    return { bgColor: "#06080d", tableColor: "#0a1828", borderColor: "#1c2f50", bgImage: null, accentColor: "#ffd54f" };
}

/**
 * Verifies a signed room-config payload (issued by PHP's
 * /api/room/config-public.php and relayed by the browser) and returns the
 * plain config object, or null if invalid/expired.
 */
function verifySignedRoomConfig(signedRoomConfig) {
    const payload = verifySignedPayload(signedRoomConfig);
    if (!payload || !payload.id) return null;
    return payload;
}

// ════════════════════════════════════════════════════════
//  ROOM LIFECYCLE
// ════════════════════════════════════════════════════════
function makeBlankRoom(id, config) {
    return {
        id,
        name: config.name,
        password: config.password || '',
        ownerUsername: config.ownerUsername || null,
        conditions: Object.assign({ entryCost: 0, allowGuests: true, spectatorMode: false, minChips: 0 }, config.conditions || {}),
        theme: config.theme || defaultTheme(),
        phase: "waiting", deck: [], playerHands: [[], [], [], []],
        seats: [null, null, null, null],
        biddingTurn: 0, currentBid: 15, highestBidder: -1,
        biddingPassedPlayers: [],
        trumpSuit: null, trumpRevealed: false,
        currentTrick: [], leadSuit: null, currentTurn: 0,
        team1Points: 0, team2Points: 0, trickCount: 0,
        awaitingTrickClear: false, matchFinished: false,
        team1Score: 0, team2Score: 0, handNumber: 0,
        pendingHandResult: null, matchOver: false, matchWinner: null,
        lastActivityPerSeat: [Date.now(), Date.now(), Date.now(), Date.now()],
        aiTakeover: [false, false, false, false],
        gameLog: [],
        lastActivity: Date.now(),
        createdAt: Date.now(),
    };
}

/**
 * Gets a live room if already loaded. Returns null if not present —
 * callers must call acceptSignedRoomConfig() first to load/create it,
 * since the engine has no way to fetch config on its own anymore.
 */
function getLiveRoom(roomId) {
    if (!roomId) return null;
    return rooms.get(roomId.toUpperCase()) || null;
}

/**
 * Loads (or refreshes) a room from a signed config payload the browser
 * relayed from PHP. Safe to call on every /api/state request — it's a
 * cheap HMAC verify, and only actually mutates the room on first load or
 * when the room doesn't exist yet locally.
 *
 * Returns the room, or null if the signed payload was invalid/expired.
 */
function acceptSignedRoomConfig(signedRoomConfig) {
    const config = verifySignedRoomConfig(signedRoomConfig);
    if (!config) return null;

    const roomId = config.id.toUpperCase();
    if (config.status && config.status !== 'active') return null;

    let room = rooms.get(roomId);
    if (!room) {
        room = makeBlankRoom(roomId, config);
        rooms.set(roomId, room);
        rules.addRoomLog(room, `Room "${room.name}" loaded.`, "system");
    } else {
        // Room already live in memory — refresh the parts an owner could
        // have changed (theme/conditions) without touching live game state.
        room.name = config.name;
        room.password = config.password || '';
        room.ownerUsername = config.ownerUsername || null;
        room.conditions = Object.assign({ entryCost: 0, allowGuests: true, spectatorMode: false, minChips: 0 }, config.conditions || {});
        room.theme = config.theme || room.theme;
    }
    return room;
}

// ════════════════════════════════════════════════════════
//  VIEWERS
// ════════════════════════════════════════════════════════
function touchViewer(roomId, clientId) {
    if (!clientId) return;
    if (!roomViewers.has(roomId)) roomViewers.set(roomId, new Map());
    roomViewers.get(roomId).set(clientId, Date.now());
}
function getViewerCount(roomId) {
    const vm = roomViewers.get(roomId);
    if (!vm) return 0;
    const cutoff = Date.now() - VIEWER_TTL;
    let count = 0;
    for (const [cid, ts] of vm.entries()) {
        if (ts >= cutoff) count++;
        else vm.delete(cid);
    }
    return count;
}
setInterval(() => { for (const [rid] of roomViewers.entries()) if (!rooms.has(rid)) roomViewers.delete(rid); }, 60000);

// ════════════════════════════════════════════════════════
//  SIT-COST VOUCHERS — PHP already deducted the chips; we just verify
//  the signature and consume it (one-time use) instead of calling PHP.
// ════════════════════════════════════════════════════════
/**
 * Verifies and consumes a sit-voucher. Returns { ok, amountPaid, error }.
 * A voucher can only be consumed once (replay protection via voucherId).
 */
function consumeSitVoucher(voucherToken, expectedRoomId, expectedClientId) {
    const payload = verifySignedPayload(voucherToken);
    if (!payload || payload.type !== 'sit-voucher') {
        return { ok: false, error: 'Missing or invalid payment voucher. Please try again.' };
    }
    if (payload.roomId !== expectedRoomId || payload.clientId !== expectedClientId) {
        return { ok: false, error: 'Voucher does not match this room/player.' };
    }
    if (usedVoucherIds.has(payload.voucherId)) {
        return { ok: false, error: 'This payment was already used. Please try again.' };
    }
    usedVoucherIds.add(payload.voucherId);
    // Bound the set's growth — vouchers expire in 2 minutes anyway (see
    // sit-voucher.php), so we don't need to remember them forever.
    if (usedVoucherIds.size > 5000) {
        const first = usedVoucherIds.values().next().value;
        usedVoucherIds.delete(first);
    }
    return { ok: true, amountPaid: payload.amountPaid, voucherId: payload.voucherId };
}

// ════════════════════════════════════════════════════════
//  MATCH RESULTS — queued in memory; PHP PULLS these (never pushed).
// ════════════════════════════════════════════════════════
const pendingMatchReports = []; // { reportId, payload, queuedAt }

function reportMatchResult(room) {
    const players = room.seats
        .map((s, i) => s ? { name: s.name, clientId: s.clientId, username: s.username || null, seat: SEAT_NAMES[i], team: (i === 0 || i === 2) ? 1 : 2 } : null)
        .filter(Boolean)
        .map(p => Object.assign({}, p, { isWinner: p.team === room.matchWinner, handsPlayed: room.handNumber }));

    const reportId = `${room.id}_${room.handNumber}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
        reportId,
        roomId: room.id,
        roomName: room.name,
        handNumber: room.handNumber,
        winnerTeam: room.matchWinner,
        team1Score: room.team1Score,
        team2Score: room.team2Score,
        ownerUsername: room.ownerUsername || null,
        players,
    };

    pendingMatchReports.push({ reportId, payload, queuedAt: Date.now() });
    // Safety valve: don't grow unbounded if PHP is down for a long time.
    if (pendingMatchReports.length > 500) pendingMatchReports.shift();
}

// Wire the pure game-rules "match over" event to our queueing logic.
rules.setMatchOverHandler(reportMatchResult);

/** Returns all pending reports (PHP calls this via live-status). */
function getPendingMatchReports() {
    return pendingMatchReports.map((r) => r.payload);
}

/** Removes acknowledged reports once PHP confirms it has recorded them. */
function ackMatchReports(reportIds) {
    if (!Array.isArray(reportIds) || reportIds.length === 0) return;
    const idSet = new Set(reportIds);
    for (let i = pendingMatchReports.length - 1; i >= 0; i--) {
        if (idSet.has(pendingMatchReports[i].reportId)) pendingMatchReports.splice(i, 1);
    }
}

// ════════════════════════════════════════════════════════
//  AI WATCHDOG / CLEANUP
// ════════════════════════════════════════════════════════
function checkAllRooms() {
    for (const room of rooms.values()) {
        if (!["bidding", "trump", "playing"].includes(room.phase) || room.matchOver) continue;
        let activeSeat = -1;
        if (room.phase === "bidding") activeSeat = room.biddingTurn;
        else if (room.phase === "playing") activeSeat = room.currentTurn;
        else if (room.phase === "trump") activeSeat = room.highestBidder;
        if (activeSeat === -1) continue;
        const s = room.seats[activeSeat]; if (!s || room.aiTakeover[activeSeat]) continue;
        const elapsed = Date.now() - room.lastActivityPerSeat[activeSeat];
        if (elapsed >= cfg.AI_TAKEOVER_MS) {
            room.aiTakeover[activeSeat] = true; room.seats[activeSeat] = null;
            rules.addRoomLog(room, `⏰ ${s.name} unresponsive — AI took over ${SEAT_NAMES[activeSeat]}`, "system");
            if (room.phase === "bidding") setTimeout(() => rules.aiBid(room, activeSeat), 300);
            else if (room.phase === "trump") setTimeout(() => rules.setTrump(room, activeSeat, rules.smartTrump(room, activeSeat)), 600);
            else rules.runAiLoop(room);
        }
    }
}
setInterval(checkAllRooms, 10000);

setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms.entries()) {
        if (now - room.lastActivity > cfg.ROOM_IDLE_CLEANUP) {
            rooms.delete(id);
        }
    }
}, 10 * 60 * 1000);

// ════════════════════════════════════════════════════════
//  PUBLIC STATE SERIALIZATION
// ════════════════════════════════════════════════════════
function publicRoomState(room, clientId, username, myChips) {
    touchViewer(room.id, clientId);
    const st = Object.assign({}, room);
    if (!st.trumpRevealed && st.phase === "playing") {
        const isWinner = clientId && st.seats[st.highestBidder] && st.seats[st.highestBidder].clientId === clientId;
        if (!isWinner) st.trumpSuit = null;
    }
    st.deck = [];
    const mySeat = clientId ? st.seats.findIndex(s => s && s.clientId === clientId) : -1;
    st.playerHands = st.playerHands.map((h, i) => i === mySeat ? h : h.map(() => ({})));
    st.ownerDisplay = room.ownerUsername || null;
    st.myChips = myChips;
    st.sitCost = cfg.CHIPS_SIT_COST;
    st.winReward = cfg.CHIPS_WIN_EACH;
    st.viewerCount = getViewerCount(room.id);
    return st;
}

function lobbyLiveStatusFor(roomIds) {
    const out = [];
    for (const id of roomIds) {
        const room = rooms.get(id.toUpperCase());
        if (!room) continue;
        const playerDetails = room.seats.map((s, i) => s && !room.aiTakeover[i] ? s.name : null);
        out.push({
            id: room.id,
            phase: room.phase,
            players: playerDetails.filter(Boolean).length,
            playerDetails,
            handNumber: room.handNumber,
            team1Score: room.team1Score,
            team2Score: room.team2Score,
        });
    }
    return out;
}

function liveAggregateStats() {
    const fiveMin = 5 * 60 * 1000;
    let activeUsers = 0;
    let activeRooms = 0;
    for (const room of rooms.values()) {
        if (['bidding', 'trump', 'playing'].includes(room.phase)) activeRooms++;
        room.seats.forEach((s, i) => { if (s && !room.aiTakeover[i] && Date.now() - room.lastActivityPerSeat[i] < fiveMin) activeUsers++; });
    }
    return { activeUsers, activeRooms };
}

module.exports = {
    rooms,
    getLiveRoom, acceptSignedRoomConfig,
    publicRoomState, lobbyLiveStatusFor, liveAggregateStats,
    consumeSitVoucher, reportMatchResult,
    getPendingMatchReports, ackMatchReports,
    getViewerCount,
};
