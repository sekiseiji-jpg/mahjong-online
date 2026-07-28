'use strict';
// 全CPUの卓が最後まで進行するか(サーバ進行フローの検証)
const { Table } = require('./table');

const t = new Table({ hanchan: false, cpuDelay: 2, reactWindow: 300 });
let hands = 0, calls = 0, wins = 0, draws = 0;
let done = false;

t.onEvent((seat, msg) => {
  if (seat !== 0) return;               // seat0 視点だけログ(重複防止)
  if (msg.t === 'handStart') hands++;
  if (msg.t === 'call') calls++;
  if (msg.t === 'handEnd') {
    const r = msg.result;
    if (r.kind === 'tsumo' || r.kind === 'ron') { wins++; const w = r.winners[0]; console.log(`  局${hands}: ${r.kind} seat${w.seat} ${w.yakuman ? '役満' : w.han + '飜' + w.fu + '符'} ${w.total}点 [${w.yaku.map(y => y.name).join(',')}]`); }
    else { draws++; console.log(`  局${hands}: ${r.kind} テンパイ[${(r.tenpai || []).join(',')}]`); }
  }
  if (msg.t === 'gameOver') {
    done = true;
    console.log('\n=== 対局終了 (' + (msg.reason || '規定局数') + ') ===');
    for (const e of msg.ranking) console.log(`  ${e.rank}位 ${msg.names[e.seat]} : ${t.G.players[e.seat].score}点` + (e.pt != null ? ` (${e.pt > 0 ? '+' : ''}${e.pt}pt)` : ''));
    const sum = t.G.players.reduce((a, p) => a + p.score, 0);
    console.log(`  点数合計: ${sum} + 供託${t.G.riichiSticks * 1000} = ${sum + t.G.riichiSticks * 1000} (期待:100000)`);
    console.log(`\n局数=${hands} 和了=${wins} 流局=${draws} 鳴き=${calls}`);
    const ok = (sum + t.G.riichiSticks * 1000 === 100000) && hands >= 4;
    console.log(ok ? '🎉 サーバ進行OK' : '⚠ 異常');
    process.exit(ok ? 0 : 1);
  }
});

console.log('全CPU対局を開始...');
t.start();

// 安全タイムアウト
setTimeout(() => { if (!done) { console.log('⚠ タイムアウト: 局' + hands + 'で停止 phase=' + t.phase + ' pending=' + JSON.stringify(t.pending && t.pending.type)); process.exit(2); } }, 30000);
