'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UP_DIR, { recursive: true });

/* ---------- Хранилище: один JSON-файл, всё держим в памяти ---------- */
let db = { users: {}, chats: {}, messages: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* первый запуск */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), (err) => {
      if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {});
    });
  }, 300);
}
const newId = () => crypto.randomBytes(8).toString('hex');
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

const userByName = (name) => Object.values(db.users).find((u) => u.username === String(name).toLowerCase());
const pub = (u) => ({ id: u.id, name: u.name, username: u.username, online: online(u.id) });

/* ---------- Присутствие онлайн ---------- */
const sockets = new Map(); // userId -> число подключений
const online = (uid) => (sockets.get(uid) || 0) > 0;

/* ---------- Ограничитель частоты для входа ---------- */
const hits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

/* ---------- HTTP ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use('/uploads', express.static(UP_DIR, { maxAge: '7d', index: false }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const uid = db.sessions[h.replace(/^Bearer\s+/i, '')];
  if (!uid || !db.users[uid]) return res.status(401).json({ error: 'Нужно войти' });
  req.user = db.users[uid];
  next();
}

function startSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = user.id;
  save();
  return token;
}

app.post('/api/register', (req, res) => {
  if (limited(req.ip + ':reg', 10, 3600000)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
  const username = clean(req.body.username, 24).toLowerCase();
  const name = clean(req.body.name, 40) || username;
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Логин: 3–24 символа, латиница, цифры и _' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  if (userByName(username)) return res.status(409).json({ error: 'Этот логин уже занят' });
  const user = { id: newId(), username, name, passHash: bcrypt.hashSync(password, 10), createdAt: Date.now() };
  db.users[user.id] = user;
  res.json({ token: startSession(user), user: pub(user) });
});

app.post('/api/login', (req, res) => {
  if (limited(req.ip + ':login', 20, 600000)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
  const user = userByName(clean(req.body.username, 24));
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.passHash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  res.json({ token: startSession(user), user: pub(user) });
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  delete db.sessions[token];
  save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

app.post('/api/me', auth, (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Введите имя' });
  req.user.name = name;
  save();
  res.json({ user: pub(req.user) });
});

/* Представление чата для конкретного пользователя */
function chatView(chat, uid) {
  const msgs = db.messages[chat.id] || [];
  const last = msgs[msgs.length - 1] || null;
  const readAt = (chat.reads && chat.reads[uid]) || 0;
  let unread = 0;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].ts > readAt; i--) if (msgs[i].userId !== uid) unread++;
  const view = {
    id: chat.id, type: chat.type, unread, canPost: chat.type === 'dm' || chat.ownerId === uid,
    last: last && lastView(last), createdAt: chat.createdAt
  };
  if (chat.type === 'dm') {
    const peer = db.users[chat.members.find((m) => m !== uid)];
    view.title = peer ? peer.name : 'Удалённый пользователь';
    view.peer = peer ? pub(peer) : null;
  } else {
    view.title = chat.title;
    view.ownerId = chat.ownerId;
    view.membersCount = chat.members.length;
    view.about = chat.about || '';
  }
  return view;
}
function lastView(m) {
  return { type: m.type, text: m.text, userId: m.userId, name: m.name, ts: m.ts };
}

app.get('/api/chats', auth, (req, res) => {
  const list = Object.values(db.chats).filter((c) => c.members.includes(req.user.id)).map((c) => chatView(c, req.user.id));
  list.sort((a, b) => ((b.last && b.last.ts) || b.createdAt) - ((a.last && a.last.ts) || a.createdAt));
  res.json({ chats: list });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Чат не найден' });
  res.json({ messages: (db.messages[chat.id] || []).slice(-200) });
});

app.get('/api/search', auth, (req, res) => {
  const q = clean(req.query.q, 40).toLowerCase();
  if (q.length < 2) return res.json({ users: [], channels: [] });
  const users = Object.values(db.users)
    .filter((u) => u.id !== req.user.id && (u.username.includes(q) || u.name.toLowerCase().includes(q)))
    .slice(0, 15).map(pub);
  const channels = Object.values(db.chats)
    .filter((c) => c.type === 'channel' && c.title.toLowerCase().includes(q))
    .slice(0, 15).map((c) => ({ id: c.id, title: c.title, about: c.about || '', membersCount: c.members.length, joined: c.members.includes(req.user.id) }));
  res.json({ users, channels });
});

app.post('/api/chats/dm', auth, (req, res) => {
  const peer = db.users[req.body.userId];
  if (!peer || peer.id === req.user.id) return res.status(400).json({ error: 'Нельзя создать такой чат' });
  let chat = Object.values(db.chats).find((c) => c.type === 'dm' && c.members.includes(peer.id) && c.members.includes(req.user.id));
  if (!chat) {
    chat = { id: newId(), type: 'dm', members: [req.user.id, peer.id], createdAt: Date.now(), reads: {} };
    db.chats[chat.id] = chat;
    db.messages[chat.id] = [];
    save();
    attach(chat, [req.user.id, peer.id]);
  }
  res.json({ chat: chatView(chat, req.user.id) });
});

