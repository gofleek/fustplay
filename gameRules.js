/**
 * gameRules.js — the pure 29-card-game engine: deck, bidding, trick
 * resolution, and AI. Ported as-is from the original server.js with
 * NO changes to game logic/AI behavior, per requirements.
 *
 * This module is intentionally free of any DB/HTTP concerns — it only
 * mutates the in-memory `room` object. Persistence/reporting hooks are
 * called from roomManager.js, not from here.
 */
'use strict';

const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = ["7", "8", "Q", "K", "10", "A", "9", "J"];
const POINT_MAP = { J: 3, 9: 2, A: 1, 10: 1, K: 0, Q: 0, 8: 0, 7: 0 };
const RANK_MAP = { J: 8, 9: 7, A: 6, 10: 5, K: 4, Q: 3, 8: 2, 7: 1 };
const SEAT_NAMES = ["South", "West", "North", "East"];

// ════════════════════════════════════════════════════════
//  DECK / RESET / START
// ════════════════════════════════════════════════════════
function createDeck() {
    const d = [];
    for (const s of SUITS) for (const v of VALUES) d.push({ suit: s, value: v, points: POINT_MAP[v], rank: RANK_MAP[v] });
    return d;
}
function shuffle(d) { for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[d[i], d[j]] = [d[j], d[i]]; } }
function sortHand(h) { h.sort((a, b) => a.suit === b.suit ? b.rank - a.rank : a.suit.localeCompare(b.suit)); }

function addRoomLog(room, msg, type = "") { room.gameLog.push({ msg, type }); if (room.gameLog.length > 80) room.gameLog.shift(); room.lastActivity = Date.now(); }
function getPlayerLabel(room, i) { const s = room.seats[i]; if (room.aiTakeover[i]) return `${SEAT_NAMES[i]}(AI🤖)`; return s ? `${SEAT_NAMES[i]}(${s.name})` : `${SEAT_NAMES[i]}(AI)`; }
function touchSeat(room, i) { room.lastActivityPerSeat[i] = Date.now(); room.lastActivity = Date.now(); }

function resetHand(room) {
    room.phase = "waiting"; room.deck = []; room.playerHands = [[], [], [], []];
    room.currentTrick = []; room.leadSuit = null; room.currentTurn = 0;
    room.team1Points = 0; room.team2Points = 0; room.trickCount = 0;
    room.awaitingTrickClear = false; room.matchFinished = false;
    room.biddingTurn = 0; room.currentBid = 15; room.highestBidder = -1;
    room.biddingPassedPlayers = []; room.trumpSuit = null; room.trumpRevealed = false;
    room.pendingHandResult = null; room.aiTakeover = [false, false, false, false];
    room.lastActivityPerSeat = [Date.now(), Date.now(), Date.now(), Date.now()];
}

function startHand(room) {
    resetHand(room); room.handNumber++;
    room.phase = "bidding"; room.deck = createDeck(); shuffle(room.deck);
    room.playerHands = [[], [], [], []];
    for (let i = 0; i < 16; i++) room.playerHands[i % 4].push(room.deck[i]);
    for (let i = 0; i < 4; i++) sortHand(room.playerHands[i]);
    room.biddingTurn = Math.floor(Math.random() * 4);
    addRoomLog(room, `🃏 Hand #${room.handNumber} — BIDDING. ${getPlayerLabel(room, room.biddingTurn)} starts.`, "system");
    addRoomLog(room, `📊 Score: S+N ${room.team1Score} | W+E ${room.team2Score}`, "system");
    touchSeat(room, room.biddingTurn);
    runAiBidLoop(room);
    return true;
}

