'use strict';
/* =====================================================================
   DOMINÓ — script.js
   ---------------------------------------------------------------------
   Dois jogadores: contra o bot ou contra uma pessoa (no mesmo aparelho).
   Seções:
     1. Utilitários e constantes
     2. REGRAS ......... DominoGame (rodada) e Match (partida) — sem DOM
     3. IA ............. AI.choose — fácil / médio / difícil — sem DOM
     4. LAYOUT ......... BoardLayout (posições na mesa, em células) — sem DOM
     5. Armazenamento .. configurações e estatísticas (localStorage)
     6. Som ............ efeitos sintetizados com Web Audio
     7. Interface ...... BoardView, mãos, assentos, diálogos, arrastar e soltar
     8. Controlador .... fluxo da partida (turnos, jogadas, fim de rodada)
   As seções 2, 3 e 4 não tocam no DOM; as seções 5 a 8 só rodam no navegador.
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. UTILITÁRIOS E CONSTANTES
   --------------------------------------------------------------------- */
const TILE_THEMES = ['light', 'dark', 'hearts', 'stars', 'gingerbread'];
const THEME_NAMES = { light: 'Claro', dark: 'Escuro', hearts: 'Corações', stars: 'Estrelas', gingerbread: 'Gengibre' };
const DIFFICULTY_NAMES = { easy: 'Fácil', medium: 'Médio', hard: 'Difícil' };
const BOT_NAMES = { 1: 'Seu Tião' };
const PLAYER_COUNT = 2;
// Vitórias contra o bot necessárias para liberar cada estilo de peça.
const THEME_UNLOCK = { light: 0, dark: 5, hearts: 8, stars: 12, gingerbread: 16 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const tilePips = (t) => t.a + t.b;
const handPips = (h) => h.reduce((s, t) => s + t.a + t.b, 0);
const byTile = (x, y) => x.a - y.a || x.b - y.b;

/* ---------------------------------------------------------------------
   2. REGRAS
   --------------------------------------------------------------------- */
class DominoGame {
  /**
   * @param {{players?:number, drawEnabled?:boolean, rng?:Function}} opts
   * Com 2 jogadores: 7 peças cada. Com compra, as 14 restantes formam o monte; sem compra, ficam fora.
   */
  constructor({ players = PLAYER_COUNT, drawEnabled = true, rng = Math.random } = {}) {
    this.n = players;
    this.drawEnabled = drawEnabled;
    this.rng = rng;
    this.handSize = players <= 2 ? 7 : (drawEnabled ? 6 : 7);
    this.hands = [];
    this.boneyard = [];
    this.placed = [];            // jogadas na ordem em que ocorreram
    this.ends = { left: null, right: null };
    this.current = 0;
    this.passStreak = 0;
    this.passLog = [];           // quem passou e com quais pontas abertas
    this.openingTile = null;     // peça obrigatória na primeira jogada (ou null)
    this.status = 'idle';        // idle | playing | ended
    this.result = null;
  }

  static fullSet() {
    const set = [];
    for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) set.push({ id: `${a}-${b}`, a, b });
    return set;
  }

  /** Embaralha, distribui e define quem começa.
   *  starter = índice do jogador que abre livremente, ou null para a regra da maior carroça. */
  startRound({ starter = null } = {}) {
    const set = shuffle(DominoGame.fullSet(), this.rng);
    const hs = this.handSize;
    this.hands = Array.from({ length: this.n }, (_, i) => set.slice(i * hs, (i + 1) * hs).sort(byTile));
    this.boneyard = set.slice(this.n * hs);
    this.placed = [];
    this.ends = { left: null, right: null };
    this.passStreak = 0;
    this.passLog = [];
    this.result = null;
    this.status = 'playing';

    if (starter === null) {
      let best = null, holder = 0;
      this.hands.forEach((h, p) => h.forEach((t) => {
        if (!best || this._openRank(t) > this._openRank(best)) { best = t; holder = p; }
      }));
      this.current = holder;
      this.openingTile = best;
    } else {
      this.current = starter;
      this.openingTile = null;
    }
  }

  // Carroças valem mais que qualquer peça comum; entre elas, a maior vence.
  _openRank(t) { return (t.a === t.b ? 100 : 0) + t.a + t.b + Math.max(t.a, t.b) / 10; }

  /** Todas as jogadas {tile, side} possíveis para o jogador. side: 'start' | 'left' | 'right'. */
  legalMoves(p = this.current) {
    if (this.status !== 'playing') return [];
    const hand = this.hands[p];
    const moves = [];
    if (this.placed.length === 0) {
      const list = this.openingTile ? hand.filter((t) => t.id === this.openingTile.id) : hand;
      list.forEach((tile) => moves.push({ tile, side: 'start' }));
      return moves;
    }
    for (const tile of hand) {
      for (const side of ['left', 'right']) {
        const e = this.ends[side];
        if (tile.a === e || tile.b === e) moves.push({ tile, side });
      }
    }
    return moves;
  }

  play(p, tileId, side) {
    if (this.status !== 'playing') throw new Error('A rodada já terminou.');
    if (p !== this.current) throw new Error('Não é a vez deste jogador.');
    const move = this.legalMoves(p).find((m) => m.tile.id === tileId && m.side === side);
    if (!move) throw new Error('Jogada inválida.');

    const hand = this.hands[p];
    hand.splice(hand.findIndex((t) => t.id === tileId), 1);
    const t = move.tile;
    let inner, outer;
    if (side === 'start') {
      this.ends.left = t.a; this.ends.right = t.b;
      inner = t.a; outer = t.b;
    } else {
      const e = this.ends[side];
      if (t.a === e) { inner = t.a; outer = t.b; } else { inner = t.b; outer = t.a; }
      this.ends[side] = outer;
    }
    this.placed.push({ tile: t, side, inner, outer, player: p });
    this.passStreak = 0;
    this.openingTile = null;

    const ev = { type: 'play', player: p, tile: t, side, inner, outer, roundOver: false, result: null };
    if (hand.length === 0) {
      ev.roundOver = true;
      ev.result = this._finish('domino', p);
    } else {
      this.current = (p + 1) % this.n;
    }
    return ev;
  }

  canDraw(p = this.current) {
    return this.status === 'playing' && this.drawEnabled && p === this.current &&
      this.boneyard.length > 0 && this.legalMoves(p).length === 0;
  }

  draw(p) {
    if (!this.canDraw(p)) throw new Error('Não é possível comprar agora.');
    const tile = this.boneyard.pop();
    this.hands[p].push(tile);
    this.hands[p].sort(byTile);
    return tile;
  }

  canPass(p = this.current) {
    return this.status === 'playing' && p === this.current &&
      this.legalMoves(p).length === 0 && (!this.drawEnabled || this.boneyard.length === 0);
  }

  pass(p) {
    if (!this.canPass(p)) throw new Error('Você ainda tem jogada ou pode comprar.');
    this.passLog.push({ player: p, left: this.ends.left, right: this.ends.right });
    this.passStreak++;
    const ev = { type: 'pass', player: p, roundOver: false, result: null };
    if (this.passStreak >= this.n) {
      ev.roundOver = true;
      ev.result = this._finish('blocked', null);
    } else {
      this.current = (p + 1) % this.n;
    }
    return ev;
  }

  _finish(reason, winner) {
    this.status = 'ended';
    const pips = this.hands.map(handPips);
    let tie = false;
    if (reason === 'blocked') {
      const min = Math.min(...pips);
      let cands = pips.map((v, i) => (v === min ? i : -1)).filter((i) => i >= 0);
      if (cands.length > 1) {
        const fewest = Math.min(...cands.map((i) => this.hands[i].length));
        cands = cands.filter((i) => this.hands[i].length === fewest);
      }
      if (cands.length === 1) winner = cands[0]; else { tie = true; winner = null; }
    }
    const points = winner === null ? 0 : pips.reduce((s, v, i) => (i === winner ? s : s + v), 0);
    this.result = {
      reason, winner, tie, points, pips,
      hands: this.hands.map((h) => h.map((t) => ({ ...t }))),
    };
    return this.result;
  }
}

/** Partida: acumula pontos entre rodadas. target = 0 significa rodada única. */
class Match {
  constructor({ target = 50, players = PLAYER_COUNT } = {}) {
    this.target = target;
    this.players = players;
    this.scores = Array(players).fill(0);
    this.round = 1;
    this.over = false;
    this.winner = null;
    this.nextStarter = null;
  }

  applyRound(result) {
    if (result.winner !== null) this.scores[result.winner] += result.points;
    this.nextStarter = result.winner;          // null (empate) volta à regra da carroça
    if (this.target === 0) {
      this.over = true;
      this.winner = result.winner;
    } else {
      const top = Math.max(...this.scores);
      if (top >= this.target) {
        const leaders = this.scores.map((s, i) => (s === top ? i : -1)).filter((i) => i >= 0);
        this.over = true;
        this.winner = leaders.includes(result.winner) ? result.winner : leaders[0];
      }
    }
    return this.over;
  }

  advance() { this.round++; }
}

/* ---------------------------------------------------------------------
   3. INTELIGÊNCIA ARTIFICIAL
   --------------------------------------------------------------------- */
