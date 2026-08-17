/**
 * chessLogic.js — a complete, from-scratch chess rules engine (legal
 * move generation, check/checkmate/stalemate, castling, en passant,
 * promotion, draw detection). No external chess library was available
 * to pull in here (no network access to npm during development), so
 * this is hand-written — verified against known "perft" reference
 * numbers (a standard chess-engine correctness test: the exact legal
 * move count from the starting position at each depth is a famous,
 * well-known sequence, and even a single move-generation bug throws
 * these off immediately). See the test harness used during development
 * for the perft(1)-(3) verification.
 *
 * Board convention: 8x8 array, board[r][c]. r=0 is rank 8, r=7 is rank
 * 1. c=0 is file a, c=7 is file h. A square is {type, color} or null.
 */
'use strict';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function rcToSquare(r, c) { return FILES[c] + (8 - r); }
function squareToRC(sq) { return { r: 8 - parseInt(sq[1], 10), c: FILES.indexOf(sq[0]) }; }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function opponent(color) { return color === 'w' ? 'b' : 'w'; }

function cloneBoard(board) {
    return board.map(row => row.map(sq => (sq ? { ...sq } : null)));
}

class ChessLogic {
    constructor() {
        this.reset();
    }

    reset() {
        this.board = this.initialBoard();
        this.turn = 'w';
        this.castling = { wK: true, wQ: true, bK: true, bQ: true };
        this.enPassant = null; // {r,c} — the square a pawn can capture onto
        this.halfmoveClock = 0;
        this.fullmoveNumber = 1;
        this.status = 'ongoing'; // ongoing | checkmate | stalemate | draw
        this.winner = null; // 'w' | 'b' | null
        this.drawReason = null;
        this.lastMove = null; // for highlighting on the client
        this.capturedPieces = { w: [], b: [] }; // pieces captured BY each color
        this.moveHistory = []; // short algebraic-ish log, for display only
    }

    initialBoard() {
        const back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
        const board = Array.from({ length: 8 }, () => Array(8).fill(null));
        for (let c = 0; c < 8; c++) {
            board[0][c] = { type: back[c], color: 'b' };
            board[1][c] = { type: 'P', color: 'b' };
            board[6][c] = { type: 'P', color: 'w' };
            board[7][c] = { type: back[c], color: 'w' };
        }
        return board;
    }

