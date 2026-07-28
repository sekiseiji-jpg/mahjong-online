'use strict';
// =========================================================================
//  table.js — サーバ権威型の対局進行(1卓ぶん)。
//  役/点数/シャンテン/CPU は engine.js(=既存ロジック)を再利用し、
//  進行そのもの(ツモ→打牌→反応→鳴き→和了/流局→次局)はここで組む。
//  ・各席は controller = 'human' | 'cpu'。対局途中で切替可能。
//  ・emit(seat, msg): 各プレイヤーには自分視点だけを配信(他家の手牌は隠す)。
// =========================================================================
const { createEngine } = require('./engine');

const WINDS = ['東', '南', '西', '北'];

class Table {
  constructor(opts = {}) {
    this.E = createEngine();
    this.G = this.E.G;
    this.opts = Object.assign({
      hanchan: false, aka: true, kuitan: true, tobi: true, uma: true,
      level: 'normal', cpuDelay: 500, reactWindow: 8000, nextDelay: 6000, reactDelay: 300,
    }, opts);
    this.seats = [0, 1, 2, 3].map(i => ({
      seat: i, controller: 'cpu', clientId: null, name: 'CPU' + (i + 1), connected: false, ready: false,
    }));
    this.hostId = null;
    this.phase = 'lobby';               // lobby | playing | handEnd | gameOver
    this.pending = null;                // {type:'turn',seat,options} | {type:'react',...}
    this.listeners = new Set();         // (seat, msg) => void
    this._timers = [];
    this.log = [];
    this.paused = false;
  }

  // ---- 配信 ----
  onEvent(fn) { this.listeners.add(fn); }
  emit(seat, msg) { for (const fn of this.listeners) fn(seat, msg); }
  broadcast(msg) { for (let s = 0; s < 4; s++) this.emit(s, msg); }
  after(ms, fn) { const id = setTimeout(() => { this._timers = this._timers.filter(t => t !== id); if (!this.paused) fn(); }, ms); this._timers.push(id); return id; }
  clearTimers() { for (const id of this._timers) clearTimeout(id); this._timers = []; }

  isHuman(seat) { return this.seats[seat].controller === 'human' && this.seats[seat].connected; }
  dbg(...a) { if (this.opts.debug) console.error('[dbg]', ...a); }

  // ---- 席の割当/切替 ----
  seatController(seat, controller, clientId, name) {
    const s = this.seats[seat];
    s.controller = controller;
    s.clientId = clientId || null;
    s.connected = controller === 'human' ? true : false;
    if (name) s.name = name;
    else if (controller === 'cpu') s.name = 'CPU' + (seat + 1);
    this.pushState();
  }
  // 空いているCPU席に人間が着席(後から参加)
  claimSeat(clientId, name) {
    let seat = this.seats.findIndex(s => s.controller === 'cpu');
    if (seat < 0) return -1;
    this.seatController(seat, 'human', clientId, name);
    if (this.hostId == null) this.hostId = clientId;
    // 進行がその席の入力待ちなら、人間に選択を促す
    this._maybePromptSeat(seat);
    return seat;
  }
  // 切断 → CPU 代打ち(名前は保持)。復帰で人間に戻せる。
  disconnectClient(clientId) {
    for (const s of this.seats) {
      if (s.clientId === clientId) {
        s.connected = false;
        s.controller = 'cpu';
        this.broadcast({ t: 'seatChange', seat: s.seat, controller: 'cpu', name: s.name + '(離席)' });
        this.pushState();
        // その席の入力待ちだったら CPU に肩代わりさせて進行
        if (this.pending && this.pending.seat === s.seat) this._runCpuFor(s.seat);
        else if (this.pending && this.pending.type === 'react') this._collectReact(s.seat, { type: 'skip' });
      }
    }
  }
  // ホストが手動で席を CPU⇄人間(空ける)に切替
  hostSetSeat(clientId, seat, controller) {
    if (clientId !== this.hostId) return false;
    if (controller === 'cpu') { this.seatController(seat, 'cpu'); if (this.pending && this.pending.seat === seat) this._runCpuFor(seat); }
    return true;
  }

