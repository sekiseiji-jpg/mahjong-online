'use strict';
// =========================================================================
//  index.js — WebSocket サーバ + 自動マッチング + 席管理
//  ・クライアントは WebSocket で接続し {t:'join'} でマッチング
//  ・空いているCPU席がある卓に着席(後から参加)、無ければ新卓(1人+CPU3)を作り即開始
//  ・切断→自動CPU化 / ホストが席をCPU化 / CPU席へ後から参加 に対応(table.js)
//  ・各プレイヤーには自分視点だけを配信
// =========================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Table } = require('./table');

const PORT = process.env.PORT || 8787;
const PUBLIC = path.join(__dirname, '..', 'public');

// ---- 合言葉(パスワード)認証 ----
//  パスワードは環境変数 GAME_PASSWORD で設定(公開リポジトリに平文を置かない)。
//  未設定なら認証なし(ローカル開発用)。
const PASSWORD = process.env.GAME_PASSWORD || '';
const MAX_FAILS = 3;                    // 3回間違えたら
const LOCK_MS = 10 * 60 * 1000;         // 10分間ロック
const authTracker = new Map();          // ip -> { fails, lockUntil }

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function lockRemainingMs(ip) {
  const rec = authTracker.get(ip);
  if (rec && rec.lockUntil && rec.lockUntil > Date.now()) return rec.lockUntil - Date.now();
  return 0;
}
// 認証試行を処理し、送るべきメッセージを返す。成功時は cli.authed=true。
function tryAuth(cli, password) {
  const ip = cli.ip;
  const remain = lockRemainingMs(ip);
  if (remain > 0) return { t: 'locked', seconds: Math.ceil(remain / 1000) };
  if (PASSWORD === '' || password === PASSWORD) {
    cli.authed = true;
    authTracker.delete(ip);             // 成功したら失敗カウントをリセット
    return { t: 'authOk' };
  }
  // 失敗
  const rec = authTracker.get(ip) || { fails: 0, lockUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.lockUntil = Date.now() + LOCK_MS;
    rec.fails = 0;
    authTracker.set(ip, rec);
    return { t: 'locked', seconds: Math.ceil(LOCK_MS / 1000) };
  }
  authTracker.set(ip, rec);
  return { t: 'authFail', remaining: MAX_FAILS - rec.fails };
}

// ---- 静的配信 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok tables=' + tables.size + ' clients=' + clients.size); }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });

let clientSeq = 1, tableSeq = 1;
const clients = new Map();   // id -> { id, ws, name, tableId, seat }
const tables = new Map();    // id -> { table, id }

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function clientAtSeat(t, seat) {
  const cid = t.table.seats[seat].clientId;
  return cid != null ? clients.get(cid) : null;
}

function genRoomCode() {
  const abc = 'ABCDEFGHJKLMNPRSTUVWXYZ23456789'; // 紛らわしい文字を除外
  let code;
  do { code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); }
  while ([...tables.values()].some(r => r.code === code));
  return code;
}
function findRoom(code) { return [...tables.values()].find(r => r.code === code && r.table.phase !== 'gameOver'); }

// クライアントから来たルールを検証(不正値は既定に丸める)
function sanitizeRules(r) {
  r = r || {};
  const b = (v, d) => (typeof v === 'boolean' ? v : d);
  return { hanchan: b(r.hanchan, false), aka: b(r.aka, true), kuitan: b(r.kuitan, true), tobi: b(r.tobi, true) };
}

// 観戦者に転送するイベント種別(自分視点専用のyourTurn/canReactは除く)
const SPEC_FWD = new Set(['call', 'discard', 'handStart', 'handEnd', 'gameOver', 'chat', 'seatChange']);

function makeTable(opts, code) {
  const id = 't' + (tableSeq++);
  const table = new Table(Object.assign({ cpuDelay: 700, reactWindow: 10000, nextDelay: 8000, reactDelay: 400 }, opts));
  const rec = { id, table, code: code || null, spectators: new Set() };
  tables.set(id, rec);
  // 各席の human に、その席のメッセージを転送。観戦者には seat0 発火時のみ(重複回避)、全手牌公開ビューを配信
  table.onEvent((seat, msg) => {
    const cli = clientAtSeat(rec, seat);
    if (cli && cli.ws.readyState === 1) send(cli.ws, msg);
    if (rec.spectators.size && seat === 0) {
      let out = null;
      if (msg.t === 'state') out = { t: 'state', state: rec.table.spectatorView() };
      else if (SPEC_FWD.has(msg.t)) out = msg;
      if (out) for (const sid of rec.spectators) { const sc = clients.get(sid); if (sc && sc.ws.readyState === 1) send(sc.ws, out); }
    }
  });
  return rec;
}
function stopSpectating(cli) {
  if (cli.spectating == null) return;
  const rec = tables.get(cli.spectating);
  if (rec) rec.spectators.delete(cli.id);
  cli.spectating = null;
}
function spectate(cli, tableId) {
  const rec = tables.get(tableId);
  if (!rec || rec.table.phase === 'gameOver') { send(cli.ws, { t: 'error', msg: 'その卓は観戦できません' }); return; }
  stopSpectating(cli);
  rec.spectators.add(cli.id);
  cli.spectating = tableId;
  send(cli.ws, { t: 'spectating', tableId });
  send(cli.ws, { t: 'state', state: rec.table.spectatorView() });
}