// ════════════════════════════════════════════════════════
//  BIDDING
// ════════════════════════════════════════════════════════
function processBid(room, pi, action, value) {
    if (room.phase !== "bidding" || room.biddingTurn !== pi || room.biddingPassedPlayers.includes(pi)) return false;
    if (action === "pass") { room.biddingPassedPlayers.push(pi); addRoomLog(room, `${getPlayerLabel(room, pi)} passed`); }
    else if (action === "bid") { const bid = parseInt(value); if (isNaN(bid) || bid <= room.currentBid || bid < 16 || bid > 28) return false; room.currentBid = bid; room.highestBidder = pi; addRoomLog(room, `${getPlayerLabel(room, pi)} bid ${bid}`); }
    else return false;
    if (room.biddingPassedPlayers.length === 3 && room.highestBidder !== -1) { endBidding(room); return true; }
    if (room.biddingPassedPlayers.length === 4) { addRoomLog(room, "All passed — restarting", "system"); room.biddingPassedPlayers = []; room.currentBid = 15; room.highestBidder = -1; }
    advanceBidTurn(room); touchSeat(room, room.biddingTurn); runAiBidLoop(room); return true;
}
function advanceBidTurn(room) { let next = (room.biddingTurn + 3) % 4, l = 0; while (room.biddingPassedPlayers.includes(next) && l < 5) { next = (next + 3) % 4; l++; } if (!room.biddingPassedPlayers.includes(next)) room.biddingTurn = next; }
function endBidding(room) {
    addRoomLog(room, `🏅 ${getPlayerLabel(room, room.highestBidder)} won bid at ${room.currentBid}!`, "system");
    room.phase = "trump"; touchSeat(room, room.highestBidder);
    const isAi = !room.seats[room.highestBidder] || room.aiTakeover[room.highestBidder];
    if (isAi) setTimeout(() => { const s = smartTrump(room, room.highestBidder); setTrump(room, room.highestBidder, s); }, 1200);
}
function runAiBidLoop(room) {
    if (room.phase !== "bidding") return;
    const seat = room.biddingTurn; const isAi = !room.seats[seat] || room.aiTakeover[seat];
    if (!isAi) return;
    setTimeout(() => { if (room.phase !== "bidding" || room.biddingTurn !== seat) return; if (!room.seats[seat] || room.aiTakeover[seat]) aiBid(room, seat); }, 900);
}
function aiBid(room, i) { const d = smartBid(room, i); processBid(room, i, d.action, d.value || null); }

// ════════════════════════════════════════════════════════
//  TRUMP / PLAY
// ════════════════════════════════════════════════════════
function setTrump(room, pi, suit) {
    if (room.phase !== "trump" || room.highestBidder !== pi || !SUITS.includes(suit)) return false;
    room.trumpSuit = suit; room.trumpRevealed = false;
    addRoomLog(room, `🔒 Trump chosen by ${getPlayerLabel(room, pi)} (hidden)`, "system");
    for (let i = 16; i < 32; i++) room.playerHands[i % 4].push(room.deck[i]);
    for (let i = 0; i < 4; i++) sortHand(room.playerHands[i]);
    room.phase = "playing"; room.currentTurn = room.highestBidder;
    addRoomLog(room, `▶ PLAY — ${getPlayerLabel(room, room.currentTurn)} leads`, "system");
    touchSeat(room, room.currentTurn); runAiLoop(room); return true;
}

function isValidMove(room, pi, card) { if (!room.leadSuit) return true; const hasLead = room.playerHands[pi].some(c => c.suit === room.leadSuit); return !hasLead || card.suit === room.leadSuit; }
function playCard(room, pi, ci) {
    const hand = room.playerHands[pi]; const card = hand[ci];
    if (!card || !isValidMove(room, pi, card)) return false;
    hand.splice(ci, 1); if (!room.leadSuit) room.leadSuit = card.suit;
    if (!room.trumpRevealed && room.trumpSuit && card.suit === room.trumpSuit && room.leadSuit !== room.trumpSuit) { room.trumpRevealed = true; addRoomLog(room, `🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room, pi)}`, "system"); }
    room.currentTrick.push({ player: pi, card }); addRoomLog(room, `${getPlayerLabel(room, pi)} played ${card.value}${card.suit}`);
    room.currentTurn = (pi + 3) % 4;
    if (room.currentTrick.length === 4) { room.awaitingTrickClear = true; setTimeout(() => resolveTrick(room), 2000); }
    else touchSeat(room, room.currentTurn);
    return true;
}
function runAiLoop(room) {
    if (room.phase !== "playing" || room.awaitingTrickClear || room.matchFinished || room.matchOver) return;
    const seat = room.currentTurn; if (room.seats[seat] && !room.aiTakeover[seat]) return;
    setTimeout(() => {
        if (room.phase !== "playing" || room.awaitingTrickClear) return;
        const cur = room.currentTurn; if (room.seats[cur] && !room.aiTakeover[cur]) return;
        if (!room.trumpRevealed && room.trumpSuit && room.leadSuit) { const hasLead = room.playerHands[cur].some(c => c.suit === room.leadSuit); if (!hasLead && shouldAiRevealTrump(room, cur)) { room.trumpRevealed = true; addRoomLog(room, `🃏 TRUMP REVEALED! ${room.trumpSuit} — by ${getPlayerLabel(room, cur)}`, "system"); } }
        const card = smartPlayCard(room, cur); const idx = room.playerHands[cur].findIndex(c => c.suit === card.suit && c.value === card.value);
        playCard(room, cur, idx); runAiLoop(room);
    }, 900);
}

