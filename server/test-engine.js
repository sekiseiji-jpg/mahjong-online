'use strict';
// 既存エンジンが Node 上で読み込め、判定関数が正しく動くかの検証
const { createEngine } = require('./engine');

const E = createEngine();
const G = E.G;

function mk(list) { return list.map(t => ({ t, aka: false, id: Math.random() })); }

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '✅' : '❌') + ' ' + name + ' => ' + JSON.stringify(got) + (ok ? '' : ' (want ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}

// 盤面の共通設定
G.players = [E.freshPlayer(0), E.freshPlayer(1), E.freshPlayer(2), E.freshPlayer(3)];
G.aka = true; G.kuitan = true; G.wRound = 0; G.dealer = 0;
G.doraIndicators = [{ t: 0, aka: false }];
G.uraIndicators = [{ t: 0, aka: false }];

// 1) 和了形判定
check('isWinningHand(完成形)', E.isWinningHand(mk([1,2,3,10,11,12,19,20,21,22,23,24,13,13]), []), true);
check('isChiitoitsu', E.isWinningHand(mk([0,0,4,4,9,9,13,13,18,18,22,22,33,33]), []), true);
check('kokushi 待ち枚数', E.waitingTiles(mk([0,8,9,17,18,26,27,28,29,30,31,32,33]), []).length, 13);

// 2) シャンテン
check('shanten(テンパイ)', E.shanten(mk([1,2,3,10,11,12,19,20,21,23,24,13,13]), []), 0);

// 3) 役・点数: 234m234p234s + 567s + 55p, ツモ和了(5s)
//    タンヤオ・平和・三色・門前ツモ・ドラ1 = 6飜 跳満 12000
{
  const p = { ...E.freshPlayer(0), hand: mk([1,2,3,10,11,12,19,20,21,23,24,13,13]) };
  const ctx = { roundWind: 0, seatWind: 0, ippatsu: false, rinshan: false, chankan: false, haitei: false, winAka: false };
  const res = E.evaluateWin(p, 22, true, ctx);
  check('tanyao-pinfu-sanshoku 飜', res.han, 6);
  check('tanyao-pinfu-sanshoku 点', res.total, 12000);
}

// 4) 役牌(中)ポン + 234m234p234s + 55m, ロン5m — タンヤオは付かない
{
  const p = { ...E.freshPlayer(1), hand: mk([1,2,3,10,11,12,19,20,21,5]),
    melds: [{ kind: 'kotsu', tile: 33, open: true, tiles: mk([33,33,33]) }] };
  const ctx = { roundWind: 0, seatWind: 1, ippatsu: false, rinshan: false, chankan: false, haitei: false, winAka: false };
  const res = E.evaluateWin(p, 5, false, ctx);
  const names = res.yaku.map(y => y.name);
  check('yakuhai(中) タンヤオ無し', names.includes('断么九'), false);
  check('yakuhai(中) 役に中', names.some(n => n.includes('中')), true);
}

// 5) CPU が打牌を選べる(chooseDiscard)
{
  G.level = 'normal';
  const p = G.players[0];
  p.hand = mk([0,2,4,9,11,13,18,20,22,27,29,31,33]);
  p.drawn = { t: 5, aka: false, id: 999 };
  const c = E.chooseDiscard(p);
  check('chooseDiscard は牌を返す', !!(c && c.tile && typeof c.tile.t === 'number'), true);
}

console.log('\n' + (fail === 0 ? '🎉 all passed' : `⚠ ${fail} failed`) + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
