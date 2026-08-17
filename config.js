/**
 * config.js — environment-driven configuration for the game engine.
 *
 * Set these as Environment Variables in the Render dashboard:
 *   ENGINE_API_KEY  = must match ENGINE_API_KEY in PHP config.php
 *                      (used both for PHP->Engine internal calls AND to
 *                      verify signed payloads relayed through the browser
 *                      — see roomManager.js's architecture note)
 *   ALLOWED_ORIGIN   = your frontend origin, or * for testing
 *   PORT             = provided automatically by Render
 *
 * NOTE: There is intentionally no PHP_BACKEND_URL here anymore. The
 * engine never calls PHP directly — InfinityFree's free tier blocks all
 * inbound automated requests. See roomManager.js for the full explanation.
 */
'use strict';

module.exports = {
    PORT: process.env.PORT || 3000,
    ENGINE_API_KEY: process.env.ENGINE_API_KEY || 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '*',

    // Must match PHP config.php values so AI/economy stay consistent
    CHIPS_GUEST_START: 10,
    CHIPS_REG_START: 100,
    CHIPS_SIT_COST: 2,
    CHIPS_WIN_EACH: 4,

    AI_TAKEOVER_MS: 20 * 1000,
    ROOM_IDLE_CLEANUP: 2 * 60 * 60 * 1000,
};