// ════════════════════════════════════════════════════════
//  SMART AI (unchanged)
// ════════════════════════════════════════════════════════
function evaluateHand(hand) { let score = 0; const sg = {}; for (const c of hand) { if (!sg[c.suit]) sg[c.suit] = []; sg[c.suit].push(c); } for (const c of hand) { if (c.value === 'J') score += 14; else if (c.value === '9') score += 10; else if (c.value === 'A') score += 7; else if (c.value === '10') score += 6; else if (c.value === 'K') score += 4; else if (c.value === 'Q') score += 2; } for (const [, cards] of Object.entries(sg)) { if (cards.length >= 4) score += (cards.length - 3) * 5; if (cards.length === 1) score += 4; } const voids = 4 - Object.keys(sg).length; score += voids * 8; return score; }
function bestTrumpSuit(hand) { const ss = {}; for (const suit of SUITS) { const cards = hand.filter(c => c.suit === suit); let s = 0; for (const c of cards) { if (c.value === 'J') s += 20; else if (c.value === '9') s += 14; else if (c.value === 'A') s += 8; else if (c.value === '10') s += 6; else if (c.value === 'K') s += 4; else if (c.value === 'Q') s += 2; s += cards.length * 2; } ss[suit] = s; } return SUITS.reduce((best, s) => ss[s] > ss[best] ? s : best, SUITS[0]); }
function smartBid(room, si) { const hand = room.playerHands[si]; const strength = evaluateHand(hand); const myTeam = (si === 0 || si === 2) ? 1 : 2; const myScore = myTeam === 1 ? room.team1Score : room.team2Score; const oppScore = myTeam === 1 ? room.team2Score : room.team1Score; const current = room.currentBid; const partner = (si + 2) % 4; const partnerBid = room.highestBidder === partner; const opponentBidding = !partnerBid && room.highestBidder >= 0; const desperate = myScore <= -4 || (oppScore >= 5 && myScore < oppScore); const comfortable = myScore >= 3 && (myScore - oppScore) >= 2; const needPoints = oppScore >= 4; let baseBid; if (strength >= 70) baseBid = 22; else if (strength >= 55) baseBid = 20; else if (strength >= 42) baseBid = 18; else if (strength >= 30) baseBid = 17; else baseBid = 16; if (desperate) baseBid += 2; if (comfortable) baseBid -= 1; if (needPoints) baseBid += 1; if (partnerBid && strength >= 40 && current < baseBid) baseBid = Math.min(baseBid, current + 2); baseBid = Math.min(baseBid, 28); if (baseBid <= current) { if (opponentBidding && desperate && strength >= 35) return { action: 'bid', value: Math.min(current + 1, 28) }; return { action: 'pass' }; } if (strength < 28 && current >= 24) return { action: 'pass' }; return { action: 'bid', value: baseBid }; }
function smartTrump(room, si) { return bestTrumpSuit(room.playerHands[si]); }
function smartPlayCard(room, si) { const hand = room.playerHands[si]; const trick = room.currentTrick; const trump = room.trumpSuit; const lead = room.leadSuit; const partner = (si + 2) % 4; const myTeam = (si === 0 || si === 2) ? 1 : 2; const myScore = myTeam === 1 ? room.team1Score : room.team2Score; const valid = hand.filter(c => { if (!lead) return true; const hasLead = hand.some(x => x.suit === lead); return !hasLead || c.suit === lead; }); if (!valid.length) return hand[0]; const trickPoints = trick.reduce((s, t) => s + t.card.points, 0); const trickLen = trick.length; function cardPower(c) { let p = c.rank; if (trump && c.suit === trump) p += 100; return p; } function trickWinner(t) { let best = -1, winner = -1; for (const p of t) { let sc = p.card.rank; if (trump && p.card.suit === trump) sc += 100; else if (lead && p.card.suit !== lead) sc = -1; if (sc > best) { best = sc; winner = p.player; } } return winner; } const byAsc = [...valid].sort((a, b) => cardPower(a) - cardPower(b)); const byDesc = [...byAsc].reverse(); const currentWinner = trick.length > 0 ? trickWinner(trick) : -1; const partnerWinning = currentWinner === partner; const weWinning = currentWinner === si || (trick.length > 0 && ((currentWinner === 0 || currentWinner === 2) === (myTeam === 1))); function canBeat(c) { return trickWinner([...trick, { player: si, card: c }]) === si; } const beaters = valid.filter(canBeat).sort((a, b) => cardPower(a) - cardPower(b)); if (trickLen === 0) { const trumpCards = valid.filter(c => trump && c.suit === trump); const nonTrump = valid.filter(c => !trump || c.suit !== trump); if (room.trumpRevealed && trumpCards.length >= 2) { const jn = trumpCards.find(c => c.value === 'J' || c.value === '9'); if (jn) return jn; } const aces = nonTrump.filter(c => c.value === 'A'); if (aces.length) return aces[0]; const tens = nonTrump.filter(c => c.value === '10'); if (tens.length && trickPoints === 0) return tens[0]; if (myScore <= -4 && trumpCards.length) return byDesc[0]; const safe = nonTrump.filter(c => c.points === 0).sort((a, b) => a.rank - b.rank); return safe.length ? safe[0] : byAsc[0]; } if (partnerWinning) { const pts = valid.filter(c => c.points > 0).sort((a, b) => b.points - a.points); if (pts.length) return pts[0]; return byAsc[0]; } if (trickLen === 3) { if (weWinning || partnerWinning) { const pts = valid.filter(c => c.points > 0).sort((a, b) => b.points - a.points); return pts.length ? pts[0] : byAsc[0]; } if (beaters.length) return beaters[0]; const dump = valid.filter(c => c.points === 0).sort((a, b) => a.rank - b.rank); return dump.length ? dump[0] : byAsc[0]; } if (beaters.length) { if (trickPoints >= 2 || myScore <= -3) return beaters[0]; const dump = valid.filter(c => c.points === 0).sort((a, b) => a.rank - b.rank); if (dump.length) return dump[0]; return beaters[0]; } const dumpable = valid.filter(c => c.points === 0).sort((a, b) => a.rank - b.rank); return dumpable.length ? dumpable[0] : byAsc[0]; }
function shouldAiRevealTrump(room, si) { if (!room.leadSuit || room.trumpRevealed || !room.trumpSuit) return false; const hasLead = room.playerHands[si].some(c => c.suit === room.leadSuit); if (hasLead) return false; const trickPoints = room.currentTrick.reduce((s, t) => s + t.card.points, 0); const trumpCards = room.playerHands[si].filter(c => c.suit === room.trumpSuit); const hasStrong = trumpCards.some(c => c.value === 'J' || c.value === '9' || c.value === 'A'); return hasStrong && trickPoints >= 2; }

