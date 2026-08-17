/**
 * chessAI.js — minimax with alpha-beta pruning over the ChessLogic
 * engine. Not a strong engine (no opening book, no transposition
 * table, shallow depth) but it actually looks ahead and evaluates
 * material/position rather than picking randomly or greedily.
 */
'use strict';

const { cloneBoard, rcToSquare } = require('./chessLogic');

const PIECE_VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

// Encourage central control / good development without a full PST set
// for every piece — kept small on purpose (this only nudges move
// choice among otherwise-equal options, material still dominates).
const PAWN_ADVANCE_BONUS = [0, 5, 10, 15, 25, 40, 60, 0]; // indexed by distance from own back rank
const CENTER_BONUS = (r, c) => {
    const dr = Math.abs(3.5 - r), dc = Math.abs(3.5 - c);
    return Math.max(0, 4 - (dr + dc)) * 3;
};

function evaluate(board, color) {
    let score = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (!piece) continue;
        let value = PIECE_VALUES[piece.type];
        if (piece.type === 'N' || piece.type === 'B') value += CENTER_BONUS(r, c);
        if (piece.type === 'P') {
            const distFromBackRank = piece.color === 'w' ? 7 - r : r;
            value += PAWN_ADVANCE_BONUS[distFromBackRank];
        }
        score += piece.color === color ? value : -value;
    }
    return score;
}

function makeChildState(state, move, logic) {
    const clone = {
        board: cloneBoard(state.board),
        castling: { ...state.castling },
        enPassant: state.enPassant,
        capturedPieces: { w: [], b: [] },
        turn: state.turn,
        halfmoveClock: state.halfmoveClock,
        fullmoveNumber: state.fullmoveNumber,
    };
    logic.applyMove(clone, move);
    return clone;
}

// Search captures first — much better alpha-beta pruning, and it's
// also just a reasonable move-ordering heuristic on its own.
function orderMoves(moves) {
    return [...moves].sort((a, b) => (b.capture ? 1 : 0) - (a.capture ? 1 : 0));
}

function minimax(logic, state, depth, alpha, beta, forColor) {
    const moves = logic.generateLegalMoves(state, state.turn);
    if (depth === 0 || moves.length === 0) {
        if (moves.length === 0) {
            const inCheck = logic.isInCheck(state.board, state.turn);
            if (inCheck) {
                // Checkmate — as bad as possible for whoever's turn it
                // is, scaled by depth so the AI prefers a FASTER mate
                // when it's winning and a SLOWER one when losing.
                return state.turn === forColor ? -100000 - depth : 100000 + depth;
            }
            return 0; // stalemate
        }
        return evaluate(state.board, forColor);
    }

    const ordered = orderMoves(moves);
    if (state.turn === forColor) {
        let best = -Infinity;
        for (const move of ordered) {
            const child = makeChildState(state, move, logic);
            const val = minimax(logic, child, depth - 1, alpha, beta, forColor);
            if (val > best) best = val;
            if (val > alpha) alpha = val;
            if (alpha >= beta) break;
        }
        return best;
    } else {
        let best = Infinity;
        for (const move of ordered) {
            const child = makeChildState(state, move, logic);
            const val = minimax(logic, child, depth - 1, alpha, beta, forColor);
            if (val < best) best = val;
            if (val < beta) beta = val;
            if (alpha >= beta) break;
        }
        return best;
    }
}

// Returns { from, to, promotion } in square notation, or null if no
// legal move exists (shouldn't be called in that case, but defensive).
function chooseMove(logic, state, color, depth = 3) {
    const moves = orderMoves(logic.generateLegalMoves(state, color));
    if (moves.length === 0) return null;

    let bestMove = moves[0];
    let bestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;

    for (const move of moves) {
        const child = makeChildState(state, move, logic);
        const score = minimax(logic, child, depth - 1, alpha, beta, color);
        if (score > bestScore) {
            bestScore = score;
            bestMove = move;
        }
        if (score > alpha) alpha = score;
    }

    return {
        from: rcToSquare(bestMove.from.r, bestMove.from.c),
        to: rcToSquare(bestMove.to.r, bestMove.to.c),
        promotion: bestMove.promotion || null,
    };
}

module.exports = { chooseMove, evaluate };