  start() {
    this.G.hanchan = this.opts.hanchan; this.G.aka = this.opts.aka;
    this.G.kuitan = this.opts.kuitan; this.G.tobi = this.opts.tobi;
    this.G.uma = this.opts.uma; this.G.level = this.opts.level;
    this.G.wareme = false;
    this.G.round = 0; this.G.honba = 0; this.G.riichiSticks = 0; this.G.dealer = 0; this.G.wRound = 0;
    this.G.players = [0, 1, 2, 3].map(i => this.E.freshPlayer(i));
    this.phase = 'playing';
    this.newHand();
  }

  // ====================== 局の開始(配牌) ======================
  newHand() {
    const G = this.G, E = this.E;
    const all = E.buildWall();
    G.deadWall = all.slice(0, 14); G.wall = all.slice(14);
    G.wallPos = 0; G.deadDrawn = 0; G.kanCount = 0; G.kanReplacements = 0; G.pendingDora = 0;
    G.doraIndicators = [G.deadWall[4]]; G.uraIndicators = [G.deadWall[9]];
    G.lastDiscard = null; G.lastDiscardBy = -1; G.firstGoAround = true;
    G.rinshan = false; G.rinshanFlag = false;
    for (let i = 0; i < 4; i++) {
      const p = G.players[i];
      p.hand = []; p.melds = []; p.discards = []; p.riichi = false; p.doubleRiichi = false;
      p.riichiTile = -1; p.ippatsuOK = false; p.drawn = null; p.tenpai = false;
      p.furiten = false; p.tempFuriten = false; p.missedFuriten = false;
      p.kuikaeBan = null; p.paoDaisangen = -1; p.paoDaisuushi = -1;
      p.isDealer = (i === G.dealer);
    }
    for (let r = 0; r < 3; r++) for (let i = 0; i < 4; i++) { const s = (G.dealer + i) % 4; for (let k = 0; k < 4; k++) G.players[s].hand.push(this._draw()); }
    for (let i = 0; i < 4; i++) { const s = (G.dealer + i) % 4; G.players[s].hand.push(this._draw()); }
    for (const p of G.players) E.sortHand(p.hand);
    G.turn = G.dealer; G.running = true;
    this.phase = 'playing';
    this.broadcast({ t: 'handStart', round: G.round, honba: G.honba, dealer: G.dealer, wRound: G.wRound });
    this.pushState();
    this.after(400, () => this.beginTurn(G.dealer));
  }

  _draw() { return this.G.wall[this.G.wallPos++]; }
  _drawDead() { const idx = this.G.deadDrawn++; this.G.kanReplacements++; return this.G.deadWall[idx]; }
  wallRemain() { return this.G.wall.length - this.G.wallPos - this.G.kanReplacements; }

  // ====================== 手番(ツモ) ======================
  beginTurn(seat) {
    this.dbg('beginTurn seat', seat, 'wall', this.wallRemain(), 'phase', this.phase);
    if (this.phase !== 'playing') return;
    if (this.wallRemain() <= 0) return this.ryuukyoku();
    const G = this.G, E = this.E, p = G.players[seat];
    const tile = G.rinshan ? this._drawDead() : this._draw();
    if (G.rinshan) G.rinshan = false;
    p.drawn = tile;
    p.tempFuriten = false;
    G.turn = seat;
    const options = this._turnOptions(seat);
    this.pending = { type: 'turn', seat, options };
    this.pushState();
    if (this.isHuman(seat)) {
      this.emit(seat, { t: 'yourTurn', options, drawn: this._tile(tile) });
    } else {
      this.after(this.opts.cpuDelay, () => this._runCpuFor(seat));
    }
  }