const AI = {
  /** Retorna {tile, side} ou null (sem jogada). */
  choose(game, p, level = 'medium') {
    const moves = game.legalMoves(p);
    if (moves.length === 0) return null;
    if (moves.length === 1) return moves[0];
    if (level === 'easy') return moves[Math.floor(Math.random() * moves.length)];
    return this._best(game, p, moves, level === 'hard');
  },

  endsAfter(game, move) {
    const t = move.tile;
    if (move.side === 'start') return { left: t.a, right: t.b };
    const e = { ...game.ends };
    const cur = e[move.side];
    e[move.side] = t.a === cur ? t.b : t.a;
    return e;
  },

  _best(game, p, moves, smart) {
    const hand = game.hands[p];
    const info = smart ? this._knowledge(game, p) : null;
    let best = null, bestScore = -Infinity;
    for (const m of moves) {
      const rest = hand.filter((t) => t.id !== m.tile.id);
      const ends = this.endsAfter(game, m);
      const fits = (t) => t.a === ends.left || t.b === ends.left || t.a === ends.right || t.b === ends.right;
      const mobility = rest.filter(fits).length;
      const isDouble = m.tile.a === m.tile.b;
      let score;

      if (!smart) {
        // Médio: livra-se de peças pesadas e de carroças, mantém opções.
        score = tilePips(m.tile) + (isDouble ? 3 : 0) + mobility * 1.5 + Math.random() * 2;
      } else {
        const smallestOpp = Math.min(...game.hands.map((h, i) => (i === p ? 99 : h.length)));
        const pipWeight = smallestOpp <= 2 ? 1.6 : 1;
        score = tilePips(m.tile) * pipWeight + (isDouble ? 3 : 0) + mobility * 2.5 + Math.random() * 0.4;
        if (rest.length === 0) score += 1000;
        const next = (p + 1) % game.n;
        for (const v of [ends.left, ends.right]) {
          const mine = rest.filter((t) => t.a === v || t.b === v).length;
          score += mine * 1.5;
          if (mine === 0) score -= 2;
          score += (7 - info.unseen[v]) * 0.8;               // poucas peças restantes com esse número → bom para travar
          for (let o = 0; o < game.n; o++) {
            if (o === p) continue;
            if (info.lacks[o].has(v)) score += o === next ? 5 : 2; // adversário sem esse número tende a passar
          }
        }
      }
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  },

  /** O que a IA difícil "lembra": peças já vistas e números que cada adversário não tem. */
  _knowledge(game, p) {
    const seen = new Set(game.placed.map((e) => e.tile.id));
    game.hands[p].forEach((t) => seen.add(t.id));
    const unseen = Array(7).fill(0);
    for (const t of DominoGame.fullSet()) {
      if (seen.has(t.id)) continue;
      unseen[t.a]++;
      if (t.b !== t.a) unseen[t.b]++;
    }
    const lacks = Array.from({ length: game.n }, () => new Set());
    for (const e of game.passLog) { lacks[e.player].add(e.left); lacks[e.player].add(e.right); }
    return { unseen, lacks };
  },
};

/* ---------------------------------------------------------------------
   4. LAYOUT DO TABULEIRO (puro)
   ---------------------------------------------------------------------
   A mesa é uma grade de células (1 célula = largura da peça). Uma peça comum
   ocupa 2 células; uma carroça ocupa 1 célula e fica atravessada.
   Cada ponta cresce em linha reta e faz curva ao chegar no limite, formando
   uma serpente: a ponta direita desce, a esquerda sobe — nunca se cruzam.
   --------------------------------------------------------------------- */
const DIRS = { E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 }, N: { x: 0, y: -1 } };
const OPP = { E: 'W', W: 'E', N: 'S', S: 'N' };
// Ângulo CSS (sentido horário) que faz o topo da imagem apontar para o vetor v.
const angleOf = (v) => (v.y === -1 ? 0 : v.x === 1 ? 90 : v.y === 1 ? 180 : 270);

class BoardLayout {
  constructor(opts = {}) {
    this.limE = opts.limE ?? 6;
    this.limW = opts.limW ?? -5;
    this.vertTiles = opts.vertTiles ?? 2;
    this.reset();
  }

  reset() { this.items = []; this.arms = { left: null, right: null }; }

  _next(side, isDouble) {
    const arm = this.arms[side];
    if (!arm) return null;
    const h = arm.heading, d = DIRS[h];
    const horiz = h === 'E' || h === 'W';
    let turned = false;
    // Carroças nunca fazem a curva, e a peça logo depois de uma carroça também não
    // (senão ela ficaria deslocada, sem encostar na ponta da carroça).
    if (!isDouble && !arm.lastDouble) {
      if (horiz) {
        const ox = arm.end.x + 2 * d.x;
        turned = (h === 'E' && ox > this.limE) || (h === 'W' && ox < this.limW);
      } else {
        turned = arm.legTiles >= this.vertTiles;
      }
    }
    let nh = h;
    if (turned) nh = horiz ? (side === 'right' ? 'S' : 'N') : OPP[arm.lastH];

    const inner = { x: arm.end.x + d.x, y: arm.end.y + d.y };
    let outer;
    if (turned) { const nd = DIRS[nh]; outer = { x: inner.x + nd.x, y: inner.y + nd.y }; }
    else if (isDouble) outer = { ...inner };
    else outer = { x: inner.x + d.x, y: inner.y + d.y };

    const nHoriz = nh === 'E' || nh === 'W';
    let cx, cy, fp, rot;
    if (isDouble) {
      cx = inner.x + 0.5; cy = inner.y + 0.5;
      rot = nHoriz ? 0 : 90;
      fp = nHoriz
        ? { x0: inner.x, x1: inner.x + 1, y0: inner.y - 0.5, y1: inner.y + 1.5 }
        : { x0: inner.x - 0.5, x1: inner.x + 1.5, y0: inner.y, y1: inner.y + 1 };
    } else {
      cx = (inner.x + outer.x) / 2 + 0.5; cy = (inner.y + outer.y) / 2 + 0.5;
      rot = nHoriz ? 90 : 0;
      fp = {
        x0: Math.min(inner.x, outer.x), x1: Math.max(inner.x, outer.x) + 1,
        y0: Math.min(inner.y, outer.y), y1: Math.max(inner.y, outer.y) + 1,
      };
    }
    return { side, heading: nh, oldHeading: h, turned, inner, outer, cx, cy, rot, fp, isDouble };
  }

  /** Posição onde uma peça cairia nessa ponta (sem alterar nada). */
  ghost(side, isDouble) {
    // Mesa vazia: a primeira peça cai no centro (mesma posição de place('start')).
    if (side === 'start') return isDouble ? { cx: 0.5, cy: 0.5, rot: 0 } : { cx: 1, cy: 0.5, rot: 270 };
    return this._next(side, isDouble);
  }

  /** Coloca a peça definitivamente e devolve {id, cx, cy, rot, isDouble, fp}. */
  place(tile, side, innerVal, outerVal) {
    const isDouble = tile.a === tile.b;
    let item;
    if (side === 'start') {
      if (isDouble) {
        item = { cx: 0.5, cy: 0.5, rot: 0, fp: { x0: 0, x1: 1, y0: -0.5, y1: 1.5 } };
        this.arms.left = { end: { x: 0, y: 0 }, heading: 'W', legTiles: 0, lastH: 'W', lastDouble: true };
        this.arms.right = { end: { x: 0, y: 0 }, heading: 'E', legTiles: 0, lastH: 'E', lastDouble: true };
      } else {
        item = { cx: 1, cy: 0.5, rot: 270, fp: { x0: 0, x1: 2, y0: 0, y1: 1 } }; // menor valor à esquerda
        this.arms.left = { end: { x: 0, y: 0 }, heading: 'W', legTiles: 0, lastH: 'W' };
        this.arms.right = { end: { x: 1, y: 0 }, heading: 'E', legTiles: 0, lastH: 'E' };
      }
    } else {
      const n = this._next(side, isDouble);
      if (!n) throw new Error('Ponta inexistente.');
      let rot = n.rot;
      if (!isDouble) {
        const v = DIRS[n.heading];
        rot = innerVal === tile.a ? angleOf({ x: -v.x, y: -v.y }) : angleOf(v);
      }
      item = { cx: n.cx, cy: n.cy, rot, fp: n.fp };
      const arm = this.arms[side];
      arm.end = n.outer;
      arm.heading = n.heading;
      arm.lastDouble = isDouble;
      if (n.turned) {
        arm.legTiles = 1;
        arm.lastH = (n.oldHeading === 'E' || n.oldHeading === 'W') ? n.oldHeading : n.heading;
      } else {
        arm.legTiles++;
      }
    }
    item.id = tile.id; item.tile = tile; item.isDouble = isDouble; item.side = side;
    this.items.push(item);
    return item;
  }

  /** Caixa que envolve as peças e reserva espaço para a próxima peça de cada ponta. */
  bounds() {
    const boxes = this.items.map((i) => i.fp);
    for (const s of ['left', 'right']) { const g = this._next(s, false); if (g) boxes.push(g.fp); }
    if (!boxes.length) return { x0: -1, y0: -1, x1: 3, y1: 2 };
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const f of boxes) { b.x0 = Math.min(b.x0, f.x0); b.y0 = Math.min(b.y0, f.y0); b.x1 = Math.max(b.x1, f.x1); b.y1 = Math.max(b.y1, f.y1); }
    return b;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DominoGame, Match, AI, BoardLayout, shuffle };
}

/* =====================================================================
   A PARTIR DAQUI: APENAS NAVEGADOR
   ===================================================================== */
