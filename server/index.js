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

// ---- 静的配信 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
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

function makeTable(opts, code) {
  const id = 't' + (tableSeq++);
  const table = new Table(Object.assign({ cpuDelay: 700, reactWindow: 10000, nextDelay: 8000, reactDelay: 400 }, opts));
  const rec = { id, table, code: code || null };
  tables.set(id, rec);
  // 各席の human に、その席のメッセージを転送
  table.onEvent((seat, msg) => {
    const cli = clientAtSeat(rec, seat);
    if (cli && cli.ws.readyState === 1) send(cli.ws, msg);
  });
  return rec;
}

// 自動マッチング: 空きCPU席のある卓に着席、無ければ新卓を作り開始
function matchmake(cli, mode) {
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
  const rec = makeTable();
  cli.tableId = rec.id;
  rec.table.seatController(0, 'human', cli.id, cli.name);
  rec.table.hostId = cli.id;
  cli.seat = 0;
  send(cli.ws, { t: 'joined', tableId: rec.id, seat: 0, mode });
  rec.table.start();
  broadcastLobby();
}

// ルームを作る(合言葉で友人と)
function createRoom(cli) {
  const code = genRoomCode();
  const rec = makeTable({}, code);
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
  for (const cli of clients.values()) if (!cli.tableId) send(cli.ws, info);
}

wss.on('connection', (ws) => {
  const id = clientSeq++;
  const cli = { id, ws, name: 'プレイヤー' + id, tableId: null, seat: -1 };
  clients.set(id, cli);
  send(ws, { t: 'hello', id });
  broadcastLobby();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const rec = cli.tableId ? tables.get(cli.tableId) : null;
    switch (m.t) {
      case 'setName': cli.name = String(m.name || '').slice(0, 16) || cli.name; break;
      case 'join': matchmake(cli, m.mode || 'auto'); break;
      case 'createRoom': createRoom(cli); break;
      case 'joinRoom': joinRoom(cli, m.code); break;
      case 'action': if (rec) rec.table.action(cli.id, m.act || m); break;
      case 'ready': if (rec) rec.table.ready(cli.id); break;
      case 'setSeat': if (rec) rec.table.hostSetSeat(cli.id, m.seat, m.controller); break;
      case 'leave':
        if (rec) rec.table.disconnectClient(cli.id);
        cli.tableId = null; cli.seat = -1; broadcastLobby();
        break;
    }
  });

  ws.on('close', () => {
    const rec = cli.tableId ? tables.get(cli.tableId) : null;
    if (rec) rec.table.disconnectClient(cli.id);
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