  _turnOptions(seat) {
    const G = this.G, E = this.E, p = G.players[seat];
    const all = p.hand.concat([p.drawn]);
    const tsumo = this._canTsumo(seat);
    const kan = E.getKanOptions(p);
    const riichi = seat === G.dealer || true;   // 立直可否は下で判定
    const canRiichi = this._canRiichi(seat);
    return {
      canTsumo: !!tsumo,
      canRiichi,
      kan: kan.map(k => ({ type: k.type, tile: k.tile })),
      // 打牌可能な牌(喰い替え禁止を除く)
      discardable: all.map((t, i) => ({ id: t.id, t: t.t, aka: t.aka, banned: E.isKuikae ? E.isKuikae(p, t) : false })),
    };
  }
  _canTsumo(seat) {
    const G = this.G, E = this.E, p = G.players[seat];
    if (!p.drawn) return null;
    if (!E.isWinningHand(p.hand.concat([p.drawn]), p.melds)) return null;
    const ctx = E.makeCtx(p, true); ctx.winAka = p.drawn.aka;
    const res = E.evaluateWin({ ...p, hand: p.hand }, p.drawn.t, true, ctx);
    return (res && (res.han >= 1 || res.yakuman > 0)) ? res : null;
  }
  _canRiichi(seat) {
    const G = this.G, E = this.E, p = G.players[seat];
    if (p.riichi) return false;
    if (p.melds.some(m => m.open)) return false;
    if (!p.drawn) return false;
    if (p.score < 1000) return false;
    if (this.wallRemain() < 4) return false;
    const all = p.hand.concat([p.drawn]);
    for (let i = 0; i < all.length; i++) {
      const rest = all.slice(0, i).concat(all.slice(i + 1));
      if (E.isTenpai(rest, p.melds)) return true;
    }
    return false;
  }

  // ---- CPU の手番処理 ----
  _runCpuFor(seat) {
    this.dbg('cpuFor seat', seat, 'pending', this.pending && this.pending.type, this.pending && this.pending.seat);
    if (this.phase !== 'playing' || !this.pending || this.pending.seat !== seat) return;
    const G = this.G, E = this.E, p = G.players[seat];
    const tsumo = this._canTsumo(seat);
    if (tsumo && E.cpuWantsWin(tsumo)) return this.doTsumo(seat, tsumo);
    if (p.riichi) return this.doDiscard(seat, p.drawn.id, false);
    // カン(暗槓)控えめ
    for (const k of E.getKanOptions(p)) { if (k.type === 'ankan' && E.shouldCpuKan(p, k)) return this.doAnkan(seat, k.tile); }
    if (this._canRiichi(seat) && E.cpuWantsRiichi(p)) {
      const disc = E.chooseDiscardForRiichi(p);
      return this.doRiichi(seat, disc.tile.id);
    }
    const c = E.chooseDiscard(p);
    if (c && c.tile) return this.doDiscard(seat, c.tile.id, false);
    return this.doDiscard(seat, p.drawn.id, true);
  }

  // ---- 人間からのアクション入力 ----
  action(clientId, act) {
    const seat = this.seats.findIndex(s => s.clientId === clientId);
    if (seat < 0) return;
    if (this.pending && this.pending.type === 'turn' && this.pending.seat === seat) {
      if (act.type === 'tsumo') { const r = this._canTsumo(seat); if (r) this.doTsumo(seat, r); return; }
      if (act.type === 'riichi') { if (this._canRiichi(seat)) this.doRiichi(seat, act.id); return; }
      if (act.type === 'ankan') { this.doAnkan(seat, act.tile); return; }
      if (act.type === 'discard') { this.doDiscard(seat, act.id, false); return; }
    } else if (this.pending && this.pending.type === 'react') {
      this._collectReact(seat, act);
    }
  }