if (typeof document !== 'undefined' && document.getElementById('app')) {

/* ---------------------------------------------------------------------
   5. ARMAZENAMENTO (localStorage)
   --------------------------------------------------------------------- */
const STORE_KEYS = { settings: 'domino.settings.v1', stats: 'domino.stats.v1', progress: 'domino.progress.v1' };

const DEFAULT_SETTINGS = {
  name: 'Você', p1: 'Jogador 1', p2: 'Jogador 2',
  difficulty: 'medium', theme: 'light', target: 50, draw: true,
  speed: 'normal', sound: true, volume: 60, hints: true, autoPass: true,
};
const DEFAULT_STATS = () => ({
  matches: 0, matchWins: 0, rounds: 0, roundWins: 0, blocks: 0, points: 0, streak: 0, bestStreak: 0,
  byDifficulty: { easy: { played: 0, won: 0 }, medium: { played: 0, won: 0 }, hard: { played: 0, won: 0 } },
});

const Store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* modo privado ou bloqueado */ }
  },
  loadSettings() {
    const s = { ...DEFAULT_SETTINGS, ...Store.read(STORE_KEYS.settings, {}) };
    if (!TILE_THEMES.includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
    // Estilo ainda bloqueado (ex.: progresso apagado)? Volta para o claro.
    if (Store.loadProgress().botWins < THEME_UNLOCK[s.theme]) s.theme = DEFAULT_SETTINGS.theme;
    if (!DIFFICULTY_NAMES[s.difficulty]) s.difficulty = DEFAULT_SETTINGS.difficulty;
    if (![0, 50, 100].includes(Number(s.target))) s.target = DEFAULT_SETTINGS.target;
    s.target = Number(s.target);
    if (!['slow', 'normal', 'fast'].includes(s.speed)) s.speed = 'normal';
    s.name = String(s.name || 'Você').slice(0, 14);
    s.p1 = String(s.p1 || 'Jogador 1').slice(0, 14);
    s.p2 = String(s.p2 || 'Jogador 2').slice(0, 14);
    s.volume = clamp(Number(s.volume) || 0, 0, 100);
    ['draw', 'sound', 'hints', 'autoPass'].forEach((k) => { s[k] = Boolean(s[k]); });
    return s;
  },
  saveSettings(s) { Store.write(STORE_KEYS.settings, s); },
  // Progresso (vitórias contra o bot) fica separado das estatísticas: zerar as
  // estatísticas não bloqueia de novo os estilos de peça já liberados.
  loadProgress() {
    const saved = Store.read(STORE_KEYS.progress, {});
    return { botWins: Math.max(0, Math.floor(Number(saved.botWins) || 0)) };
  },
  saveProgress(p) { Store.write(STORE_KEYS.progress, p); },
  loadStats() {
    const saved = Store.read(STORE_KEYS.stats, {});
    const d = DEFAULT_STATS();
    const out = { ...d, ...saved, byDifficulty: { ...d.byDifficulty, ...(saved.byDifficulty || {}) } };
    for (const k of Object.keys(d.byDifficulty)) out.byDifficulty[k] = { ...d.byDifficulty[k], ...out.byDifficulty[k] };
    return out;
  },
  saveStats(s) { Store.write(STORE_KEYS.stats, s); },
};

/* ---------------------------------------------------------------------
   6. SOM (sintetizado — o pacote de assets não tem áudio)
   --------------------------------------------------------------------- */
const Sound = {
  ctx: null, enabled: true, volume: 0.6,

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (_) { return; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  _gain(vol, t0, dur, attack = 0.005) {
    const g = this.ctx.createGain();
    const v = Math.max(0.0001, vol * this.volume);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(this.ctx.destination);
    return g;
  },

  tone(freq, dur, { type = 'sine', vol = 0.25, delay = 0, slideTo = null } = {}) {
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    o.connect(this._gain(vol, t0, dur));
    o.start(t0); o.stop(t0 + dur + 0.02);
  },

  noise(dur, { vol = 0.3, delay = 0, freq = 2000, q = 1, type = 'bandpass', sweepTo = null } = {}) {
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    src.connect(f); f.connect(this._gain(vol, t0, dur, 0.002));
    src.start(t0); src.stop(t0 + dur + 0.02);
  },

  play(name) {
    if (!this.enabled || this.volume <= 0) return;
    this.unlock();
    if (!this.ctx) return;
    switch (name) {
      case 'place':  // peça batendo na mesa
        this.noise(0.07, { vol: 0.55, freq: 1700, q: 0.9 });
        this.tone(170, 0.11, { type: 'triangle', vol: 0.5, slideTo: 90 });
        break;
      case 'select':
        this.tone(900, 0.05, { type: 'triangle', vol: 0.15 });
        break;
      case 'draw':
        this.noise(0.18, { vol: 0.25, type: 'highpass', freq: 800, sweepTo: 3500 });
        break;
      case 'pass':
        this.tone(440, 0.14, { type: 'sine', vol: 0.2 });
        this.tone(330, 0.2, { type: 'sine', vol: 0.2, delay: 0.12 });
        break;
      case 'turn':
        this.tone(660, 0.09, { type: 'sine', vol: 0.16 });
        this.tone(880, 0.12, { type: 'sine', vol: 0.16, delay: 0.08 });
        break;
      case 'error':
        this.tone(120, 0.16, { type: 'square', vol: 0.12, slideTo: 90 });
        break;
      case 'deal':
        for (let i = 0; i < 4; i++) this.noise(0.05, { vol: 0.3, freq: 1500 + i * 150, q: 0.8, delay: i * 0.07 });
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.28, { type: 'triangle', vol: 0.28, delay: i * 0.13 }));
        this.tone(1318.5, 0.6, { type: 'sine', vol: 0.18, delay: 0.55 });
        break;
      case 'lose':
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.3, { type: 'sine', vol: 0.25, delay: i * 0.16 }));
        break;
      case 'tie':
        this.tone(440, 0.25, { type: 'triangle', vol: 0.22 });
        this.tone(440, 0.25, { type: 'triangle', vol: 0.22, delay: 0.25 });
        break;
      default: break;
    }
  },
};

/* ---------------------------------------------------------------------
   7. INTERFACE
   --------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CELL = 64;      // tamanho de uma célula (px) no espaço interno da mesa; o zoom é aplicado por scale()
const MAX_SCALE = 0.95;

const tileUrl = (theme, a, b) => `${theme}/tile_${Math.min(a, b)}_${Math.max(a, b)}.png`;
const backUrl = (theme) => `${theme}/tile_empty.png`;

const App = {
  settings: Store.loadSettings(),
  stats: Store.loadStats(),
  progress: Store.loadProgress(),   // { botWins } — vitórias contra o bot, libera os estilos de peça
  mode: 'bot',            // 'bot' (jogador 0 contra o computador) | 'pvp' (duas pessoas, mesmo aparelho)
  names: ['Você', BOT_NAMES[1]],
  viewer: 0,              // jogador cuja mão aparece embaixo (sempre 0 contra o bot)
  setupMode: 'bot',       // modo escolhido na tela "Nova partida"
  game: null,
  match: null,
  cfg: null,              // {draw, target, difficulty} fixados no início da partida
  session: 0,             // incrementa a cada rodada/saída para cancelar fluxos assíncronos antigos
  busy: false,
  awaitingHuman: false,
  paused: false,
  selectedId: null,
  inGame: false,
  board: null,
  curtainResolve: null,   // resolve a tela "passe o aparelho" (modo pessoa)
  lastUnlocked: [],       // estilos liberados na última vitória
};

const isHuman = (p) => App.mode === 'pvp' || p === 0;
const nameOf = (p) => App.names[p];
const seatEl = (p) => $(p === App.viewer ? '#seat-me' : '#seat-opp');
const isUnlocked = (theme) => App.progress.botWins >= THEME_UNLOCK[theme];

/* ----- Toast ----- */
let toastTimer = null;
function toast(msg, ms = 1700) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ----- Tema (imagens) ----- */
function preloadTheme(theme) {
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) { const i = new Image(); i.src = tileUrl(theme, a, b); }
  const i = new Image(); i.src = backUrl(theme);
}

function applyTheme() {
  const theme = App.settings.theme;
  document.documentElement.style.setProperty('--back-img', `url("${backUrl(theme)}")`);
  document.body.dataset.tileTheme = theme;
  preloadTheme(theme);
  buildCascade();
  if (App.board) App.board.renderAll();
  if (App.game) { renderHand(); renderSeats(); }
}

/* ----- Menu: dominós caindo em cascata ----- */
function buildCascade() {
  const host = $('#cascade');
  const pairs = [[0, 0], [1, 2], [3, 4], [5, 5], [2, 6], [4, 6], [1, 3], [6, 6], [0, 5], [2, 4]];
  host.innerHTML = '';
  pairs.forEach(([a, b], i) => {
    const d = document.createElement('span');
    d.className = 'piece';
    d.style.setProperty('--i', i);
    d.style.backgroundImage = `url("${tileUrl(App.settings.theme, a, b)}")`;
    host.appendChild(d);
  });
}

/* ---------------------------------------------------------------------
   Animação de voo de peça (jogar na mesa, comprar do monte)
   ---------------------------------------------------------------------
   from / to: { x, y, w, h, rot } — centro, tamanho e giro (graus) da peça.
   mode: 'front' (mostra a face), 'back' (mostra o verso) ou 'flip' (começa
   virada e desvira durante o voo — usado quando o adversário joga).
   --------------------------------------------------------------------- */