app.post('/api/chats/channel', auth, (req, res) => {
  const title = clean(req.body.title, 50);
  if (title.length < 2) return res.status(400).json({ error: 'Название канала слишком короткое' });
  const chat = {
    id: newId(), type: 'channel', title, about: clean(req.body.about, 200),
    ownerId: req.user.id, members: [req.user.id], createdAt: Date.now(), reads: {}
  };
  db.chats[chat.id] = chat;
  db.messages[chat.id] = [];
  save();
  attach(chat, [req.user.id]);
  res.json({ chat: chatView(chat, req.user.id) });
});

app.post('/api/channels/:id/join', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || chat.type !== 'channel') return res.status(404).json({ error: 'Канал не найден' });
  if (!chat.members.includes(req.user.id)) {
    chat.members.push(req.user.id);
    save();
    attach(chat, [req.user.id]);
  }
  res.json({ chat: chatView(chat, req.user.id) });
});

app.post('/api/channels/:id/leave', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || chat.type !== 'channel' || chat.ownerId === req.user.id) return res.status(400).json({ error: 'Нельзя покинуть этот канал' });
  chat.members = chat.members.filter((m) => m !== req.user.id);
  save();
  io.in('user:' + req.user.id).socketsLeave('chat:' + chat.id);
  res.json({ ok: true });
});

/* Загрузка голосовых и видео: тело запроса — сам файл */
const MEDIA_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'video/mp4': 'mp4' };
app.post('/api/upload', auth, express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[mime];
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length < 200) return res.status(400).json({ error: 'Неподдерживаемый файл' });
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFile(path.join(UP_DIR, name), req.body, (err) => {
    if (err) return res.status(500).json({ error: 'Не удалось сохранить файл' });
    res.json({ url: '/uploads/' + name });
  });
});

/* ---------- Socket.IO ---------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

function attach(chat, userIds) {
  userIds.forEach((uid) => {
    io.in('user:' + uid).socketsJoin('chat:' + chat.id);
    io.to('user:' + uid).emit('chats-changed');
  });
}

io.use((socket, next) => {
  const uid = db.sessions[socket.handshake.auth && socket.handshake.auth.token];
  if (!uid || !db.users[uid]) return next(new Error('unauthorized'));
  socket.userId = uid;
  next();
});

io.on('connection', (socket) => {
  const uid = socket.userId;
  const me = db.users[uid];
  socket.join('user:' + uid);
  Object.values(db.chats).forEach((c) => { if (c.members.includes(uid)) socket.join('chat:' + c.id); });
  const wasOnline = online(uid);
  sockets.set(uid, (sockets.get(uid) || 0) + 1);
  if (!wasOnline) io.emit('presence', { userId: uid, online: true });

  socket.on('send', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const chat = data && db.chats[data.chatId];
    if (!chat || !chat.members.includes(uid)) return reply({ error: 'Чат не найден' });
    if (chat.type === 'channel' && chat.ownerId !== uid) return reply({ error: 'В канале пишет только владелец' });
    const msg = { id: newId(), chatId: chat.id, userId: uid, name: me.name, type: data.type, ts: Date.now() };
    if (data.type === 'text') {
      msg.text = String(data.text || '').trim().slice(0, 2000);
      if (!msg.text) return reply({ error: 'Пустое сообщение' });
    } else if (data.type === 'voice' || data.type === 'video') {
      const url = String(data.url || '');
      if (!/^\/uploads\/[a-f0-9]{16}\.(webm|ogg|m4a|mp4)$/.test(url) || !fs.existsSync(path.join(UP_DIR, path.basename(url)))) {
        return reply({ error: 'Файл не найден' });
      }
      msg.url = url;
      const max = data.type === 'video' ? 30 : 600;
      msg.duration = Math.min(Math.max(Number(data.duration) || 0, 0), max);
    } else {
      return reply({ error: 'Неизвестный тип сообщения' });
    }
    (db.messages[chat.id] = db.messages[chat.id] || []).push(msg);
    if (!chat.reads) chat.reads = {};
    chat.reads[uid] = msg.ts;
    save();
    io.to('chat:' + chat.id).emit('message', msg);
    reply({ ok: true });
  });

  socket.on('read', (data) => {
    const chat = data && db.chats[data.chatId];
    if (!chat || !chat.members.includes(uid)) return;
    if (!chat.reads) chat.reads = {};
    chat.reads[uid] = Date.now();
    save();
  });

  socket.on('typing', (data) => {
    const chat = data && db.chats[data.chatId];
    if (!chat || chat.type !== 'dm' || !chat.members.includes(uid)) return;
    socket.to('chat:' + chat.id).emit('typing', { chatId: chat.id, userId: uid, name: me.name });
  });

  socket.on('disconnect', () => {
    const n = (sockets.get(uid) || 1) - 1;
    if (n <= 0) {
      sockets.delete(uid);
      io.emit('presence', { userId: uid, online: false });
    } else {
      sockets.set(uid, n);
    }
  });
});

server.listen(PORT, () => console.log('Мессенджер запущен на порту ' + PORT));