  // ---- 立直宣言 ----
  doRiichi(seat, tileId) {
    const G = this.G, p = G.players[seat];
    p.riichi = true;
    if (G.firstGoAround && p.discards.length === 0) p.doubleRiichi = true;
    p.ippatsuOK = true; p.score -= 1000; G.riichiSticks++;
    this.broadcast({ t: 'call', seat, kind: p.doubleRiichi ? 'ダブリー' : 'リーチ' });
    this.doDiscard(seat, tileId, false, true);
  }

  // ---- 打牌 ----
  doDiscard(seat, tileId, fromDrawnFallback, riichiDeclare) {
    const G = this.G, E = this.E, p = G.players[seat];
    this.dbg('doDiscard seat', seat, 'id', tileId, 'riichi?', p.riichi, 'drawn?', !!p.drawn, 'hand', p.hand.length);
    const all = p.hand.concat(p.drawn ? [p.drawn] : []);
    let tile = all.find(t => t.id === tileId);
    if (!tile) tile = p.drawn;                       // 保険
    const fromDrawn = (tile === p.drawn);
    if (fromDrawn) { p.drawn = null; }
    else { p.hand.splice(p.hand.indexOf(tile), 1); if (p.drawn) { p.hand.push(p.drawn); p.drawn = null; E.sortHand(p.hand); } }
    tile.tsumogiri = fromDrawn; tile.riichiDeclare = !!riichiDeclare;
    p.kuikaeBan = null;
    p.discards.push(tile);
    G.lastDiscard = tile; G.lastDiscardBy = seat;
    if (!riichiDeclare) p.ippatsuOK = false;
    G.rinshanFlag = false;
    while (G.pendingDora > 0) { G.pendingDora--; this._revealDora(); }
    this._updateFuriten(p);
    this.pending = null;
    this.broadcast({ t: 'discard', seat, tile: this._tile(tile), tsumogiri: fromDrawn, riichi: !!riichiDeclare });
    this.pushState();
    this.after(this.opts.reactDelay, () => this.checkReactions(seat, tile));
  }

  _updateFuriten(p) {
    const waits = this.E.waitingTiles(p.hand, p.melds);
    p.furiten = waits.some(w => p.discards.some(d => d.t === w));
  }
  _revealDora() {
    const G = this.G;
    const idx = 4 + G.doraIndicators.length;
    if (G.deadWall[idx]) G.doraIndicators.push(G.deadWall[idx]);
    const uidx = 9 + G.uraIndicators.length;
    if (G.deadWall[uidx]) G.uraIndicators.push(G.deadWall[uidx]);
  }

  // ====================== 反応(ロン/ポン/チー/カン) ======================
  checkReactions(fromSeat, tile) {
    this.dbg('checkReactions from', fromSeat, 'tile', tile && tile.t);
    if (this.phase !== 'playing') return;
    const G = this.G, E = this.E;
    const cands = [];
    for (let i = 1; i < 4; i++) {
      const seat = (fromSeat + i) % 4, p = G.players[seat];
      const ron = E.checkRon(p, tile, fromSeat);
      if (ron) cands.push({ seat, type: 'ron', data: ron });
      const c = E.counts34(p.hand);
      if (c[tile.t] >= 2 && !p.riichi) cands.push({ seat, type: 'pon' });
      if (c[tile.t] >= 3 && !p.riichi && this.wallRemain() > 0) cands.push({ seat, type: 'minkan' });
      if (seat === (fromSeat + 1) % 4 && !p.riichi) {
        const chis = E.getChiOptions(p, tile.t);
        if (chis.length) cands.push({ seat, type: 'chi', options: chis });
      }
    }
    if (cands.length === 0) return this.advanceTurn(fromSeat);

    // 反応の受付。人間には選択肢を送り、CPUは即断。全員回答か時間切れで解決。
    const bySeat = {};
    for (const c of cands) (bySeat[c.seat] = bySeat[c.seat] || []).push(c);
    const pend = this.pending = { type: 'react', from: fromSeat, tile, bySeat, responses: {}, resolved: false };
    // 締切タイマーを先に設定(CPUの同期解決で pending が消えても壊れないように)
    pend._deadline = this.after(this.opts.reactWindow, () => {
      if (this.pending === pend && !pend.resolved) {
        for (const seatStr of Object.keys(bySeat)) { const s = +seatStr; if (!(s in pend.responses)) pend.responses[s] = { type: 'skip' }; }
        this._resolveReact();
      }
    });
    for (const seatStr of Object.keys(bySeat)) {
      const seat = +seatStr;
      if (this.pending !== pend) break;   // すでに解決済み
      if (this.isHuman(seat)) {
        this.emit(seat, { t: 'canReact', from: fromSeat, tile: this._tile(tile), options: bySeat[seat].map(o => ({ type: o.type, options: o.options })) });
      } else {
        this._cpuReact(seat, bySeat[seat]);
      }
    }
  }

