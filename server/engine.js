'use strict';
// =========================================================================
//  engine.js — 既存の単体版(../../index.html)の麻雀ロジックを Node 上で再利用する。
//  index.html の <script> をそのまま factory として読み込み、ブラウザAPIをスタブ。
//  こうすることで、作り込み済みの「和了/役/符/点数/シャンテン/CPU」判定を
//  バグ再発なくサーバ側で使える。各テーブルごとに createEngine() で独立インスタンス。
//
//  ※ 進行フロー(drawPhase 等の DOM/タイマー依存部分)は使わず、
//    純粋な判定関数だけを table.js から呼び出して、独自のサーバ進行を組む。
// =========================================================================
const fs = require('fs');
const path = require('path');

// デプロイ時に自己完結できるよう、まず同梱の game.html を使う(無ければ親の index.html)
const HTML_PATH = (() => {
  const local = path.join(__dirname, 'game.html');
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, '..', '..', 'index.html');
})();

// ---- ブラウザAPIの最小スタブ(ロード時にクラッシュしない程度) ----
function makeStubNode() {
  const node = {
    _children: [],
    style: {},
    dataset: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    set innerHTML(_v) {}, get innerHTML() { return ''; },
    textContent: '',
    value: '', checked: false,
    onclick: null,
    append() {}, appendChild() {}, prepend() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return makeStubNode(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    get children() { return []; },
    setAttribute() {}, getAttribute() { return null; },
  };
  return node;
}

function makeBrowserEnv() {
  const store = new Map();
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
  const documentStub = {
    getElementById() { return makeStubNode(); },
    querySelector() { return makeStubNode(); },
    querySelectorAll() { return []; },
    createElement() { return makeStubNode(); },
    createTextNode() { return makeStubNode(); },
    addEventListener() {}, removeEventListener() {},
    head: makeStubNode(), body: makeStubNode(), documentElement: makeStubNode(),
    get activeElement() { return makeStubNode(); },
  };
  const windowStub = {
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    AudioContext: undefined, webkitAudioContext: undefined,
    location: { reload() {} },
    matchMedia() { return { matches: false, addEventListener() {} }; },
  };
  const navigatorStub = { userAgent: 'node' };
  return { document: documentStub, window: windowStub, localStorage, navigator: navigatorStub };
}

// index.html の <script>…</script> を取り出す
function extractScript() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.lastIndexOf('</script>');
  if (start < 0 || end < 0) throw new Error('script tag not found in index.html');
  return html.slice(start + '<script>'.length, end);
}

// 再利用したい判定関数の名前(index.html 内の関数名と一致)
const EXPORTS = [
  'G', 'freshPlayer', 'buildWall', 'T', 'sortHand', 'counts34',
  'doraFromIndicator', 'isHonor', 'suitOf', 'rankOf', 'isTerminal', 'isYaochu', 'isDragon', 'isWind',
  'decomposeStandard', 'isChiitoitsu', 'isKokushiComplete', 'isWinningHand', 'waitingTiles', 'isTenpai',
  'shanten', 'evaluateWin', 'settleWin', 'paoInfo',
  'chooseDiscard', 'decideCpuCall', 'cpuWantsRiichi', 'cpuShouldFold', 'cpuWantsWin',
  'cpuHandValue', 'chooseDiscardForRiichi', 'discardDanger', 'waitingOrAcceptance', 'countVisible',
  'getKanOptions', 'getChiOptions', 'checkRon', 'isFuriten', 'makeCtx', 'isNagashiMangan',
  'isKuikae', 'kuikaeTiles', 'shouldCpuKan',
];

let SCRIPT_CACHE = null;

function createEngine() {
  if (!SCRIPT_CACHE) SCRIPT_CACHE = extractScript();
  const env = makeBrowserEnv();
  const returnObj = '\n;return {' + EXPORTS.map(n => `${n}: (typeof ${n}!=="undefined"?${n}:undefined)`).join(',') + '};';
  // eslint-disable-next-line no-new-func
  const factory = new Function('document', 'window', 'localStorage', 'navigator', SCRIPT_CACHE + returnObj);
  const api = factory(env.document, env.window, env.localStorage, env.navigator);
  api._env = env;
  return api;
}

module.exports = { createEngine };