const boxAt = (r, w, h, rot = 0) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, w, h, rot });

function flyTile({ face, from, to, mode = 'front', duration = 640 }) {
  return new Promise((resolve) => {
    if (REDUCED_MOTION) { resolve(); return; }
    const fl = document.createElement('div');
    fl.className = 'flier';
    fl.style.left = `${to.x - to.w / 2}px`;
    fl.style.top = `${to.y - to.h / 2}px`;
    fl.style.width = `${to.w}px`;
    fl.style.height = `${to.h}px`;
    fl.innerHTML = '<div class="flip"><i class="face front"></i><i class="face back"></i></div>';
    $('.face.front', fl).style.backgroundImage = face;
    const flip = $('.flip', fl);
    flip.style.transform = mode === 'front' ? 'rotateY(0deg)' : 'rotateY(180deg)';
    $('#fx-layer').appendChild(fl);

    const dx = from.x - to.x, dy = from.y - to.y;
    const k = clamp(from.w / to.w, 0.15, 3);
    const r0 = from.rot || 0;
    let r1 = (to.rot || 0) % 360;
    if (r1 > 180) r1 -= 360;
    if (r1 <= -180) r1 += 360;
    const lift = clamp(Math.hypot(dx, dy) * 0.14, 26, 70);   // a peça sobe em arco antes de pousar
    const midScale = (k + (1 - k) * 0.6) * 1.1;

    let done = false;
    const end = () => { if (done) return; done = true; fl.remove(); resolve(); };
    const anim = fl.animate([
      { transform: `translate(${dx}px, ${dy}px) rotate(${r0}deg) scale(${k})`, offset: 0 },
      { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - lift}px) rotate(${r0 + (r1 - r0) * 0.55}deg) scale(${midScale})`, offset: 0.55 },
      { transform: `translate(0px, 0px) rotate(${r1}deg) scale(1)`, offset: 1 },
    ], { duration, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
    anim.onfinish = end;
    anim.oncancel = end;
    if (mode === 'flip') {
      flip.animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }],
        { duration: duration * 0.7, easing: 'ease-in-out', fill: 'forwards' });
    }
  });
}

/* ---------------------------------------------------------------------
   BoardView — desenha a mesa a partir do BoardLayout
   --------------------------------------------------------------------- */
class BoardView {
  constructor(el) {
    this.el = el;
    this.origin = $('.board-origin', el);
    this.anchor = $('#board-anchor', el);
    this.hint = $('#board-hint', el);
    this.layout = new BoardLayout(this.limits());
    this.events = [];          // jogadas já feitas (para reconstruir o layout)
    this.slots = [];
    this.scale = 1;
    this.center = { x: 1, y: 0.5 };
  }

  limits() {
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 400;
    const narrow = w < 560 || w / h < 0.95;
    return narrow ? { limE: 3, limW: -2, vertTiles: 2 } : { limE: 6, limW: -5, vertTiles: 2 };
  }

  reset() {
    this.events = [];
    this.layout = new BoardLayout(this.limits());
    this.anchor.innerHTML = '';
    this.slots = [];
    this.hint.hidden = false;
    this.fit();
  }

  /** Reconstrói tudo (troca de tema ou de orientação). */
  renderAll() {
    this.anchor.innerHTML = '';
    this.slots = [];
    this.layout = new BoardLayout(this.limits());
    let last = null;
    for (const ev of this.events) {
      const item = this.layout.place(ev.tile, ev.side, ev.inner, ev.outer);
      last = this._makeEl(item);
      this.anchor.appendChild(last);
    }
    if (last) last.classList.add('last');
    this.hint.hidden = this.events.length > 0;
    this.fit();
  }

  onResize() {
    const lim = this.limits();
    const cur = this.layout;
    if (lim.limE !== cur.limE || lim.limW !== cur.limW) this.renderAll(); else this.fit();
  }

  _place(el, item) {
    el.style.left = `${(item.cx - 0.5) * CELL}px`;
    el.style.top = `${(item.cy - 1) * CELL}px`;
    el.style.width = `${CELL}px`;
    el.style.height = `${CELL * 2}px`;
    el.style.transform = `rotate(${item.rot}deg)`;
  }

  _makeEl(item) {
    const el = document.createElement('div');
    el.className = 'tile board-tile' + (item.isDouble ? ' is-double' : '');
    el.style.backgroundImage = `url("${tileUrl(App.settings.theme, item.tile.a, item.tile.b)}")`;
    el.dataset.id = item.id;
    this._place(el, item);
    return el;
  }

  fit() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    const b = this.layout.bounds();
    const bw = (b.x1 - b.x0) * CELL, bh = (b.y1 - b.y0) * CELL;
    const pad = w < 560 ? 10 : 28;
    const chips = 34;      // folga embaixo para os rótulos "Monte" e "Pontas"
    this.scale = clamp(Math.min((w - pad * 2) / bw, (h - pad * 2 - chips) / bh), 0.12, MAX_SCALE);
    this.center = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    this.anchor.style.transform = `scale(${this.scale}) translate(${-this.center.x * CELL}px, ${-this.center.y * CELL}px)`;
  }

  /** Adiciona a peça na mesa e anima o voo a partir de fromRect (DOMRect ou null).
   *  opts.flip: a peça sai virada (adversário) e desvira durante o voo. */
  addTile(ev, fromRect, opts = {}) {
    const item = this.layout.place(ev.tile, ev.side, ev.inner, ev.outer);
    this.events.push(ev);
    this.hint.hidden = true;
    const el = this._makeEl(item);
    el.style.visibility = 'hidden';
    this.anchor.appendChild(el);
    this.fit();
    return this._fly(item, el, fromRect, opts);
  }

  _fly(item, el, fromRect, { flip = false } = {}) {
    return new Promise((resolve) => {
      const o = this.origin.getBoundingClientRect();
      const tx = o.left + (item.cx - this.center.x) * CELL * this.scale;
      const ty = o.top + (item.cy - this.center.y) * CELL * this.scale;
      const w = CELL * this.scale, h = CELL * 2 * this.scale;
      const finish = () => { el.style.visibility = ''; this._land(el, tx, ty, w, h); resolve(); };
      if (REDUCED_MOTION) { finish(); return; }

      const from = fromRect
        ? boxAt(fromRect, fromRect.width, fromRect.height)
        : { x: o.left, y: o.top, w: w * 0.4, h: h * 0.4, rot: 0 };
      const to = { x: tx, y: ty, w, h, rot: item.rot };
      flyTile({
        face: el.style.backgroundImage, from, to,
        mode: flip ? 'flip' : 'front', duration: 640,
      }).then(finish);
    });
  }

  /** Pouso: quica, brilha, faz uma onda na mesa e toca o som. */
  _land(el, x, y, w, h) {
    $$('.board-tile.last', this.anchor).forEach((t) => t.classList.remove('last', 'landed'));
    el.classList.add('last', 'landed');
    Sound.play('place');
    if (REDUCED_MOTION) return;
    const ring = document.createElement('div');
    ring.className = 'thud';
    const d = Math.max(w, h) * 0.9;
    ring.style.left = `${x}px`; ring.style.top = `${y}px`;
    ring.style.width = `${d}px`; ring.style.height = `${d}px`;
    $('#fx-layer').appendChild(ring);
    setTimeout(() => ring.remove(), 650);
    this.el.classList.remove('bump'); void this.el.offsetWidth; this.el.classList.add('bump');
    setTimeout(() => this.el.classList.remove('bump'), 260);
  }

  /* ----- Encaixes (slots) onde a peça pode ser jogada ----- */
  showSlots(options) {   // options: [{side, tile, onPick}]
    this.clearSlots();
    for (const o of options) {
      const g = this.layout.ghost(o.side, o.tile.a === o.tile.b);
      if (!g) continue;
      const isStart = o.side === 'start';
      const endVal = isStart ? '' : App.game.ends[o.side];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'slot';
      el.dataset.side = o.side;
      el.setAttribute('aria-label', isStart ? 'Abrir a rodada no centro da mesa' : `Jogar na ponta ${o.side === 'left' ? 'esquerda' : 'direita'}, número ${endVal}`);
      el.style.left = `${(g.cx - 0.5) * CELL}px`;
      el.style.top = `${(g.cy - 1) * CELL}px`;
      el.style.width = `${CELL}px`;
      el.style.height = `${CELL * 2}px`;
      el.style.transform = `rotate(${g.rot}deg)`;
      el.innerHTML = `<span class="slot-num" style="transform:rotate(${-g.rot}deg)">${endVal}</span>`;
      el.addEventListener('click', (e) => e.stopPropagation());   // encaixes só recebem peça arrastada
      this.anchor.appendChild(el);
      this.slots.push({ el, side: o.side });
    }
  }

  clearSlots() { this.slots.forEach((s) => s.el.remove()); this.slots = []; }

  nearestSlot(x, y) {
    let best = null, bd = Infinity;
    for (const s of this.slots) {
      const r = s.el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  hotSlot(side) { this.slots.forEach((s) => s.el.classList.toggle('hot', s.side === side)); }
}

/* ----- Renderização: mão de quem está jogando (viewer) ----- */
function legalByTile(game) {
  const map = new Map();
  if (!game || game.status !== 'playing' || game.current !== App.viewer || !isHuman(game.current)) return map;
  for (const m of game.legalMoves(App.viewer)) {
    if (!map.has(m.tile.id)) map.set(m.tile.id, []);
    map.get(m.tile.id).push(m.side);
  }
  return map;
}

function renderHand({ deal = false, newIds = [], arriving = null } = {}) {
  const hand = $('#hand');
  const g = App.game;
  hand.innerHTML = '';
  hand.classList.remove('concealed');
  if (!g) return;
  const legal = App.awaitingHuman ? legalByTile(g) : new Map();
  const showHints = App.settings.hints && App.awaitingHuman;
  g.hands[App.viewer].forEach((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile hand-tile';
    b.dataset.id = t.id;
    b.style.backgroundImage = `url("${tileUrl(App.settings.theme, t.a, t.b)}")`;
    b.setAttribute('aria-label', `Peça ${t.a} e ${t.b}`);
    if (showHints) b.classList.add(legal.has(t.id) ? 'playable' : 'dim');
    if (App.selectedId === t.id) b.classList.add('selected');
    if (deal) { b.classList.add('deal'); b.style.setProperty('--i', i); }
    if (newIds.includes(t.id) && arriving !== t.id) b.classList.add('drawn');
    hand.appendChild(b);
  });
}

/** Guarda as posições das peças da mão para animar o reacomodo (FLIP). */
function snapshotHand() {
  const m = new Map();
  $$('.hand-tile').forEach((b) => m.set(b.dataset.id, b.getBoundingClientRect()));
  return m;
}

function animateHandReflow(prev) {
  if (REDUCED_MOTION) return;
  $$('.hand-tile').forEach((b) => {
    const o = prev.get(b.dataset.id);
    if (!o) return;
    const n = b.getBoundingClientRect();
    const dx = o.left - n.left, dy = o.top - n.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    b.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }],
      { duration: 300, easing: 'cubic-bezier(.3,.7,.3,1)' });
  });
}

/* ----- Renderização: assentos (embaixo = viewer, em cima = o outro jogador) ----- */
function fillSeat(seat, p) {
  const g = App.game, m = App.match;
  const name = nameOf(p);
  seat.dataset.player = p;
  $('.seat-name', seat).textContent = name;
  $('.seat-score b', seat).textContent = m.scores[p];
  $('.seat-count', seat).textContent = g.hands[p].length;
  const av = $('.seat-avatar', seat);
  av.textContent = name.trim().charAt(0).toUpperCase() || '?';
  av.dataset.p = p;
  seat.classList.toggle('is-active', g.status === 'playing' && g.current === p);
}

function renderSeats() {
  const g = App.game, m = App.match;
  if (!g || !m) return;
  const me = App.viewer, opp = 1 - me;
  fillSeat($('#seat-me'), me);
  const oppSeat = $('#seat-opp');
  fillSeat(oppSeat, opp);
  const hh = $('.seat-hand', oppSeat);
  const count = g.hands[opp].length;
  if (hh.children.length !== count) {
    hh.innerHTML = '';
    for (let i = 0; i < count; i++) { const s = document.createElement('span'); s.className = 'back'; hh.appendChild(s); }
    fitOppHand(hh);
  }
  $('#boneyard-count').textContent = g.boneyard.length;
  $('#boneyard-chip').hidden = !g.drawEnabled;
  $('#end-left').textContent = g.ends.left === null ? '–' : g.ends.left;
  $('#end-right').textContent = g.ends.right === null ? '–' : g.ends.right;
  $('#ends-chip').hidden = g.ends.left === null;
  $('#round-label').textContent = `Rodada ${m.round}`;
  $('#target-label').textContent = m.target === 0 ? 'Rodada única' : `Meta: ${m.target} pontos`;
}

/** Com muitas peças (compra), as peças viradas se sobrepõem para a mão não ficar larga demais. */
function fitOppHand(hh) {
  const n = hh.children.length;
  hh.style.setProperty('--ov', 0);
  if (n < 2) return;
  const bw = hh.children[0].offsetWidth || 14;
  const maxW = Math.min(window.innerWidth * (window.innerWidth <= 720 ? 0.4 : 0.35), 300);
  const total = n * bw;
  if (total > maxW) hh.style.setProperty('--ov', ((total - maxW) / (n - 1)).toFixed(2));
}

function bubble(p, text, ms = 1400) {
  const b = $('.seat-bubble', seatEl(p));
  b.textContent = text;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), ms);
}

function setBanner(text, tone = '') {
  const b = $('#turn-banner');
  b.textContent = text;
  b.dataset.tone = tone;
}

function updateActions() {
  const g = App.game;
  const p = App.viewer;
  const my = App.awaitingHuman && g && g.status === 'playing' && g.current === p && isHuman(p);
  const draw = $('#btn-draw'), pass = $('#btn-pass');
  draw.hidden = !(my && g.canDraw(p));
  draw.textContent = `Comprar peça (${g ? g.boneyard.length : 0})`;
  pass.hidden = !(my && g.canPass(p));
  $('#hand').classList.toggle('my-turn', Boolean(my));
}

/* ----- Seleção e arrastar ----- */
function clearSelection() {
  App.selectedId = null;
  if (App.board) App.board.clearSlots();
  $$('.hand-tile.selected').forEach((b) => b.classList.remove('selected'));
}

function humanCanAct() {
  const g = App.game;
  return g && g.status === 'playing' && isHuman(g.current) && g.current === App.viewer &&
    App.awaitingHuman && !App.busy && !App.paused;
}

function movesForTile(id) { return App.game.legalMoves(App.viewer).filter((m) => m.tile.id === id); }

// Clique simples NÃO joga mais a peça: é preciso arrastá-la até a mesa.
// Aqui só damos o feedback (aviso, ou "chacoalhar" se a peça não encaixa).
function onTileClick(btn) {
  if (!humanCanAct()) return;
  const moves = movesForTile(btn.dataset.id);
  if (moves.length === 0) {
    Sound.play('error');
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    const g = App.game;
    if (g.placed.length === 0 && g.openingTile) toast(`Abra a rodada com a peça ${g.openingTile.a}–${g.openingTile.b}.`);
    else toast('Essa peça não encaixa em nenhuma ponta.');
    return;
  }
  toast('Arraste a peça até a mesa para jogar.');
}

let drag = null;

function onHandPointerDown(e) {
  const btn = e.target.closest('.hand-tile');
  if (!btn || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (!humanCanAct()) return;
  Sound.unlock();
  drag = { btn, id: btn.dataset.id, x0: e.clientX, y0: e.clientY, active: false, clone: null, pointerType: e.pointerType };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragCancel);
}

function startDrag(e) {
  const moves = movesForTile(drag.id);
  if (!moves.length) return false;
  clearSelection();
  const r = drag.btn.getBoundingClientRect();
  const c = document.createElement('div');
  c.className = 'tile drag-ghost';
  c.style.backgroundImage = drag.btn.style.backgroundImage;
  c.style.width = `${r.width}px`;
  c.style.height = `${r.height}px`;
  $('#fx-layer').appendChild(c);
  drag.clone = c;
  drag.active = true;
  drag.btn.classList.add('dragging');
  const tile = moves[0].tile;
  App.board.showSlots(moves.map((m) => ({ side: m.side, tile, onPick: () => {} })));
  Sound.play('select');
  return true;
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.active) {
    const dist = Math.hypot(dx, dy);
    if (dist < 8) return;
    // No toque, movimento horizontal rola a mão; só arrasta se for para cima/diagonal.
    if (drag.pointerType === 'touch' && Math.abs(dx) > Math.abs(dy) * 1.2) { cleanupDrag(); return; }
    if (!startDrag(e)) return;
  }
  e.preventDefault();
  drag.clone.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%) rotate(6deg) scale(1.08)`;
  const inBoard = pointInBoard(e.clientX, e.clientY);
  const s = inBoard ? App.board.nearestSlot(e.clientX, e.clientY) : null;
  App.board.hotSlot(s ? s.side : null);
}

function pointInBoard(x, y) {
  const r = App.board.el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function onDragEnd(e) {
  if (!drag) return;
  const d = drag;
  if (!d.active) {                       // foi só um clique/toque
    cleanupDrag();
    onTileClick(d.btn);
    return;
  }
  const inBoard = pointInBoard(e.clientX, e.clientY);
  const slot = inBoard ? App.board.nearestSlot(e.clientX, e.clientY) : null;
  const rect = d.clone.getBoundingClientRect();
  const id = d.id;
  cleanupDrag();
  if (slot) {
    playHuman(id, slot.side, rect);
  } else {
    App.board.clearSlots();
    if (inBoard) { Sound.play('error'); toast('Solte a peça sobre um encaixe.'); }
  }
}

function onDragCancel() { cleanupDrag(); if (App.board) App.board.clearSlots(); }

function cleanupDrag() {
  if (drag) {
    if (drag.clone) drag.clone.remove();
    drag.btn.classList.remove('dragging');
  }
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragCancel);
  if (App.board) App.board.hotSlot(null);
}

/* ----- Diálogos ----- */
function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
  syncPaused();
  return d;
}

function syncPaused() {
  const any = ['#modal-pause', '#modal-howto', '#modal-settings', '#modal-stats', '#modal-confirm', '#modal-newgame', '#modal-skins']
    .some((s) => $(s).open);
  App.paused = App.inGame && any;
}

function askConfirm(text, yesLabel = 'Confirmar') {
  return new Promise((resolve) => {
    const d = $('#modal-confirm');
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yesLabel;
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); cleanup(); resolve(v); };
    const yes = () => finish(true), no = () => finish(false);
    const cleanup = () => {
      $('#confirm-yes').removeEventListener('click', yes);
      $('#confirm-no').removeEventListener('click', no);
      d.removeEventListener('cancel', no);
    };
    $('#confirm-yes').addEventListener('click', yes);
    $('#confirm-no').addEventListener('click', no);
    d.addEventListener('cancel', no);
    openDialog('#modal-confirm');
  });
}