  _cpuReact(seat, myCands) {
    const E = this.E, G = this.G;
    // ロンは基本和了(役があるもののみ checkRon が返す)
    const ron = myCands.find(c => c.type === 'ron');
    if (ron) { this._collectReact(seat, { type: 'ron' }); return; }
    // ポン/チー/カンは既存 AI(decideCpuCall)で判断
    const dec = E.decideCpuCall(myCands, this.pending.from, this.pending.tile);
    if (dec && dec.seat === seat) this._collectReact(seat, { type: dec.type, chi: dec.chi });
    else this._collectReact(seat, { type: 'skip' });
  }

  _collectReact(seat, act) {
    if (!this.pending || this.pending.type !== 'react') return;
    if (seat in this.pending.responses) return;
    this.pending.responses[seat] = act;
    this._maybeResolveReact();
  }
  _maybeResolveReact() {
    if (!this.pending || this.pending.type !== 'react') return;
    const seats = Object.keys(this.pending.bySeat).map(Number);
    if (seats.every(s => s in this.pending.responses)) this._resolveReact();
  }
  _resolveReact() {
    if (!this.pending || this.pending.type !== 'react' || this.pending.resolved) return;
    this.dbg('resolveReact responses', JSON.stringify(this.pending.responses));
    this.pending.resolved = true;
    const { from, tile, bySeat, responses } = this.pending;
    this.clearTimers();
    // 優先度: ロン > ポン/カン > チー。ロン複数は頭ハネ(打牌者に近い順)
    const rons = Object.keys(responses).map(Number).filter(s => responses[s].type === 'ron');
    if (rons.length) {
      rons.sort((a, b) => ((a - from + 4) % 4) - ((b - from + 4) % 4));
      const winnerSeat = rons[0];
      const data = bySeat[winnerSeat].find(c => c.type === 'ron').data;
      this.pending = null;
      return this.doRon(winnerSeat, data, from, tile);
    }
    // ポン/カン
    for (const s of Object.keys(responses).map(Number)) {
      const a = responses[s];
      if (a.type === 'pon' || a.type === 'minkan') { this.pending = null; return this.executeCall(s, a.type, from, tile); }
    }
    for (const s of Object.keys(responses).map(Number)) {
      const a = responses[s];
      if (a.type === 'chi') { this.pending = null; return this.executeCall(s, 'chi', from, tile, a.chi); }
    }
    this.pending = null;
    return this.advanceTurn(from);
  }