function resolveTrick(room) {
    if (!room.awaitingTrickClear) return;
    let winner = -1, best = -1;
    for (const p of room.currentTrick) { let sc = p.card.rank; if (p.card.suit === room.trumpSuit) sc += 100; else if (p.card.suit !== room.leadSuit) sc = -1; if (sc > best) { best = sc; winner = p.player; } }
    let pts = 0; room.currentTrick.forEach(t => pts += t.card.points);
    if (winner === 0 || winner === 2) room.team1Points += pts; else room.team2Points += pts;
    addRoomLog(room, `🏆 ${getPlayerLabel(room, winner)} won trick`);
    room.currentTrick = []; room.leadSuit = null; room.currentTurn = winner;
    room.awaitingTrickClear = false; room.trickCount++;
    if (room.trickCount >= 8) { endHand(room); return; }
    touchSeat(room, room.currentTurn); runAiLoop(room);
}

// onMatchOver is a settable hook so roomManager.js can wire persistence
// (reportMatchResult -> PHP) WITHOUT gameRules.js knowing about HTTP/DB.
let _matchOverHandler = null;
function setMatchOverHandler(fn) { _matchOverHandler = fn; }

function endHand(room) {
    room.phase = "finished"; room.matchFinished = true;
    const bidTeam = (room.highestBidder === 0 || room.highestBidder === 2) ? 1 : 2;
    const bidPts = bidTeam === 1 ? room.team1Points : room.team2Points;
    const made = bidPts >= room.currentBid;
    let d1 = 0, d2 = 0;
    if (made) { if (bidTeam === 1) d1 = +1; else d2 = +1; addRoomLog(room, `✅ Team ${bidTeam} made bid of ${room.currentBid}`, "system"); }
    else { if (bidTeam === 1) d1 = -1; else d2 = -1; addRoomLog(room, `❌ Team ${bidTeam} failed bid of ${room.currentBid}`, "system"); }
    room.team1Score += d1; room.team2Score += d2;
    room.pendingHandResult = { bidTeam, bidMade: made, delta1: d1, delta2: d2, handNumber: room.handNumber };
    addRoomLog(room, `📊 Match: S+N ${room.team1Score} | W+E ${room.team2Score}`, "system");
    checkMatchOver(room);
    if (!room.matchOver) setTimeout(() => { if (room.phase === "finished" && !room.matchOver) startHand(room); }, 3500);
}
function checkMatchOver(room) {
    const t1 = room.team1Score, t2 = room.team2Score;
    if (t1 >= 6 || t2 <= -6) { room.matchOver = true; room.matchWinner = 1; room.phase = "matchOver"; addRoomLog(room, `🏆 South+North win! (${t1} vs ${t2})`, "system"); if (_matchOverHandler) _matchOverHandler(room); }
    else if (t2 >= 6 || t1 <= -6) { room.matchOver = true; room.matchWinner = 2; room.phase = "matchOver"; addRoomLog(room, `🏆 West+East win! (${t1} vs ${t2})`, "system"); if (_matchOverHandler) _matchOverHandler(room); }
}