    findKing(board, color) {
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            const sq = board[r][c];
            if (sq && sq.type === 'K' && sq.color === color) return { r, c };
        }
        return null;
    }

    // Direct attack detection — deliberately NOT built on top of move
    // generation, to avoid any recursion into castling legality (which
    // itself depends on this function).
    isSquareAttacked(board, r, c, byColor) {
        // Pawns
        const pawnDir = byColor === 'w' ? 1 : -1; // white pawns attack "upward" (toward lower r), so from the attacked square's perspective the attacker sits one row further down
        for (const dc of [-1, 1]) {
            const pr = r + pawnDir, pc = c + dc;
            if (inBounds(pr, pc)) {
                const sq = board[pr][pc];
                if (sq && sq.type === 'P' && sq.color === byColor) return true;
            }
        }
        // Knights
        const knightDeltas = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
        for (const [dr, dc] of knightDeltas) {
            const nr = r + dr, nc = c + dc;
            if (inBounds(nr, nc)) {
                const sq = board[nr][nc];
                if (sq && sq.type === 'N' && sq.color === byColor) return true;
            }
        }
        // King (adjacent)
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (inBounds(nr, nc)) {
                const sq = board[nr][nc];
                if (sq && sq.type === 'K' && sq.color === byColor) return true;
            }
        }
        // Sliding: rook/queen (orthogonal)
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            let nr = r + dr, nc = c + dc;
            while (inBounds(nr, nc)) {
                const sq = board[nr][nc];
                if (sq) {
                    if (sq.color === byColor && (sq.type === 'R' || sq.type === 'Q')) return true;
                    break;
                }
                nr += dr; nc += dc;
            }
        }
        // Sliding: bishop/queen (diagonal)
        for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
            let nr = r + dr, nc = c + dc;
            while (inBounds(nr, nc)) {
                const sq = board[nr][nc];
                if (sq) {
                    if (sq.color === byColor && (sq.type === 'B' || sq.type === 'Q')) return true;
                    break;
                }
                nr += dr; nc += dc;
            }
        }
        return false;
    }

    isInCheck(board, color) {
        const king = this.findKing(board, color);
        if (!king) return false; // shouldn't happen in a legal game
        return this.isSquareAttacked(board, king.r, king.c, opponent(color));
    }

    // Pseudo-legal moves for one piece (doesn't check if it leaves own
    // king in check — that filtering happens in generateLegalMoves()).
    pseudoMovesForSquare(state, r, c) {
        const { board } = state;
        const piece = board[r][c];
        if (!piece) return [];
        const moves = [];
        const color = piece.color;
        const add = (tr, tc, extra = {}) => moves.push({ from: { r, c }, to: { r: tr, c: tc }, ...extra });

        if (piece.type === 'P') {
            const dir = color === 'w' ? -1 : 1;
            const startRow = color === 'w' ? 6 : 1;
            const promoRow = color === 'w' ? 0 : 7;
            const oneStep = r + dir;
            if (inBounds(oneStep, c) && !board[oneStep][c]) {
                if (oneStep === promoRow) {
                    for (const promo of ['Q', 'R', 'B', 'N']) add(oneStep, c, { promotion: promo });
                } else {
                    add(oneStep, c);
                    const twoStep = r + dir * 2;
                    if (r === startRow && !board[twoStep][c]) add(twoStep, c, { doubleStep: true });
                }
            }
            for (const dc of [-1, 1]) {
                const tr = r + dir, tc = c + dc;
                if (!inBounds(tr, tc)) continue;
                const target = board[tr][tc];
                if (target && target.color !== color) {
                    if (tr === promoRow) {
                        for (const promo of ['Q', 'R', 'B', 'N']) add(tr, tc, { capture: true, promotion: promo });
                    } else {
                        add(tr, tc, { capture: true });
                    }
                } else if (!target && state.enPassant && state.enPassant.r === tr && state.enPassant.c === tc) {
                    add(tr, tc, { capture: true, enPassantCapture: true });
                }
            }
        } else if (piece.type === 'N') {
            const deltas = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
            for (const [dr, dc] of deltas) {
                const tr = r + dr, tc = c + dc;
                if (!inBounds(tr, tc)) continue;
                const target = board[tr][tc];
                if (!target) add(tr, tc);
                else if (target.color !== color) add(tr, tc, { capture: true });
            }
        } else if (piece.type === 'K') {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const tr = r + dr, tc = c + dc;
                if (!inBounds(tr, tc)) continue;
                const target = board[tr][tc];
                if (!target) add(tr, tc);
                else if (target.color !== color) add(tr, tc, { capture: true });
            }
            // Castling
            const homeRow = color === 'w' ? 7 : 0;
            if (r === homeRow && c === 4 && !this.isSquareAttacked(board, r, c, opponent(color))) {
                const kSideRight = color === 'w' ? state.castling.wK : state.castling.bK;
                if (kSideRight && !board[homeRow][5] && !board[homeRow][6]
                    && board[homeRow][7] && board[homeRow][7].type === 'R' && board[homeRow][7].color === color
                    && !this.isSquareAttacked(board, homeRow, 5, opponent(color))
                    && !this.isSquareAttacked(board, homeRow, 6, opponent(color))) {
                    add(homeRow, 6, { castle: 'K' });
                }
                const qSideRight = color === 'w' ? state.castling.wQ : state.castling.bQ;
                if (qSideRight && !board[homeRow][1] && !board[homeRow][2] && !board[homeRow][3]
                    && board[homeRow][0] && board[homeRow][0].type === 'R' && board[homeRow][0].color === color
                    && !this.isSquareAttacked(board, homeRow, 3, opponent(color))
                    && !this.isSquareAttacked(board, homeRow, 2, opponent(color))) {
                    add(homeRow, 2, { castle: 'Q' });
                }
            }
        } else {
            // Sliding pieces: bishop, rook, queen
            const dirs = piece.type === 'B' ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
                : piece.type === 'R' ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
                : [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]]; // queen
            for (const [dr, dc] of dirs) {
                let tr = r + dr, tc = c + dc;
                while (inBounds(tr, tc)) {
                    const target = board[tr][tc];
                    if (!target) { add(tr, tc); }
                    else { if (target.color !== color) add(tr, tc, { capture: true }); break; }
                    tr += dr; tc += dc;
                }
            }
        }
        return moves;
    }

    // Applies a move to a (already cloned, if needed by the caller)
    // state in place. Does NOT validate legality — callers must only
    // pass moves from generateLegalMoves().
    applyMove(state, move) {
        const { board } = state;
        const piece = board[move.from.r][move.from.c];
        const color = piece.color;
        let capturedPiece = board[move.to.r][move.to.c];

        // En passant capture removes a pawn NOT on the destination square.
        if (move.enPassantCapture) {
            const capR = color === 'w' ? move.to.r + 1 : move.to.r - 1;
            capturedPiece = board[capR][move.to.c];
            board[capR][move.to.c] = null;
        }

        board[move.to.r][move.to.c] = move.promotion ? { type: move.promotion, color } : piece;
        board[move.from.r][move.from.c] = null;

        // Castling: also move the rook.
        if (move.castle === 'K') {
            const homeRow = move.from.r;
            board[homeRow][5] = board[homeRow][7];
            board[homeRow][7] = null;
        } else if (move.castle === 'Q') {
            const homeRow = move.from.r;
            board[homeRow][3] = board[homeRow][0];
            board[homeRow][0] = null;
        }

        // Castling rights: king or rook moving/being captured revokes them.
        if (piece.type === 'K') {
            if (color === 'w') { state.castling.wK = false; state.castling.wQ = false; }
            else { state.castling.bK = false; state.castling.bQ = false; }
        }
        const revokeIfRook = (r, c) => {
            if (r === 7 && c === 0) state.castling.wQ = false;
            if (r === 7 && c === 7) state.castling.wK = false;
            if (r === 0 && c === 0) state.castling.bQ = false;
            if (r === 0 && c === 7) state.castling.bK = false;
        };
        revokeIfRook(move.from.r, move.from.c);
        revokeIfRook(move.to.r, move.to.c);

        // En passant target for the NEXT move only.
        state.enPassant = move.doubleStep ? { r: (move.from.r + move.to.r) / 2, c: move.from.c } : null;

        // 50-move rule clock.
        if (piece.type === 'P' || capturedPiece) state.halfmoveClock = 0;
        else state.halfmoveClock++;

        if (capturedPiece) state.capturedPieces[color].push(capturedPiece.type);

        if (color === 'b') state.fullmoveNumber++;
        state.turn = opponent(color);
        state.lastMove = { from: move.from, to: move.to };

        return capturedPiece;
    }

    generateLegalMoves(state, color) {
        const legal = [];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            const piece = state.board[r][c];
            if (!piece || piece.color !== color) continue;
            const pseudo = this.pseudoMovesForSquare(state, r, c);
            for (const move of pseudo) {
                const clonedState = { board: cloneBoard(state.board), castling: { ...state.castling }, enPassant: state.enPassant, capturedPieces: { w: [], b: [] } };
                this.applyMove(clonedState, move);
                if (!this.isInCheck(clonedState.board, color)) legal.push(move);
            }
        }
        return legal;
    }

    hasInsufficientMaterial(board) {
        const pieces = [];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            if (board[r][c]) pieces.push(board[r][c]);
        }
        const nonKing = pieces.filter(p => p.type !== 'K');
        if (nonKing.length === 0) return true; // K vs K
        if (nonKing.length === 1 && (nonKing[0].type === 'B' || nonKing[0].type === 'N')) return true; // K+B vs K, K+N vs K
        return false;
    }

    // Recomputes this.status/winner/drawReason after a move — call this
    // right after applyMove() with the state's NEW turn (the player who
    // must move next).
    refreshStatus() {
        const color = this.turn;
        const legalMoves = this.generateLegalMoves(this, color);
        const inCheck = this.isInCheck(this.board, color);
        if (legalMoves.length === 0) {
            if (inCheck) { this.status = 'checkmate'; this.winner = opponent(color); }
            else { this.status = 'stalemate'; this.winner = null; this.drawReason = 'stalemate'; }
        } else if (this.hasInsufficientMaterial(this.board)) {
            this.status = 'draw'; this.winner = null; this.drawReason = 'insufficient material';
        } else if (this.halfmoveClock >= 100) {
            this.status = 'draw'; this.winner = null; this.drawReason = '50-move rule';
        } else {
            this.status = 'ongoing'; this.winner = null; this.drawReason = null;
        }
        return { legalMoves, inCheck };
    }

    // ── Public API used by chessGameManager.js ──────────────────────
    getLegalMovesFrom(square) {
        const { r, c } = squareToRC(square);
        const piece = this.board[r][c];
        if (!piece || piece.color !== this.turn) return [];
        const all = this.generateLegalMoves(this, this.turn);
        return all.filter(m => m.from.r === r && m.from.c === c).map(m => ({
            to: rcToSquare(m.to.r, m.to.c),
            capture: !!m.capture,
            promotion: m.promotion || null,
            castle: m.castle || null,
        }));
    }

    move(playerColor, from, to, promotion) {
        if (this.status !== 'ongoing') return { success: false, error: 'Game is already over' };
        if (playerColor !== this.turn) return { success: false, error: 'Not your turn' };

        const { r: fr, c: fc } = squareToRC(from);
        const { r: tr, c: tc } = squareToRC(to);
        const piece = this.board[fr][fc];
        if (!piece || piece.color !== playerColor) return { success: false, error: 'No such piece' };

        const legal = this.generateLegalMoves(this, playerColor);
        const match = legal.find(m => m.from.r === fr && m.from.c === fc && m.to.r === tr && m.to.c === tc
            && (!m.promotion || m.promotion === (promotion || 'Q').toUpperCase()));
        if (!match) return { success: false, error: 'Illegal move' };

        const capturedPiece = this.applyMove(this, match);
        const { legalMoves, inCheck } = this.refreshStatus();

        return {
            success: true,
            move: { from, to, promotion: match.promotion || null, castle: match.castle || null, capture: !!capturedPiece },
            status: this.status,
            winner: this.winner,
            inCheck,
            hasLegalMoves: legalMoves.length > 0,
        };
    }

    getState() {
        return {
            board: this.board,
            turn: this.turn,
            status: this.status,
            winner: this.winner,
            drawReason: this.drawReason,
            lastMove: this.lastMove,
            capturedPieces: this.capturedPieces,
            inCheck: this.status === 'ongoing' ? this.isInCheck(this.board, this.turn) : false,
            halfmoveClock: this.halfmoveClock,
            fullmoveNumber: this.fullmoveNumber,
        };
    }
}

module.exports = { ChessLogic, rcToSquare, squareToRC, cloneBoard, opponent };