  // ---- 鳴き実行 ----
  executeCall(seat, kind, fromSeat, tile, chi) {
    const G = this.G, E = this.E, p = G.players[seat];
    for (const q of G.players) q.ippatsuOK = false;
    G.firstGoAround = false;
    tile.called = true;
    if (kind === 'pon') {
      const taken = this._take(p, tile.t, 2);
      p.melds.push({ kind: 'kotsu', tile: tile.t, open: true, from: (fromSeat - seat + 4) % 4, tiles: taken.concat([tile]), calledTile: tile });
    } else if (kind === 'minkan') {
      const taken = this._take(p, tile.t, 3);
      p.melds.push({ kind: 'kantsu', tile: tile.t, open: true, from: (fromSeat - seat + 4) % 4, tiles: taken.concat([tile]), calledTile: tile });
      G.kanCount++; G.pendingDora++;
      G.turn = seat; this.broadcast({ t: 'call', seat, kind: 'カン' }); this.pushState();
      G.rinshanFlag = true; G.rinshan = true;
      return this.after(this.opts.cpuDelay, () => this.beginTurn(seat));
    } else if (kind === 'chi') {
      const taken = [this._takeOne(p, chi[0]), this._takeOne(p, chi[1])];
      p.melds.push({ kind: 'shuntsu', tile: Math.min(tile.t, chi[0], chi[1]), open: true, from: (fromSeat - seat + 4) % 4, tiles: taken.concat([tile]), calledTile: tile });
    }
    E.sortHand(p.hand);
    G.turn = seat;
    this.broadcast({ t: 'call', seat, kind: kind === 'pon' ? 'ポン' : 'チー' });
    // 鳴いた人が打牌(ツモ無し)
    const options = this._turnOptions2AfterCall(seat);
    this.pending = { type: 'turn', seat, options, afterCall: true };
    this.pushState();
    if (this.isHuman(seat)) this.emit(seat, { t: 'yourTurn', options, drawn: null });
    else this.after(this.opts.cpuDelay, () => { const c = E.chooseDiscard(p); this.doDiscard(seat, (c && c.tile ? c.tile : p.hand[0]).id, false); });
  }
  _turnOptions2AfterCall(seat) {
    const p = this.G.players[seat];
    return { canTsumo: false, canRiichi: false, kan: [],
      discardable: p.hand.map(t => ({ id: t.id, t: t.t, aka: t.aka, banned: this.E.isKuikae ? this.E.isKuikae(p, t) : false })) };
  }
  _take(p, t, n) { const out = []; for (let i = p.hand.length - 1; i >= 0 && out.length < n; i--) if (p.hand[i].t === t) out.push(p.hand.splice(i, 1)[0]); return out; }
  _takeOne(p, t) { for (let i = 0; i < p.hand.length; i++) if (p.hand[i].t === t) return p.hand.splice(i, 1)[0]; return this.E.T(t); }

  doAnkan(seat, t) {
    const G = this.G, E = this.E, p = G.players[seat];
    for (const q of G.players) q.ippatsuOK = false;
    const taken = this._take(p, t, 4);
    if (p.drawn && p.drawn.t === t && taken.length < 4) { taken.push(p.drawn); p.drawn = null; }
    if (p.drawn) { p.hand.push(p.drawn); p.drawn = null; E.sortHand(p.hand); }
    p.melds.push({ kind: 'kantsu', tile: t, open: false, tiles: taken });
    G.kanCount++; this._revealDora();
    this.broadcast({ t: 'call', seat, kind: 'カン' });
    G.rinshanFlag = true; G.rinshan = true;
    this.pending = null; this.pushState();
    this.after(this.opts.cpuDelay, () => this.beginTurn(seat));
  }

  advanceTurn(fromSeat) {
    const next = (fromSeat + 1) % 4;
    this.G.firstGoAround = this.G.firstGoAround && next !== this.G.dealer;
    this.beginTurn(next);
  }