// 自動マッチング: 空きCPU席のある卓に着席、無ければ新卓を作り開始
function matchmake(cli, mode, rules) {
  // solo は必ず新卓(1人+CPU3)、auto は既存卓の空きCPU席を優先
  if (mode !== 'solo') {
    for (const rec of tables.values()) {
      if (rec.table.phase === 'gameOver') continue;
      const seat = rec.table.seats.findIndex(s => s.controller === 'cpu');
      if (seat >= 0) {
        cli.tableId = rec.id;
        cli.seat = rec.table.claimSeat(cli.id, cli.name);
        send(cli.ws, { t: 'joined', tableId: rec.id, seat: cli.seat, mode });
        broadcastLobby();
        return;
      }
    }
  }
  const rec = makeTable(sanitizeRules(rules));
  cli.tableId = rec.id;
  rec.table.seatController(0, 'human', cli.id, cli.name);
  rec.table.hostId = cli.id;
  cli.seat = 0;
  send(cli.ws, { t: 'joined', tableId: rec.id, seat: 0, mode });
  rec.table.start();
  broadcastLobby();
}

// ルームを作る(合言葉で友人と)
function createRoom(cli, rules) {
  const code = genRoomCode();
  const rec = makeTable(sanitizeRules(rules), code);
  cli.tableId = rec.id;
  rec.table.seatController(0, 'human', cli.id, cli.name);
  rec.table.hostId = cli.id;
  cli.seat = 0;
  send(cli.ws, { t: 'joined', tableId: rec.id, seat: 0, mode: 'room', roomCode: code });
  rec.table.start();
  broadcastLobby();
}
// ルームに参加(合言葉)
function joinRoom(cli, code) {
  code = String(code || '').trim().toUpperCase();
  const rec = findRoom(code);
  if (!rec) { send(cli.ws, { t: 'error', msg: 'その合言葉の部屋が見つかりません' }); return; }
  const seat = rec.table.seats.findIndex(s => s.controller === 'cpu');
  if (seat < 0) { send(cli.ws, { t: 'error', msg: 'この部屋は満席です' }); return; }
  cli.tableId = rec.id;
  cli.seat = rec.table.claimSeat(cli.id, cli.name);
  send(cli.ws, { t: 'joined', tableId: rec.id, seat: cli.seat, mode: 'room', roomCode: code });
  broadcastLobby();
}

function broadcastLobby() {
  const info = { t: 'lobby', tables: [...tables.values()].map(r => ({ id: r.id, phase: r.table.phase, humans: r.table.seats.filter(s => s.controller === 'human' && s.connected).length })) };
  for (const cli of clients.values()) if (cli.authed && !cli.tableId) send(cli.ws, info);
}

wss.on('connection', (ws, req) => {
  const id = clientSeq++;
  const ip = clientIp(req);
  // パスワード未設定なら最初から認証済み扱い
  const cli = { id, ws, name: 'プレイヤー' + id, tableId: null, seat: -1, ip, authed: (PASSWORD === '') };
  clients.set(id, cli);
  send(ws, { t: 'hello', id, needAuth: (PASSWORD !== '') });
  // 既にロック中ならすぐ知らせる
  const remain = lockRemainingMs(ip);
  if (!cli.authed && remain > 0) send(ws, { t: 'locked', seconds: Math.ceil(remain / 1000) });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    // ---- 認証: 未認証の間は auth 以外を一切受け付けない ----
    if (m.t === 'auth') { send(ws, tryAuth(cli, String(m.password || ''))); if (cli.authed) broadcastLobby(); return; }
    if (!cli.authed) return;   // 未認証は無視(合言葉を突破しない限り操作不可)
    const rec = cli.tableId ? tables.get(cli.tableId) : null;
    switch (m.t) {
      case 'setName': cli.name = String(m.name || '').slice(0, 16) || cli.name; break;
      case 'join': matchmake(cli, m.mode || 'auto', m.rules); break;
      case 'createRoom': createRoom(cli, m.rules); break;
      case 'joinRoom': joinRoom(cli, m.code); break;
      case 'action': if (rec) rec.table.action(cli.id, m.act || m); break;
      case 'ready': if (rec) rec.table.ready(cli.id); break;
      case 'setSeat': if (rec) rec.table.hostSetSeat(cli.id, m.seat, m.controller); break;
      case 'chat': {
        if (!rec || cli.seat < 0) break;
        const now = Date.now();
        if (cli._lastChat && now - cli._lastChat < 500) break;   // 連投抑制
        cli._lastChat = now;
        const stamp = (typeof m.stamp === 'string') ? m.stamp.slice(0, 40) : null;
        const text = (typeof m.text === 'string') ? m.text.slice(0, 40) : null;
        if (stamp || text) rec.table.broadcast({ t: 'chat', seat: cli.seat, name: cli.name, stamp, text });
        break;
      }
      case 'rematch': {
        if (rec && rec.table.phase === 'gameOver' && rec.table.seats.some(s => s.clientId === cli.id)) {
          rec.table.start(); broadcastLobby();
        }
        break;
      }
      case 'spectate': spectate(cli, m.tableId); break;
      case 'leave':
        if (rec) rec.table.disconnectClient(cli.id);
        stopSpectating(cli);
        cli.tableId = null; cli.seat = -1; broadcastLobby();
        break;
    }
  });

  ws.on('close', () => {
    const rec = cli.tableId ? tables.get(cli.tableId) : null;
    if (rec) rec.table.disconnectClient(cli.id);
    stopSpectating(cli);
    clients.delete(id);
    // 誰も人間がいない gameOver/空卓は破棄
    for (const [tid, r] of tables) {
      const anyHuman = r.table.seats.some(s => s.controller === 'human' && s.connected);
      if (!anyHuman) { r.table.clearTimers(); tables.delete(tid); }
    }
    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`麻雀オンライン: http://localhost:${PORT}  (WebSocket 同ポート)`);
});
