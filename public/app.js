(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN_KEY = 'volna-token';
  var VIDEO_MAX = 30;
  var VOICE_MAX = 300;

  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  var me = null;
  var socket = null;
  var chats = [];
  var msgs = {};          // chatId -> сообщения
  var active = null;      // id открытого чата
  var typingUntil = {};   // chatId -> время, до которого показываем «печатает…»
  var lastTypingSent = 0;

  /* ---------- Вспомогательное ---------- */
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function hue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function avatar(title, key, small, channel) {
    var a = el('div', 'avatar' + (small ? ' sm' : '') + (channel ? ' channel' : ''), (title || '?').trim().charAt(0).toUpperCase());
    a.style.background = 'hsl(' + hue(key || title) + ' 40% 38%)';
    return a;
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function dayDiff(ts) {
    var a = new Date(); a.setHours(0, 0, 0, 0);
    var b = new Date(ts); b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 86400000);
  }
  function dayLabel(ts) {
    var d = dayDiff(ts);
    if (d === 0) return 'Сегодня';
    if (d === 1) return 'Вчера';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
  function listTime(ts) {
    var d = dayDiff(ts);
    if (d === 0) return fmtTime(ts);
    if (d === 1) return 'Вчера';
    return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function chatById(id) { return chats.filter(function (c) { return c.id === id; })[0]; }

  /* ---------- Запросы к серверу ---------- */
  function api(path, method, body) {
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: method || 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401 && token && path !== '/api/login') { logout(true); throw new Error('Нужно войти заново'); }
          if (!r.ok) throw new Error(data.error || 'Что-то пошло не так');
          return data;
        });
      });
  }
  function upload(blob) {
    var type = (blob.type || '').split(';')[0];
    return fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': type }, body: blob })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Не удалось загрузить файл');
          return d.url;
        });
      });
  }
  function emitSend(payload) {
    return new Promise(function (resolve, reject) {
      socket.emit('send', payload, function (r) {
        if (r && r.ok) resolve(); else reject(new Error((r && r.error) || 'Сообщение не отправлено'));
      });
    });
  }

  /* ---------- Вход и регистрация ---------- */
  var regMode = false;
  function setMode(reg) {
    regMode = reg;
    $('tabLogin').classList.toggle('on', !reg);
    $('tabReg').classList.toggle('on', reg);
    $('nameWrap').hidden = !reg;
    $('authSubmit').textContent = reg ? 'Создать аккаунт' : 'Войти';
    $('fPass').autocomplete = reg ? 'new-password' : 'current-password';
    $('authError').textContent = '';
  }
  $('tabLogin').addEventListener('click', function () { setMode(false); });
  $('tabReg').addEventListener('click', function () { setMode(true); });
  $('authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('authSubmit');
    btn.disabled = true;
    $('authError').textContent = '';
    var body = { username: $('fUser').value, password: $('fPass').value };
    if (regMode) body.name = $('fName').value;
    api(regMode ? '/api/register' : '/api/login', 'POST', body)
      .then(function (d) {
        token = d.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (err) {}
        $('fPass').value = '';
        start(d.user);
      })
      .catch(function (err) { $('authError').textContent = err.message; })
      .then(function () { btn.disabled = false; });
  });

  function logout(silent) {
    var done = function () {
      token = null; me = null; chats = []; msgs = {}; active = null;
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      if (socket) { socket.disconnect(); socket = null; }
      $('app').hidden = true;
      $('auth').hidden = false;
      document.title = 'Волна';
    };
    if (!silent && token) {
      fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(function () {}).then(done);
    } else {
      done();
    }
  }
  $('logoutBtn').addEventListener('click', function () { logout(false); });

  /* ---------- Запуск приложения ---------- */
  function start(user) {
    me = user;
    $('auth').hidden = true;
    $('app').hidden = false;
    $('profAv').replaceWith(Object.assign(avatar(me.name, me.username, false, false), { id: 'profAv', className: 'avatar big' }));
    $('profName').value = me.name;
    $('profLogin').textContent = 'Логин: ' + me.username;
    connect();
  }

  function connect() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token: token } });
    socket.on('connect', loadChats);
    socket.on('connect_error', function (err) { if (err && err.message === 'unauthorized') logout(true); });
    socket.on('chats-changed', loadChats);
    socket.on('message', onMessage);
    socket.on('typing', function (d) {
      typingUntil[d.chatId] = Date.now() + 3000;
      refreshAfterTyping(d.chatId);
      setTimeout(function () { refreshAfterTyping(d.chatId); }, 3100);
    });
    socket.on('presence', function (d) {
      chats.forEach(function (c) { if (c.peer && c.peer.id === d.userId) c.peer.online = d.online; });
      renderList();
      if (active) renderHead();
    });
  }

  function loadChats() {
    return api('/api/chats').then(function (d) {
      chats = d.chats;
      if (active && !chatById(active)) closeChat();
      renderList();
      if (active) { renderHead(); }
      updateTitle();
    }).catch(function () {});
  }

  function updateTitle() {
    var n = chats.reduce(function (s, c) { return s + (c.unread || 0); }, 0);
    document.title = (n ? '(' + n + ') ' : '') + 'Волна';
  }

  /* ---------- Список чатов ---------- */
  function previewOf(c) {
    if (isTyping(c.id)) return null;
    var m = c.last;
    if (!m) return c.type === 'channel' ? 'Пока нет публикаций' : 'Напишите первое сообщение';
    var who = m.userId === (me && me.id) ? 'Вы: ' : '';
    if (m.type === 'voice') return who + 'Голосовое сообщение';
    if (m.type === 'video') return who + 'Видеосообщение';
    return who + (m.text || '').replace(/\s+/g, ' ');
  }
  function isTyping(chatId) { return (typingUntil[chatId] || 0) > Date.now(); }

  function renderList() {
    var list = $('list');
    list.textContent = '';
    if (!chats.length) {
      list.appendChild(el('div', 'empty-list', 'Чатов пока нет. Найдите человека или канал во вкладке «Поиск».'));
      return;
    }
    chats.forEach(function (c) {
      var row = el('button', 'row' + (c.unread ? ' unread' : ''));
      row.type = 'button';
      if (c.id === active) row.setAttribute('aria-current', 'true');
      var av = avatar(c.title, c.id, false, c.type === 'channel');
      if (c.peer && c.peer.online) av.appendChild(el('span', 'dot'));
      row.appendChild(av);
      var main = el('div', 'row-main');
      main.appendChild(el('span', 'row-name', c.title));
      var p = previewOf(c);
      main.appendChild(el('span', 'row-last' + (p === null ? ' live' : ''), p === null ? 'печатает…' : p));
      row.appendChild(main);
      var side = el('div', 'row-side');
      side.appendChild(el('span', '', c.last ? listTime(c.last.ts) : ''));
      if (c.unread) side.appendChild(el('span', 'badge', String(c.unread > 99 ? '99+' : c.unread)));
      row.appendChild(side);
      row.addEventListener('click', function () { openChat(c.id); });
      list.appendChild(row);
    });
  }

  function refreshAfterTyping(chatId) {
    renderList();
    if (active === chatId) { renderHead(); renderMessages(false); }
  }

  /* ---------- Открытый чат ---------- */
  function openChat(id) {
    active = id;
    var c = chatById(id);
    if (!c) return;
    c.unread = 0;
    $('app').dataset.view = 'chat';
    $('empty').hidden = true;
    $('chatBody').hidden = false;
    renderList();
    renderHead();
    updateComposer();
    updateTitle();
    if (socket) socket.emit('read', { chatId: id });
    var show = function () { renderMessages(true); };
    if (msgs[id]) show();
    else {
      $('messages').textContent = '';
      api('/api/chats/' + id + '/messages').then(function (d) { msgs[id] = d.messages; if (active === id) show(); }).catch(function (e) { toast(e.message); });
    }
    if (window.innerWidth > 720) $('input').focus();
  }

  function closeChat() {
    cancelVoice();
    active = null;
    $('app').dataset.view = 'list';
    $('chatBody').hidden = true;
    $('empty').hidden = false;
    renderList();
  }
  $('backBtn').addEventListener('click', closeChat);

  function renderHead() {
    var c = chatById(active);
    if (!c) return;
    var av = avatar(c.title, c.id, true, c.type === 'channel');
    av.id = 'headAv';
    $('headAv').replaceWith(av);
    $('headName').textContent = c.title;
    var sub = $('headSub');
    sub.className = 'head-sub';
    if (isTyping(c.id)) { sub.textContent = 'печатает…'; sub.classList.add('live'); }
    else if (c.type === 'channel') sub.textContent = 'Канал, подписчиков: ' + c.membersCount;
    else sub.textContent = c.peer && c.peer.online ? 'в сети' : 'не в сети';
    $('leaveBtn').hidden = !(c.type === 'channel' && c.ownerId !== me.id);
  }

  function updateComposer() {
    var c = chatById(active);
    var can = c && c.canPost;
    $('composer').hidden = !can;
    $('readonly').hidden = !!can;
  }

  function renderMessages(forceScroll) {
    var c = chatById(active);
    if (!c) return;
    var box = $('messages');
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    var scrollTop = box.scrollTop;
    box.textContent = '';
    var lastDay = '';
    (msgs[active] || []).forEach(function (m) {
      var dk = new Date(m.ts).toDateString();
      if (dk !== lastDay) { box.appendChild(el('div', 'day', dayLabel(m.ts))); lastDay = dk; }
      box.appendChild(msgNode(m, c));
    });
    if (isTyping(active)) {
      var t = el('div', 'typing');
      t.appendChild(el('i')); t.appendChild(el('i')); t.appendChild(el('i'));
      box.appendChild(t);
    }
    if (!(msgs[active] || []).length && c.type === 'channel') box.appendChild(el('div', 'day', 'Публикаций пока нет'));
    box.scrollTop = (near || forceScroll) ? box.scrollHeight : scrollTop;
  }

  function msgNode(m, c) {
    var mine = m.userId === me.id;
    var isMedia = m.type === 'voice' || m.type === 'video';
    var b = el('div', 'msg ' + (c.type === 'channel' ? 'post' : (mine ? 'me' : 'them')) + (isMedia ? ' media' : ''));
    if (c.type === 'channel') b.appendChild(el('div', 'author', c.title));
    if (m.type === 'text') {
      b.appendChild(el('span', '', m.text));
    } else if (m.type === 'voice') {
      var a = document.createElement('audio');
      a.controls = true; a.preload = 'metadata'; a.src = m.url;
      b.appendChild(a);
    } else if (m.type === 'video') {
      var v = document.createElement('video');
      v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = m.url;
      b.appendChild(v);
    }
    b.appendChild(el('span', 'meta', fmtTime(m.ts) + (isMedia && m.duration ? ' · ' + mmss(m.duration) : '')));
    return b;
  }

  function onMessage(m) {
    if (msgs[m.chatId]) msgs[m.chatId].push(m);
    var c = chatById(m.chatId);
    if (!c) { loadChats(); return; }
    c.last = { type: m.type, text: m.text, userId: m.userId, name: m.name, ts: m.ts };
    typingUntil[m.chatId] = 0;
    var viewing = active === m.chatId && !document.hidden;
    if (m.userId !== me.id && !viewing) c.unread = (c.unread || 0) + 1;
    chats.sort(function (a, b) { return ((b.last && b.last.ts) || b.createdAt) - ((a.last && a.last.ts) || a.createdAt); });
    renderList();
    if (active === m.chatId) {
      renderHead();
      renderMessages(m.userId === me.id);
      if (viewing && socket) socket.emit('read', { chatId: m.chatId });
    }
    updateTitle();
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && active && socket) {
      var c = chatById(active);
      if (c) { c.unread = 0; renderList(); updateTitle(); socket.emit('read', { chatId: active }); }
    }
  });

  $('leaveBtn').addEventListener('click', function () {
    var c = chatById(active);
    if (!c) return;
    api('/api/channels/' + c.id + '/leave', 'POST').then(function () {
      chats = chats.filter(function (x) { return x.id !== c.id; });
      closeChat();
      toast('Вы покинули канал');
    }).catch(function (e) { toast(e.message); });
  });

  /* ---------- Поле ввода ---------- */
  var input = $('input');
  function updateInputState() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    var has = !!input.value.trim();
    $('sendBtn').hidden = !has;
    $('micBtn').hidden = has;
    $('videoBtn').hidden = has;
  }
  input.addEventListener('input', function () {
    updateInputState();
    var c = chatById(active);
    if (socket && c && c.type === 'dm' && Date.now() - lastTypingSent > 2000) {
      lastTypingSent = Date.now();
      socket.emit('typing', { chatId: active });
    }
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || !active) return;
    input.value = '';
    updateInputState();
    emitSend({ chatId: active, type: 'text', text: text }).catch(function (err) {
      input.value = text;
      updateInputState();
      toast(err.message);
    });
  });

  /* ---------- Запись медиа ---------- */
  function pickMime(list) {
    if (!window.MediaRecorder) return '';
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }
  function startRecorder(stream, mime) {
    var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var done = new Promise(function (resolve) {
      rec.onstop = function () { resolve(new Blob(chunks, { type: rec.mimeType || mime })); };
    });
    rec.start();
    return { rec: rec, done: done };
  }
  function stopTracks(stream) { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); }
  function canRecord() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }

  /* Голосовые */
  var voice = null;
  function setRecUi(on) {
    $('rec').hidden = !on;
    $('inputRow').hidden = on;
  }
  $('micBtn').addEventListener('click', function () {
    if (voice) return;
    if (!canRecord()) { toast('Этот браузер не умеет записывать звук'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var r = startRecorder(stream, pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']));
      voice = { stream: stream, rec: r.rec, done: r.done, t0: Date.now(), chatId: active, timer: null };
      setRecUi(true);
      $('recTime').textContent = '0:00';
      voice.timer = setInterval(function () {
        var s = (Date.now() - voice.t0) / 1000;
        $('recTime').textContent = mmss(s);
        if (s >= VOICE_MAX) finishVoice(true);
      }, 250);
    }).catch(function () { toast('Нет доступа к микрофону. Разрешите его в настройках браузера.'); });
  });
  function finishVoice(send) {
    var v = voice;
    if (!v) return;
    voice = null;
    clearInterval(v.timer);
    setRecUi(false);
    var seconds = (Date.now() - v.t0) / 1000;
    if (v.rec.state !== 'inactive') v.rec.stop();
    v.done.then(function (blob) {
      stopTracks(v.stream);
      if (!send) return null;
      if (seconds < 1) { toast('Слишком короткое сообщение'); return null; }
      return upload(blob).then(function (url) {
        return emitSend({ chatId: v.chatId, type: 'voice', url: url, duration: seconds });
      });
    }).catch(function (e) { toast(e.message); });
  }
  function cancelVoice() { if (voice) finishVoice(false); }
  $('recSend').addEventListener('click', function () { finishVoice(true); });
  $('recCancel').addEventListener('click', function () { finishVoice(false); });

  /* Видеосообщения */
  var V = { stream: null, rec: null, done: null, t0: 0, timer: null, blob: null, url: null, chatId: null };
  function setVideoState(s) {
    $('vRecord').hidden = s !== 'live';
    $('vStop').hidden = s !== 'rec';
    $('vRetake').hidden = s !== 'done';
    $('vSend').hidden = s !== 'done';
  }
  function resetVideo() {
    clearInterval(V.timer);
    if (V.rec && V.rec.state !== 'inactive') { try { V.rec.stop(); } catch (e) {} }
    stopTracks(V.stream);
    if (V.url) URL.revokeObjectURL(V.url);
    V = { stream: null, rec: null, done: null, t0: 0, timer: null, blob: null, url: null, chatId: V.chatId };
    var p = $('vPreview');
    p.pause(); p.removeAttribute('src'); p.srcObject = null; p.classList.remove('playback');
  }
  function openCamera() {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } }, audio: true }).then(function (stream) {
      V.stream = stream;
      var p = $('vPreview');
      p.srcObject = stream; p.muted = true; p.controls = false; p.loop = false;
      p.classList.remove('playback');
      p.play().catch(function () {});
      $('vTimer').textContent = '0:00 / ' + mmss(VIDEO_MAX);
      setVideoState('live');
    });
  }
  $('videoBtn').addEventListener('click', function () {
    if (!canRecord()) { toast('Этот браузер не умеет записывать видео'); return; }
    V.chatId = active;
    $('vOverlay').hidden = false;
    openCamera().catch(function () {
      $('vOverlay').hidden = true;
      toast('Нет доступа к камере или микрофону. Разрешите их в настройках браузера.');
    });
  });
  $('vRecord').addEventListener('click', function () {
    var r = startRecorder(V.stream, pickMime(['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']));
    V.rec = r.rec; V.done = r.done; V.t0 = Date.now();
    setVideoState('rec');
    V.timer = setInterval(function () {
      var s = (Date.now() - V.t0) / 1000;
      $('vTimer').textContent = mmss(s) + ' / ' + mmss(VIDEO_MAX);
      if (s >= VIDEO_MAX) stopVideo();
    }, 250);
  });
  function stopVideo() {
    if (!V.rec || V.rec.state === 'inactive') return;
    clearInterval(V.timer);
    V.seconds = Math.min((Date.now() - V.t0) / 1000, VIDEO_MAX);
    V.rec.stop();
    V.done.then(function (blob) {
      stopTracks(V.stream);
      V.blob = blob;
      V.url = URL.createObjectURL(blob);
      var p = $('vPreview');
      p.srcObject = null; p.src = V.url; p.muted = false; p.controls = true; p.classList.add('playback');
      setVideoState('done');
    });
  }
  $('vStop').addEventListener('click', stopVideo);
  $('vRetake').addEventListener('click', function () {
    var chatId = V.chatId;
    resetVideo();
    V.chatId = chatId;
    openCamera().catch(function () { $('vOverlay').hidden = true; toast('Нет доступа к камере'); });
  });
  $('vCancel').addEventListener('click', function () { resetVideo(); $('vOverlay').hidden = true; });
  $('vSend').addEventListener('click', function () {
    var blob = V.blob, secs = V.seconds || 1, chatId = V.chatId;
    if (!blob) return;
    $('vSend').disabled = true;
    upload(blob).then(function (url) {
      return emitSend({ chatId: chatId, type: 'video', url: url, duration: secs });
    }).then(function () {
      resetVideo();
      $('vOverlay').hidden = true;
    }).catch(function (e) { toast(e.message); }).then(function () { $('vSend').disabled = false; });
  });

  /* ---------- Вкладки: чаты, поиск, профиль ---------- */
  var tabs = ['chats', 'search', 'profile'];
  document.querySelectorAll('.tabs .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      tabs.forEach(function (t) { $('panel-' + t).hidden = t !== b.dataset.tab; });
      document.querySelectorAll('.tabs .seg-btn').forEach(function (x) { x.classList.toggle('on', x === b); });
      if (b.dataset.tab === 'search') $('searchInput').focus();
    });
  });
  function showTab(name) {
    var btn = document.querySelector('.tabs .seg-btn[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  var searchTimer = null;
  $('searchInput').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = $('searchInput').value.trim();
    var box = $('searchResults');
    if (q.length < 2) { box.textContent = ''; return; }
    searchTimer = setTimeout(function () {
      api('/api/search?q=' + encodeURIComponent(q)).then(function (d) {
        box.textContent = '';
        if (!d.users.length && !d.channels.length) { box.appendChild(el('div', 'empty-list', 'Ничего не найдено')); return; }
        if (d.users.length) box.appendChild(el('div', 'sec-title', 'Люди'));
        d.users.forEach(function (u) {
          var row = el('button', 'row'); row.type = 'button';
          row.appendChild(avatar(u.name, u.id, false, false));
          var main = el('div', 'row-main');
          main.appendChild(el('span', 'row-name', u.name));
          main.appendChild(el('span', 'row-last', '@' + u.username + (u.online ? ' · в сети' : '')));
          row.appendChild(main);
          row.appendChild(el('span', ''));
          row.addEventListener('click', function () {
            api('/api/chats/dm', 'POST', { userId: u.id }).then(function (r) { return openAfter(r.chat); }).catch(function (e) { toast(e.message); });
          });
          box.appendChild(row);
        });
        if (d.channels.length) box.appendChild(el('div', 'sec-title', 'Каналы'));
        d.channels.forEach(function (c) {
          var row = el('button', 'row'); row.type = 'button';
          row.appendChild(avatar(c.title, c.id, false, true));
          var main = el('div', 'row-main');
          main.appendChild(el('span', 'row-name', c.title));
          main.appendChild(el('span', 'row-last', c.about || ('Подписчиков: ' + c.membersCount)));
          row.appendChild(main);
          row.appendChild(el('span', 'btn', c.joined ? 'Открыть' : 'Вступить'));
          row.addEventListener('click', function () {
            api('/api/channels/' + c.id + '/join', 'POST').then(function (r) { return openAfter(r.chat); }).catch(function (e) { toast(e.message); });
          });
          box.appendChild(row);
        });
      }).catch(function (e) { toast(e.message); });
    }, 300);
  });

  function openAfter(chat) {
    return loadChats().then(function () {
      showTab('chats');
      openChat(chat.id);
    });
  }

  $('channelForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/api/chats/channel', 'POST', { title: $('chTitle').value, about: $('chAbout').value }).then(function (r) {
      $('chTitle').value = ''; $('chAbout').value = '';
      return openAfter(r.chat);
    }).catch(function (err) { toast(err.message); });
  });

  $('profileForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/api/me', 'POST', { name: $('profName').value }).then(function (d) {
      me = d.user;
      toast('Имя сохранено');
    }).catch(function (err) { toast(err.message); });
  });

  /* ---------- Старт страницы ---------- */
  setMode(false);
  if (token) {
    api('/api/me').then(function (d) { start(d.user); }).catch(function () { $('auth').hidden = false; });
  } else {
    $('auth').hidden = false;
  }
})();