  // ====================== 和了 ======================
  doTsumo(seat, res) {
    const G = this.G, E = this.E;
    G.running = false; this.phase = 'handEnd';
    const d = E.settleWin(seat, res, -1, G.honba, G.riichiSticks);
    G.riichiSticks = 0;
    for (let i = 0; i < 4; i++) G.players[i].score += d[i];
    this._endHand({ kind: 'tsumo', winners: [{ seat, res }], deltas: d, from: -1 });
  }
  doRon(seat, res, fromSeat, tile) {
    const G = this.G, E = this.E;
    G.running = false; this.phase = 'handEnd';
    const d = E.settleWin(seat, res, fromSeat, G.honba, G.riichiSticks);
    G.riichiSticks = 0;
    for (let i = 0; i < 4; i++) G.players[i].score += d[i];
    this._endHand({ kind: 'ron', winners: [{ seat, res }], deltas: d, from: fromSeat });
  }

  ryuukyoku() {
    const G = this.G, E = this.E;
    G.running = false; this.phase = 'handEnd';
    // 流し満貫
    const nagashi = G.players.filter(p => E.isNagashiMangan(p)).map(p => p.seat);
    const deltas = [0, 0, 0, 0];
    let tenpai = [];
    if (nagashi.length) {
      for (const s of nagashi) { const oya = s === G.dealer; for (let i = 0; i < 4; i++) { if (i === s) continue; const pay = oya ? 4000 : (i === G.dealer ? 4000 : 2000); deltas[i] -= pay; deltas[s] += pay; } }
    } else {
      for (const p of G.players) { p.tenpai = E.isTenpai(p.hand, p.melds); if (p.tenpai) tenpai.push(p.seat); }
      const n = tenpai.length;
      if (n > 0 && n < 4) { const recv = 3000 / n, pay = 3000 / (4 - n); for (let i = 0; i < 4; i++) deltas[i] = G.players[i].tenpai ? Math.round(recv) : -Math.round(pay); }
    }
    for (let i = 0; i < 4; i++) G.players[i].score += deltas[i];
    this._endHand({ kind: nagashi.length ? 'nagashi' : 'draw', tenpai, nagashi, deltas });
  }

  _endHand(result) {
    const G = this.G;
    result.scores = G.players.map(p => p.score);
    this.clearTimers();
    this.broadcast({ t: 'handEnd', result: this._publicResult(result) });
    this.pushState();
    // 次局へ(全員 ready か一定時間で自動)
    this._pendingNext = result;
    this._readyNext = new Set();
    this.after(this.opts.nextDelay, () => this._advanceHand());
  }
  ready(clientId) { const seat = this.seats.findIndex(s => s.clientId === clientId); if (seat < 0) return; this._readyNext && this._readyNext.add(seat); const humans = this.seats.filter(s => this.isHuman(s.seat)).map(s => s.seat); if (humans.every(s => this._readyNext.has(s))) this._advanceHand(); }

  _advanceHand() {
    if (this.phase !== 'handEnd') return;
    const G = this.G, r = this._pendingNext || {};
    this._pendingNext = null;
    const dealerWon = r.winners ? r.winners.some(w => w.seat === G.dealer) : false;
    const dealerTenpai = r.tenpai ? r.tenpai.includes(G.dealer) : false;
    if (this.G.tobi && G.players.some(p => p.score < 0)) return this.endGame('トビ終了');
    const keepDealer = dealerWon || ((r.kind === 'draw' || r.kind === 'nagashi') && dealerTenpai) || (r.kind === 'nagashi' && r.nagashi && r.nagashi.includes(G.dealer));
    const maxRounds = G.hanchan ? 8 : 4;
    const isLast = G.round === maxRounds - 1;
    if (isLast && keepDealer) { const top = this._ranking()[0].seat; if (top === G.dealer) return this.endGame('アガリやめ'); }
    if (keepDealer) G.honba++;
    else { G.honba = 0; G.round++; G.dealer = (G.dealer + 1) % 4; }
    if (G.round >= maxRounds) return this.endGame(null);
    G.wRound = Math.floor(G.round / 4);
    this.phase = 'playing';
    this.newHand();
  }

