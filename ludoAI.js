/**
 * ludoAI.js — a heuristic bot for AI-controlled seats (either "filled in
 * at creation" or "took over after a human disconnected"). Not meant to
 * be unbeatable — but it does actually look at the board (threats from
 * opponents, safe squares) rather than blindly always advancing
 * whichever token happens to be furthest along, which is what made it
 * look like "one token moves, the others just sit there."
 *
 * Priority when choosing which token to move on a given roll:
 *   1. A move that captures an opponent's token.
 *   2. A move that gets a token all the way home.
 *   3. Move a token that's currently in immediate danger (an opponent
 *      token is within striking distance on an unsafe square) — prefer
 *      an escape that lands on safety, but even just moving it changes
 *      the distance an opponent needs.
 *   4. Proactively land on a safe square if one of the candidate moves
 *      offers that, reducing future risk.
 *   5. Bring a token out of BASE (on a 6), if fewer than 2 tokens are
 *      already active — spreads risk instead of stacking everything on
 *      one token.
 *   6. Otherwise, develop whichever active token is LEAST advanced —
 *      this is the actual fix for "only one token ever moves": rather
 *      than always pushing the current leader further ahead, spread
 *      progress across all of them so every token actually gets played.
 */
'use strict';

function isTokenThreatened(logic, player, token) {
    // Once a token is past the shared 51-square track (i.e. in its own
    // home lane) it can no longer be captured by anyone.
    if (token.state !== 'ACTIVE' || token.position > 50) return false;
    const myGlobal = logic.getGlobalPosition(player.color, token.position);
    if (myGlobal === -1 || logic.safeSquares.includes(myGlobal)) return false;

    return logic.players.some(p => {
        if (p.id === player.id) return false;
        return p.tokens.some(t => {
            if (t.state !== 'ACTIVE' || t.position > 50) return false;
            const oppGlobal = logic.getGlobalPosition(p.color, t.position);
            if (oppGlobal === -1) return false;
            // How many squares ahead of the opponent (going the shared
            // direction) our token sits — if that's 1-6, any single
            // roll could let them land exactly on us next turn.
            const dist = (myGlobal - oppGlobal + 52) % 52;
            return dist >= 1 && dist <= 6;
        });
    });
}

function landsOnSafety(logic, player, token, diceValue) {
    if (token.state !== 'ACTIVE') return false;
    const finalPos = token.position + diceValue;
    if (finalPos > 50) return true; // entering the home lane — uncapturable
    const globalPos = logic.getGlobalPosition(player.color, finalPos);
    return globalPos !== -1 && logic.safeSquares.includes(globalPos);
}

function chooseTokenToMove(player, diceValue, logic) {
    const candidates = player.tokens
        .map((t, idx) => ({ idx, token: t }))
        .filter(({ idx }) => logic.isValidMove(player, idx, diceValue));

    if (candidates.length === 0) return -1;
    if (candidates.length === 1) return candidates[0].idx;

    // 1. Prefer a capture.
    for (const { idx, token } of candidates) {
        if (token.state !== 'ACTIVE') continue;
        const finalPos = token.position + diceValue;
        if (finalPos > 50) continue; // moving into home column can't capture
        const globalPos = logic.getGlobalPosition(player.color, finalPos);
        if (globalPos === -1 || logic.safeSquares.includes(globalPos)) continue;
        const wouldCapture = logic.players.some(p =>
            p.id !== player.id && p.tokens.some(t => t.state === 'ACTIVE' && logic.getGlobalPosition(p.color, t.position) === globalPos)
        );
        if (wouldCapture) return idx;
    }

    // 2. Prefer finishing a token (reaching exactly 56).
    for (const { idx, token } of candidates) {
        if (token.state === 'ACTIVE' && token.position + diceValue === 56) return idx;
    }

    // 3. Rescue whichever of our tokens is under immediate threat.
    const threatened = candidates.filter(({ token }) => isTokenThreatened(logic, player, token));
    if (threatened.length > 0) {
        const safeEscape = threatened.find(({ token }) => landsOnSafety(logic, player, token, diceValue));
        return (safeEscape || threatened[0]).idx;
    }

    // 4. Proactively land on a safe square if one's on offer.
    const safeLanding = candidates.find(({ token }) => landsOnSafety(logic, player, token, diceValue));
    if (safeLanding) return safeLanding.idx;

    // 5. Bring a new token out of base if we don't already have 2+ active.
    const activeCount = player.tokens.filter(t => t.state === 'ACTIVE').length;
    if (diceValue === 6 && activeCount < 2) {
        const baseCandidate = candidates.find(({ token }) => token.state === 'BASE');
        if (baseCandidate) return baseCandidate.idx;
    }

    // 6. Otherwise, develop whichever active token is LEAST advanced —
    //    spreads play across all tokens instead of only ever pushing
    //    the current leader.
    const activeCandidates = candidates.filter(({ token }) => token.state === 'ACTIVE');
    if (activeCandidates.length > 0) {
        activeCandidates.sort((a, b) => a.token.position - b.token.position);
        return activeCandidates[0].idx;
    }

    return candidates[0].idx;
}

module.exports = { chooseTokenToMove };