// ════════════════════════════════════════════════════════
//  SEAT MANAGEMENT  (chip deduction happens in roomManager.js,
//  which calls sitPlayer ONLY after PHP confirms the deduction)
// ════════════════════════════════════════════════════════
function sitPlayer(room, seat, clientId, name, username) {
    for (let i = 0; i < 4; i++) if (room.seats[i]?.clientId === clientId) room.seats[i] = null;
    room.seats[seat] = { clientId, name, username: username || null };
    room.aiTakeover[seat] = false; touchSeat(room, seat);
    addRoomLog(room, `${name} sat at ${SEAT_NAMES[seat]}` + (username ? ` (@${username})` : ' (guest)'), "system");
}
function standPlayer(room, clientId) {
    for (let i = 0; i < 4; i++) {
        if (room.seats[i]?.clientId === clientId) {
            addRoomLog(room, `${room.seats[i].name} left ${SEAT_NAMES[i]}`, "system");
            room.seats[i] = null;
            if (["bidding", "trump", "playing"].includes(room.phase) && !room.matchOver) {
                room.aiTakeover[i] = true; addRoomLog(room, `🤖 AI took over ${SEAT_NAMES[i]}`, "system");
                if (room.phase === "bidding" && room.biddingTurn === i) setTimeout(() => aiBid(room, i), 400);
                else if (room.phase === "trump" && room.highestBidder === i) setTimeout(() => setTrump(room, i, smartTrump(room, i)), 600);
                else if (room.phase === "playing" && room.currentTurn === i && !room.awaitingTrickClear) setTimeout(() => runAiLoop(room), 400);
            }
        }
    }
}

module.exports = {
    SUITS, VALUES, SEAT_NAMES,
    createDeck, shuffle, sortHand,
    addRoomLog, getPlayerLabel, touchSeat,
    resetHand, startHand,
    processBid, advanceBidTurn, endBidding, runAiBidLoop, aiBid,
    setTrump, isValidMove, playCard, runAiLoop,
    smartBid, smartTrump, smartPlayCard, shouldAiRevealTrump,
    resolveTrick, endHand, checkMatchOver, setMatchOverHandler,
    sitPlayer, standPlayer,
};
