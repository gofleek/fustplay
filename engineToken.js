/**
 * engineToken.js — verifies short-lived signed payloads issued by PHP's
 * sign_payload() helper. Used for THREE kinds of signed data, all using
 * the same HMAC scheme (since they all share ENGINE_API_KEY as the secret):
 *   1. Identity tokens   (/api/auth/engine-token.php)       -> verifyEngineToken()
 *   2. Room config       (/api/room/config-public.php)      -> verifySignedPayload()
 *   3. Chip-spend vouchers (/api/chips/sit-voucher.php)      -> verifySignedPayload()
 *
 * This lets the engine trust data the BROWSER relays from PHP, without
 * ever needing to call PHP itself — required because InfinityFree's free
 * tier blocks all inbound server-to-server/bot requests to PHP. See:
 * https://forum.infinityfree.com/t/browser-security-system-features-and-limitations/49353
 */
'use strict';

const crypto = require('crypto');
const cfg = require('./config');

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Generic verifier for any "base64payload.hexsignature" string signed
 * with ENGINE_API_KEY. Returns the parsed payload object, or null if the
 * signature is invalid, the payload isn't valid JSON, or (when the
 * payload has an `exp` field) it has expired.
 */
function verifySignedPayload(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const idx = token.lastIndexOf('.');
    const b64 = token.slice(0, idx);
    const sig = token.slice(idx + 1);

    const expectedSig = crypto.createHmac('sha256', cfg.ENGINE_API_KEY).update(b64).digest('hex');
    if (!safeEqual(sig, expectedSig)) return null;

    let payload;
    try { payload = JSON.parse(base64UrlDecode(b64)); }
    catch (e) { return null; }

    if (payload && typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
    return payload;
}

/** Back-compat name used by server.js for identity tokens specifically. */
function verifyEngineToken(token) {
    return verifySignedPayload(token);
}

module.exports = { verifyEngineToken, verifySignedPayload };
