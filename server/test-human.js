'use strict';
// 2人の人間(seat0,1)+CPU2人で対局を回し、反応(ポン/チー/ロン)や複数人の手番が
// 正しく進むかを検証する(サーバ非経由・Table直接駆動、決定的)。
const { Table } = require('./table');

const t = new Table({ cpuDelay: 1, reactWindow: 200, nextDelay: 10, reactDelay: 1 });
// seat0,1 を人間に
t.seatController(0, 'human', 'A', 'あなた');
t.seatController(1, 'human', 'B', 'ともだち');
t.hostId = 'A';
const clientOf = { 0: 'A', 1: 'B' };

let hands = 0, wins = 0, draws = 0, humanCalls = 0, humanRons = 0, humanTsumo = 0, done = false;
const lastState = {};

// 疑似乱数(決定的)
let seed = 12345; function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

t.onEvent((seat, msg) => {
  if (msg.t === 'state') { lastState[seat] = msg.state; return; }
  if (seat > 1) return;                     // 人間 seat0,1 のみ処理
  const cid = clientOf[seat];
  if (msg.t === 'handStart') { if (seat === 0) hands++; return; }
  if (msg.t === 'call') { const s = t.seats[msg.seat]; if (s.controller === 'human') { if (seat === 0) humanCalls++; } return; }

  if (msg.t === 'yourTurn') {
    // 人間も CPU頭脳で打つ(人間の入力経路を、和了まで含めて検証)
    const p = t.G.players[seat];
    if (msg.options.canTsumo) { humanTsumo++; return setImmediate(() => t.action(cid, { type: 'tsumo' })); }
    if (p.riichi && p.drawn) return setImmediate(() => t.action(cid, { type: 'discard', id: p.drawn.id }));
    if (msg.options.canRiichi && t.E.cpuWantsRiichi(p)) { const d = t.E.chooseDiscardForRiichi(p); if (d && d.tile) return setImmediate(() => t.action(cid, { type: 'riichi', id: d.tile.id })); }
    const c = t.E.chooseDiscard(p); const id = (c && c.tile ? c.tile : (p.drawn || p.hand[0])).id;
    return setImmediate(() => t.action(cid, { type: 'discard', id }));
  }

  if (msg.t === 'canReact') {
    const types = new Set(msg.options.map(o => o.type));
    if (types.has('ron')) { if (seat === 0) humanRons++; return setImmediate(() => t.action(cid, { type: 'ron' })); }
    // ポン/チーは CPU の鳴き判断(decideCpuCall)を人間の判断として使う
    const my = (t.pending && t.pending.type === 'react' && t.pending.bySeat[seat]) || [];
    const dec = my.length ? t.E.decideCpuCall(my, t.pending.from, t.pending.tile) : null;
    if (dec && dec.seat === seat && (dec.type === 'pon' || dec.type === 'minkan')) { if (seat === 0) humanCalls++; return setImmediate(() => t.action(cid, { type: dec.type })); }
    if (dec && dec.seat === seat && dec.type === 'chi') { if (seat === 0) humanCalls++; return setImmediate(() => t.action(cid, { type: 'chi', chi: dec.chi })); }
    return setImmediate(() => t.action(cid, { type: 'skip' }));
  }

  if (msg.t === 'handEnd') {
    const r = msg.result;
    if (seat === 0) {
      if (r.kind === 'tsumo' || r.kind === 'ron') { wins++; const w = r.winners[0]; console.log(`  局${hands}: ${r.kind} seat${w.seat}(${t.seats[w.seat].name}) ${w.yakuman ? '役満' : w.han + '飜'} ${w.total} [${w.yaku.map(y => y.name).join(',')}]`); }
      else { draws++; console.log(`  局${hands}: ${r.kind}`); }
    }
    return setImmediate(() => t.action && t.ready(cid));
  }

  if (msg.t === 'gameOver') {
    if (seat !== 0) return;
    done = true;
    const sum = t.G.players.reduce((a, p) => a + p.score, 0);
    console.log('\n=== 終了(' + (msg.reason || '規定') + ') ===');
    for (const e of msg.ranking) console.log(`  ${e.rank}位 ${msg.names[e.seat]} ${t.G.players[e.seat].score}点`);
    console.log(`\n局${hands} 和了${wins} 流局${draws} / 人間の鳴き${humanCalls} 人間ロン${humanRons} 人間ツモ${humanTsumo}`);
    console.log(`点数合計 ${sum + t.G.riichiSticks * 1000} (期待100000)`);
    const ok = sum + t.G.riichiSticks * 1000 === 100000 && hands >= 4;
    console.log(ok ? '🎉 人間プレイOK(反応/複数人の手番が破綻なく進行)' : '⚠ 異常');
    process.exit(ok ? 0 : 1);
  }
});

console.log('人間2 + CPU2 の対局を開始...');
t.start();
setTimeout(() => { if (!done) { console.log('⚠ 未完了/停止 局' + hands + ' phase=' + t.phase + ' pending=' + JSON.stringify(t.pending && { type: t.pending.type, seat: t.pending.seat })); process.exit(2); } }, 20000);