/* ----- Passe o aparelho (modo pessoa) ----- */
function handoff(p) {
  return new Promise((resolve) => {
    const c = $('#curtain');
    $('#curtain-name').textContent = nameOf(p);
    c.hidden = false;
    $('#curtain-ready').focus({ preventScroll: true });
    App.curtainResolve = (ok) => { App.curtainResolve = null; c.hidden = true; resolve(ok); };
  });
}

function cancelCurtain() {
  if (App.curtainResolve) App.curtainResolve(false);
  $('#curtain').hidden = true;
}

/* ----- Configurações (formulário) ----- */
function setRadio(name, value) {
  $$(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === String(value); });
}

function syncSettingsForm() {
  const s = App.settings;
  $('#set-name').value = s.name;
  $('#set-p1').value = s.p1;
  $('#set-p2').value = s.p2;
  setRadio('set-diff', s.difficulty);
  setRadio('set-target', s.target);
  setRadio('set-draw', s.draw ? 1 : 0);
  setRadio('set-speed', s.speed);
  $('#set-hints').checked = s.hints;
  $('#set-autopass').checked = s.autoPass;
  $('#set-sound').checked = s.sound;
  $('#set-volume').value = s.volume;
  updateSoundButton();
}

function updateSoundButton() {
  const on = App.settings.sound && App.settings.volume > 0;
  const b = $('#btn-sound');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'Som ligado' : 'Som desligado');
  b.classList.toggle('is-off', !on);
}