  _ranking() { return this.G.players.map((p, i) => ({ seat: i, score: p.score })).sort((a, b) => b.score - a.score || a.seat - b.seat).map((e, idx) => ({ ...e, rank: idx + 1 })); }
  endGame(reason) {
    this.phase = 'gameOver';
    const rk = this._ranking();
    if (this.G.uma) { const uma = [20, 10, -10, -20]; for (const e of rk) e.pt = (this.G.players[e.seat].score - 30000) / 1000 + uma[e.rank - 1]; rk.find(e => e.rank === 1).pt += 20; }
    this.clearTimers();
    this.broadcast({ t: 'gameOver', reason, ranking: rk, names: this.seats.map(s => s.name) });
    this.pushState();
  }

  // ====================== 視点つき状態の配信 ======================
  _tile(t) { return t ? { id: t.id, t: t.t, aka: !!t.aka } : null; }
  _meld(m) { return { kind: m.kind, tile: m.tile, open: m.open, from: m.from, tiles: (m.tiles || []).map(x => this._tile(x)), called: m.calledTile ? m.calledTile.id : null }; }
  _publicResult(r) {
    const out = { kind: r.kind, deltas: r.deltas, scores: r.scores, from: r.from, tenpai: r.tenpai, nagashi: r.nagashi };
    if (r.winners) out.winners = r.winners.map(w => ({
      seat: w.seat, han: w.res.han, fu: w.res.fu, yakuman: w.res.yakuman, total: w.res.total,
      yaku: w.res.yaku.map(y => ({ name: y.name, han: y.han })),
      hand: this.G.players[w.seat].hand.map(t => this._tile(t)),
      melds: this.G.players[w.seat].melds.map(m => this._meld(m)),
      winTile: w.res.winTile,
    }));
    if (this.G.uraIndicators) out.ura = this.G.uraIndicators.map(d => this._tile(d));
    return out;
  }
  // seat 視点の完全状態(自分の手牌は見える/他家は枚数のみ)
  viewFor(seat) {
    const G = this.G;
    const players = G.players.map((p, i) => {
      const base = {
        seat: i, score: p.score, wind: (i - G.dealer + 4) % 4, name: this.seats[i].name,
        controller: this.seats[i].controller, connected: this.seats[i].connected,
        riichi: p.riichi, isDealer: p.isDealer, drawnCount: p.drawn ? 1 : 0,
        discards: p.discards.filter(d => !d.called).map(d => ({ ...this._tile(d), tsumogiri: !!d.tsumogiri, riichi: !!d.riichiDeclare })),
        melds: p.melds.map(m => this._meld(m)),
        handCount: p.hand.length,
      };
      if (i === seat) { base.hand = p.hand.map(t => this._tile(t)); base.drawn = this._tile(p.drawn); }
      return base;
    });
    return {
      seat, phase: this.phase, turn: G.turn, dealer: G.dealer, round: G.round, honba: G.honba,
      wRound: G.wRound, riichiSticks: G.riichiSticks, wallRemain: this.wallRemain(),
      dora: G.doraIndicators.map(d => this._tile(d)),
      players,
      pending: this.pending && this.pending.seat === seat ? { type: this.pending.type } : (this.pending && this.pending.type === 'react' ? { type: 'react' } : null),
      seats: this.seats.map(s => ({ seat: s.seat, controller: s.controller, name: s.name, connected: s.connected, isHost: s.clientId && s.clientId === this.hostId })),
    };
  }
  pushState() { for (let s = 0; s < 4; s++) this.emit(s, { t: 'state', state: this.viewFor(s) }); }

  _maybePromptSeat(seat) {
    if (this.pending && this.pending.type === 'turn' && this.pending.seat === seat && this.isHuman(seat)) {
      this.emit(seat, { t: 'yourTurn', options: this.pending.options, drawn: this._tile(this.G.players[seat].drawn) });
    }
  }
}

module.exports = { Table };