function applySound() {
  Sound.enabled = App.settings.sound;
  Sound.volume = App.settings.volume / 100;
  updateSoundButton();
}

function commitSettings() {
  Store.saveSettings(App.settings);
  applySound();
  if (App.game && App.inGame) { renderSeats(); updateActions(); }
}

function bindSettings() {
  const s = App.settings;
  const nameInput = (id, key, fallback) => $(id).addEventListener('input', (e) => {
    s[key] = e.target.value.trim().slice(0, 14) || fallback;
    commitSettings();
  });
  nameInput('#set-name', 'name', 'Você');
  nameInput('#set-p1', 'p1', 'Jogador 1');
  nameInput('#set-p2', 'p2', 'Jogador 2');
  const radio = (name, fn) => $$(`input[name="${name}"]`).forEach((r) => r.addEventListener('change', () => { if (r.checked) { fn(r.value); commitSettings(); syncSettingsForm(); } }));
  radio('set-diff', (v) => { s.difficulty = v; });
  radio('set-target', (v) => { s.target = Number(v); });
  radio('set-draw', (v) => { s.draw = v === '1'; });
  radio('set-speed', (v) => { s.speed = v; });
  $('#set-hints').addEventListener('change', (e) => { s.hints = e.target.checked; commitSettings(); });
  $('#set-autopass').addEventListener('change', (e) => { s.autoPass = e.target.checked; commitSettings(); });
  $('#set-sound').addEventListener('change', (e) => { s.sound = e.target.checked; commitSettings(); Sound.play('select'); });
  $('#set-volume').addEventListener('input', (e) => { s.volume = Number(e.target.value); commitSettings(); });
  $('#set-volume').addEventListener('change', () => Sound.play('place'));
  $('#btn-reset-all').addEventListener('click', async () => {
    if (!(await askConfirm('Restaurar todas as configurações para o padrão? Suas estatísticas e as peças desbloqueadas são mantidas.', 'Restaurar'))) return;
    Object.assign(s, DEFAULT_SETTINGS, { theme: s.theme });
    commitSettings(); syncSettingsForm();
    toast('Configurações restauradas.');
  });
}

/* ----- Nova partida: escolher modo e ajustes (depois do botão Jogar) ----- */
function showNewGameStep(step) {
  const setup = step === 'setup';
  $('#ng-step-mode').hidden = setup;
  $('#ng-step-setup').hidden = !setup;
  $('#newgame-title').textContent = !setup ? 'Nova partida' : (App.setupMode === 'bot' ? 'Contra o bot' : 'Contra uma pessoa');
  $$('#ng-step-setup [data-only]').forEach((el) => { el.hidden = el.dataset.only !== App.setupMode; });
  $('#newgame-body').scrollTop = 0;
}

function openNewGame() {
  syncSettingsForm();
  showNewGameStep('mode');
  openDialog('#modal-newgame');
}

function bindNewGame() {
  $$('.mode-card').forEach((b) => b.addEventListener('click', () => {
    Sound.unlock();
    Sound.play('select');
    App.setupMode = b.dataset.mode;
    showNewGameStep('setup');
  }));
  $('#ng-back').addEventListener('click', () => showNewGameStep('mode'));
  $('#ng-start').addEventListener('click', () => {
    Sound.unlock();
    $('#modal-newgame').close();
    startMatch(App.setupMode);
  });
}

/* ----- Peças (estilos) com desbloqueio por vitórias contra o bot ----- */
const LOCK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 10V8a5 5 0 0110 0v2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><rect x="5" y="10" width="14" height="10" rx="2.5" fill="currentColor"/></svg>';
const SKINS_HINT = 'Vença partidas contra o bot para liberar novos estilos de peça.';

function renderSkins(msg = SKINS_HINT) {
  const wins = App.progress.botWins;
  $('#skins-wins').textContent = wins;
  $('#skins-hint').textContent = msg;
  const host = $('#skins-grid');
  host.innerHTML = '';
  TILE_THEMES.forEach((t) => {
    const need = THEME_UNLOCK[t];
    const open = wins >= need;
    const selected = App.settings.theme === t;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'skin-card' + (open ? '' : ' is-locked') + (selected ? ' is-selected' : '');
    b.dataset.theme = t;
    b.setAttribute('aria-pressed', String(selected));
    b.setAttribute('aria-label', open
      ? `${THEME_NAMES[t]}${selected ? ', em uso' : ''}`
      : `${THEME_NAMES[t]}, bloqueado: precisa de ${need} vitórias contra o bot`);
    const sub = selected ? 'Em uso' : open ? 'Liberado' : `${wins}/${need} vitórias`;
    const bar = open ? '' : `<span class="skin-bar"><i style="width:${Math.round((wins / need) * 100)}%"></i></span>`;
    b.innerHTML = `<span class="skin-prev" style="background-image:url('${tileUrl(t, 2, 5)}')"></span>` +
      `${open ? '' : `<span class="skin-lock">${LOCK_SVG}</span>`}` +
      `<span class="skin-name">${THEME_NAMES[t]}</span><span class="skin-sub">${sub}</span>${bar}`;
    host.appendChild(b);
  });
}

function bindSkins() {
  $('#skins-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.skin-card');
    if (!b) return;
    const t = b.dataset.theme;
    if (!isUnlocked(t)) {
      const left = THEME_UNLOCK[t] - App.progress.botWins;
      Sound.play('error');
      renderSkins(`Faltam ${left} vitória${left === 1 ? '' : 's'} contra o bot para liberar o estilo ${THEME_NAMES[t]}.`);
      const again = $(`.skin-card[data-theme="${t}"]`);
      if (again) { again.classList.add('shake'); }
      return;
    }
    App.settings.theme = t;
    commitSettings();
    applyTheme();
    renderSkins();
    Sound.play('select');
  });
}

/* ----- Estatísticas (diálogo) ----- */
function renderStats() {
  const s = App.stats;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const rows = [
    ['Partidas jogadas', s.matches], ['Partidas vencidas', s.matchWins], ['Aproveitamento', pct(s.matchWins, s.matches)],
    ['Rodadas jogadas', s.rounds], ['Rodadas vencidas', s.roundWins], ['Jogos fechados', s.blocks],
    ['Pontos conquistados', s.points], ['Vitórias seguidas', s.streak], ['Melhor sequência', s.bestStreak],
  ];
  $('#stats-grid').innerHTML = rows.map(([k, v]) => `<div class="stat"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#stats-diff tbody').innerHTML = Object.keys(DIFFICULTY_NAMES).map((k) => {
    const d = s.byDifficulty[k];
    return `<tr><th scope="row">${DIFFICULTY_NAMES[k]}</th><td>${d.played}</td><td>${d.won}</td><td>${pct(d.won, d.played)}</td></tr>`;
  }).join('');
}

/* ---------------------------------------------------------------------
   8. CONTROLADOR DA PARTIDA
   --------------------------------------------------------------------- */
const SPEEDS = { slow: 1700, normal: 1000, fast: 450 };

/** sleep que congela enquanto a partida está pausada. */
async function gsleep(ms) {
  await sleep(ms);
  while (App.paused) await sleep(120);
}

const botDelay = () => SPEEDS[App.settings.speed] * (0.75 + Math.random() * 0.5);
const turnLabel = (p) => (App.mode === 'pvp' ? `Vez de ${nameOf(p)}` : 'Sua vez');

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
}

function startMatch(mode = App.mode) {
  App.session++;
  cancelCurtain();
  App.mode = mode;
  const s = App.settings;
  if (mode === 'pvp') {
    const p2 = s.p2.trim().toLowerCase() === s.p1.trim().toLowerCase() ? `${s.p2} 2` : s.p2;
    App.names = [s.p1, p2];
  } else {
    App.names = [s.name, BOT_NAMES[1]];
  }
  App.cfg = { draw: s.draw, target: s.target, difficulty: s.difficulty };
  App.match = new Match({ target: App.cfg.target, players: PLAYER_COUNT });
  App.inGame = true;
  App.viewer = 0;
  showScreen('screen-game');
  startRound();
}

function startRound() {
  const token = ++App.session;
  const m = App.match;
  cancelCurtain();
  App.game = new DominoGame({ players: PLAYER_COUNT, drawEnabled: App.cfg.draw });
  App.game.startRound({ starter: m.nextStarter });
  App.busy = true;
  App.awaitingHuman = false;
  App.viewer = App.mode === 'pvp' ? App.game.current : 0;
  clearSelection();
  $$('.seat-hand').forEach((h) => { h.innerHTML = ''; });
  requestAnimationFrame(async () => {
    if (token !== App.session) return;
    App.board.reset();
    renderSeats();
    $('#hand').innerHTML = '';
    updateActions();
    const g = App.game;
    if (g.openingTile) {
      const t = g.openingTile;
      setBanner(`${nameOf(g.current)} abre com ${t.a}–${t.b}`, 'info');
    } else {
      setBanner(`${nameOf(g.current)} abre a rodada`, 'info');
    }
    if (App.mode === 'pvp') {
      // As peças só aparecem depois que o jogador da vez pegar o aparelho.
      const ok = await handoff(g.current);
      if (!ok || token !== App.session) return;
    }
    renderHand({ deal: true });
    updateActions();
    Sound.play('deal');
    await gsleep(1100);
    if (token !== App.session) return;
    App.busy = false;
    nextTurn();
  });
}

async function nextTurn() {
  const token = App.session;
  const g = App.game;
  if (!g || g.status !== 'playing') return;
  const p = g.current;
  if (isHuman(p)) {
    if (App.viewer !== p) {            // modo pessoa: troca de jogador → esconde a mão e pede para passar o aparelho
      App.busy = true;
      App.awaitingHuman = false;
      $('#hand').classList.add('concealed');
      renderSeats();
      updateActions();
      setBanner(`Vez de ${nameOf(p)}`, 'info');
      await gsleep(650);
      if (token !== App.session) return;
      const ok = await handoff(p);
      if (!ok || token !== App.session) return;
      App.viewer = p;
      App.busy = false;
    }
    renderSeats();
    return humanTurn(token);
  }
  renderSeats();
  return botTurn(p, token);
}

async function humanTurn(token) {
  const g = App.game;
  const p = App.viewer;
  const pv = App.mode === 'pvp';
  App.awaitingHuman = true;
  App.busy = false;
  clearSelection();
  const moves = g.legalMoves(p);
  renderHand();
  updateActions();
  Sound.play('turn');

  if (moves.length > 0) {
    if (g.placed.length === 0 && g.openingTile) setBanner(`${turnLabel(p)}: abra com ${g.openingTile.a}–${g.openingTile.b}`, 'you');
    else if (g.placed.length === 0) setBanner(`${turnLabel(p)}: jogue qualquer peça`, 'you');
    else setBanner(turnLabel(p), 'you');
    return;
  }
  if (g.canDraw(p)) { setBanner('Sem jogada. Compre uma peça.', 'you'); return; }
  // Sem jogada e sem monte: passar.
  if (App.settings.autoPass) {
    setBanner(pv ? `${nameOf(p)} está sem jogada e passa a vez.` : 'Sem jogada. Você passa a vez.', 'you');
    App.awaitingHuman = false; updateActions();
    await gsleep(1200);
    if (token !== App.session) return;
    await doPass(p);
  } else {
    setBanner('Sem jogada. Passe a vez.', 'you');
  }
}

/** Retângulo (20×40) de uma peça virada na mão do adversário — origem do voo quando ele joga. */
function oppHandRect(seat) {
  const backs = $$('.seat-hand .back', seat);
  if (backs.length) {
    const b = backs[Math.floor(backs.length / 2)];
    const r = b.getBoundingClientRect();
    if (r.width > 0) {
      const h = r.height, w = h / 2;
      return { left: r.left + r.width / 2 - w / 2, top: r.top, width: w, height: h };
    }
  }
  return $('.seat-avatar', seat).getBoundingClientRect();
}

/** Compra do adversário: a peça voa do monte até a mão dele (virada). */
async function flyDrawToOpp(chipRect, seat) {
  const backs = $$('.seat-hand .back', seat);
  const last = backs[backs.length - 1];
  if (!last || REDUCED_MOTION) return;
  const r = last.getBoundingClientRect();
  if (!r.width) return;
  const h = r.height, w = h / 2;
  last.style.visibility = 'hidden';
  await flyTile({
    face: 'none', mode: 'back', duration: 520,
    from: boxAt(chipRect, w, h), to: boxAt(r, w, h),
  });
  last.style.visibility = '';
}

async function botTurn(p, token) {
  const g = App.game;
  App.busy = true;
  App.awaitingHuman = false;
  updateActions();
  setBanner(`Vez de ${nameOf(p)}`, 'bot');
  const seat = seatEl(p);
  seat.classList.add('thinking');
  await gsleep(botDelay());
  if (token !== App.session) return;

  while (g.canDraw(p)) {
    const chip = $('#boneyard-chip').getBoundingClientRect();
    g.draw(p);
    Sound.play('draw');
    bubble(p, 'Comprou', 900);
    renderSeats();
    await flyDrawToOpp(chip, seat);
    await gsleep(Math.max(250, SPEEDS[App.settings.speed] * 0.3));
    if (token !== App.session) return;
  }
  seat.classList.remove('thinking');

  const move = AI.choose(g, p, App.cfg.difficulty);
  if (!move) { await doPass(p); return; }
  await doPlay(p, move.tile.id, move.side, oppHandRect(seat));
}

function playHuman(tileId, side, fromRect) {
  if (!humanCanAct()) return;
  App.awaitingHuman = false;
  clearSelection();
  doPlay(App.viewer, tileId, side, fromRect);
}

async function doPlay(p, tileId, side, fromRect) {
  const token = App.session;
  const g = App.game;
  const flip = p !== App.viewer;     // jogada do adversário: a peça desvira no voo
  let ev;
  try { ev = g.play(p, tileId, side); }
  catch (err) { console.error(err); App.busy = false; if (isHuman(p)) { App.awaitingHuman = true; renderHand(); } return; }

  App.busy = true;
  App.awaitingHuman = false;
  $$('.seat').forEach((s) => s.classList.remove('thinking'));
  const prev = flip ? null : snapshotHand();
  renderHand();
  if (prev) animateHandReflow(prev);
  renderSeats();
  updateActions();
  await App.board.addTile(ev, fromRect, { flip });
  if (token !== App.session) return;
  renderSeats();

  if (ev.roundOver) { await endRound(ev.result); return; }
  App.busy = false;
  nextTurn();
}

async function doPass(p) {
  const token = App.session;
  const g = App.game;
  let ev;
  try { ev = g.pass(p); } catch (err) { console.error(err); return; }
  App.awaitingHuman = false;
  App.busy = true;
  Sound.play('pass');
  bubble(p, 'Passou');
  toast(App.mode === 'bot' && p === 0 ? 'Você passou a vez.' : `${nameOf(p)} passou.`);
  $$('.seat').forEach((s) => s.classList.remove('thinking'));
  renderSeats(); updateActions();
  await gsleep(750);
  if (token !== App.session) return;
  if (ev.roundOver) { await endRound(ev.result); return; }
  App.busy = false;
  nextTurn();
}

async function onDrawClick() {
  const token = App.session;
  const g = App.game;
  const p = App.viewer;
  if (!humanCanAct() || !g.canDraw(p)) return;
  App.awaitingHuman = false;
  const chip = $('#boneyard-chip').getBoundingClientRect();
  const tile = g.draw(p);
  Sound.play('draw');
  renderHand({ newIds: [tile.id], arriving: tile.id });
  renderSeats(); updateActions();
  const el = $(`.hand-tile[data-id="${tile.id}"]`);
  if (el && !REDUCED_MOTION) {
    // A peça comprada voa do monte até a mão, desvirando no caminho.
    el.style.visibility = 'hidden';
    const r = el.getBoundingClientRect();
    await flyTile({
      face: `url("${tileUrl(App.settings.theme, tile.a, tile.b)}")`, mode: 'flip', duration: 560,
      from: boxAt(chip, r.width * 0.5, r.height * 0.5), to: boxAt(r, r.width, r.height),
    });
    el.style.visibility = '';
  }
  await gsleep(150);
  if (token !== App.session) return;
  humanTurn(token);
}

function onPassClick() {
  if (!humanCanAct() || !App.game.canPass(App.viewer)) return;
  App.awaitingHuman = false;
  updateActions();
  doPass(App.viewer);
}

/* ----- Fim da rodada / partida ----- */
/** Só partidas contra o bot contam para estatísticas e desbloqueios. Devolve os estilos recém-liberados. */
function recordRoundStats(result, matchOver) {
  if (App.mode !== 'bot') return [];
  const s = App.stats, m = App.match;
  s.rounds++;
  if (result.winner === 0) { s.roundWins++; s.points += result.points; }
  if (result.reason === 'blocked') s.blocks++;
  let unlocked = [];
  if (matchOver) {
    s.matches++;
    const d = s.byDifficulty[App.cfg.difficulty];
    d.played++;
    if (m.winner === 0) {
      s.matchWins++; d.won++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
      const before = App.progress.botWins;
      App.progress.botWins = before + 1;
      unlocked = TILE_THEMES.filter((t) => THEME_UNLOCK[t] > before && THEME_UNLOCK[t] <= App.progress.botWins);
      Store.saveProgress(App.progress);
    } else s.streak = 0;
  }
  Store.saveStats(s);
  return unlocked;
}

async function endRound(result) {
  const token = App.session;
  const m = App.match;
  const pv = App.mode === 'pvp';
  App.busy = true;
  App.awaitingHuman = false;
  updateActions();
  renderHand();
  const over = m.applyRound(result);
  App.lastUnlocked = recordRoundStats(result, over);
  renderSeats();

  if (result.tie) { setBanner('Rodada empatada', 'info'); Sound.play('tie'); }
  else if (pv) { setBanner(`${nameOf(result.winner)} venceu ${over ? 'a partida!' : 'a rodada!'}`, 'you'); Sound.play('win'); }
  else if (result.winner === 0) { setBanner(over ? 'Você venceu a partida!' : 'Você venceu a rodada!', 'you'); Sound.play('win'); }
  else { setBanner(`${nameOf(result.winner)} venceu a rodada`, 'bot'); Sound.play(over ? 'lose' : 'tie'); }

  await gsleep(1300);
  if (token !== App.session) return;
  showRoundEnd(result, over);
}

function miniTiles(hand) {
  if (!hand.length) return '<span class="mini-none">sem peças</span>';
  return hand.map((t) => `<i class="mini" style="background-image:url('${tileUrl(App.settings.theme, t.a, t.b)}')"></i>`).join('');
}

function showRoundEnd(result, over) {
  const m = App.match;
  const pv = App.mode === 'pvp';
  const you = (p) => !pv && p === 0;
  let title, sub;
  if (result.tie) {
    title = 'Rodada empatada';
    sub = 'O jogo fechou com o mesmo número de pontos e de peças. Ninguém pontua.';
  } else {
    const w = result.winner;
    const who = you(w) ? 'Você' : nameOf(w);
    const how = result.reason === 'domino' ? 'bateu a mesa' : 'fechou o jogo com menos pontos';
    title = you(w) ? 'Você venceu a rodada!' : `${nameOf(w)} venceu a rodada`;
    sub = `${who} ${how} e somou ${result.points} ponto${result.points === 1 ? '' : 's'}.`;
  }
  if (over) {
    if (m.winner === null) title = 'Partida empatada';
    else title = you(m.winner) ? 'Você venceu a partida!' : `${nameOf(m.winner)} venceu a partida`;
  }
  $('#roundend-title').textContent = title;
  $('#roundend-sub').textContent = sub;
  $('#roundend-list').innerHTML = [0, 1].map((p) => {
    const win = result.winner === p;
    const gained = win ? `+${result.points}` : '';
    return `<li class="${win ? 'is-winner' : ''}">
      <div class="re-who"><span class="re-name">${nameOf(p)}</span><span class="re-hand">${miniTiles(result.hands[p])}</span></div>
      <div class="re-pips"><b>${result.pips[p]}</b><small>na mão</small></div>
      <div class="re-total"><b>${m.scores[p]}</b><small>${gained || 'total'}</small></div>
    </li>`;
  }).join('');

  // Estilos de peça liberados por esta vitória
  const box = $('#roundend-unlock');
  if (App.lastUnlocked.length) {
    const names = App.lastUnlocked.map((t) => THEME_NAMES[t]).join(' e ');
    const prevs = App.lastUnlocked.map((t) => `<i class="mini" style="background-image:url('${tileUrl(t, 2, 5)}')"></i>`).join('');
    box.innerHTML = `<span class="unlock-prev">${prevs}</span><span><b>Novo estilo de peças liberado!</b><br>${names} já está disponível no botão Peças do menu.</span>`;
    box.hidden = false;
    Sound.play('win');
  } else {
    box.hidden = true;
    box.innerHTML = '';
  }

  const next = $('#btn-roundend-next');
  next.textContent = over ? 'Jogar novamente' : 'Próxima rodada';
  next.dataset.over = over ? '1' : '0';
  openDialog('#modal-roundend');
}

function bindRoundEnd() {
  const d = $('#modal-roundend');
  d.addEventListener('cancel', (e) => e.preventDefault());
  $('#btn-roundend-next').addEventListener('click', (e) => {
    const over = e.currentTarget.dataset.over === '1';
    d.close();
    if (over) startMatch();
    else { App.match.advance(); startRound(); }
  });
  $('#btn-roundend-menu').addEventListener('click', () => { d.close(); goToMenu(); });
}

function goToMenu() {
  App.session++;
  cancelCurtain();
  App.inGame = false;
  App.paused = false;
  App.busy = false;
  App.awaitingHuman = false;
  clearSelection();
  $$('.modal[open]').forEach((d) => d.close());
  showScreen('screen-menu');
}

/* ----- Pausa / menu da partida ----- */
function bindPause() {
  $('#btn-pause').addEventListener('click', () => { Sound.unlock(); openDialog('#modal-pause'); });
  $('#curtain-menu').addEventListener('click', () => openDialog('#modal-pause'));
  $('#curtain-ready').addEventListener('click', () => { Sound.unlock(); if (App.curtainResolve) App.curtainResolve(true); });
  $('#pause-howto').addEventListener('click', () => openDialog('#modal-howto'));
  $('#pause-settings').addEventListener('click', () => { syncSettingsForm(); openDialog('#modal-settings'); });
  $('#pause-restart').addEventListener('click', async () => {
    if (!(await askConfirm('Reiniciar a partida? O progresso atual será perdido.', 'Reiniciar'))) return;
    $('#modal-pause').close();
    syncPaused();
    startMatch();
  });
  $('#pause-quit').addEventListener('click', async () => {
    if (!(await askConfirm('Sair para o menu? A partida atual será encerrada.', 'Sair'))) return;
    goToMenu();
  });
}

/* ---------------------------------------------------------------------
   Inicialização
   --------------------------------------------------------------------- */
function init() {
  App.board = new BoardView($('#board'));
  applySound();
  bindSettings();
  bindNewGame();
  bindSkins();
  syncSettingsForm();
  bindRoundEnd();
  bindPause();
  applyTheme();

  // Botões do menu
  $('#btn-play').addEventListener('click', () => { Sound.unlock(); openNewGame(); });
  $('#btn-skins').addEventListener('click', () => { renderSkins(); openDialog('#modal-skins'); });
  $('#btn-howto').addEventListener('click', () => openDialog('#modal-howto'));
  $('#btn-settings').addEventListener('click', () => { syncSettingsForm(); openDialog('#modal-settings'); });
  $('#btn-stats').addEventListener('click', () => { renderStats(); openDialog('#modal-stats'); });
  $('#btn-reset-stats').addEventListener('click', async () => {
    if (!(await askConfirm('Apagar todas as estatísticas salvas? As peças desbloqueadas continuam liberadas.', 'Apagar'))) return;
    App.stats = DEFAULT_STATS();
    Store.saveStats(App.stats);
    renderStats();
  });

  // Som no topo da partida
  $('#btn-sound').addEventListener('click', () => {
    const on = App.settings.sound && App.settings.volume > 0;
    App.settings.sound = !on;
    if (!on && App.settings.volume === 0) App.settings.volume = 60;
    commitSettings(); syncSettingsForm();
    Sound.play('select');
  });

  // Diálogos: fechar por [data-close], clique no fundo e sincronizar pausa
  $$('.modal').forEach((d) => {
    d.addEventListener('close', syncPaused);
    d.addEventListener('click', (e) => {
      if (e.target === d && d.id !== 'modal-roundend' && d.id !== 'modal-confirm') d.close();
    });
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // Mão e ações
  const hand = $('#hand');
  hand.setAttribute('role', 'group');
  hand.addEventListener('pointerdown', onHandPointerDown);
  hand.addEventListener('click', (e) => {          // teclado (Enter/Espaço) gera click com detail === 0
    const btn = e.target.closest('.hand-tile');
    if (btn && e.detail === 0) onTileClick(btn);
  });
  $('#btn-draw').addEventListener('click', onDrawClick);
  $('#btn-pass').addEventListener('click', onPassClick);
  $('#board').addEventListener('click', (e) => { if (e.target.closest('.slot')) return; if (App.selectedId) clearSelection(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && App.selectedId) clearSelection(); });

  // Redimensionamento
  const ro = new ResizeObserver(() => { if (App.board) App.board.onResize(); });
  ro.observe($('#board'));
  window.addEventListener('orientationchange', () => setTimeout(() => App.board.onResize(), 200));
}

init();

/* Hooks de depuração/teste (não usados pelo jogo).
   Ex.: __domino.setWins(16) libera todos os estilos de peça para testar. */
window.__domino = {
  App, DominoGame, Match, AI, BoardLayout, startMatch,
  setWins(n) { App.progress.botWins = Math.max(0, Math.floor(n)); Store.saveProgress(App.progress); renderSkins(); },
};

} // fim do bloco apenas-navegador
