const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Image storage: roomCode -> Map<id, Buffer>
const roomImages = new Map();

// Upload images for a room
app.post('/upload/:roomCode', upload.array('images', 300), (req, res) => {
  const code = req.params.roomCode.toUpperCase();
  if (!roomImages.has(code)) roomImages.set(code, new Map());
  const store = roomImages.get(code);
  const urls = [];
  for (const file of (req.files || [])) {
    const id = store.size;
    store.set(id, { buffer: file.buffer, mime: file.mimetype || 'image/jpeg' });
    urls.push('/img/' + code + '/' + id);
  }
  res.json({ urls });
});

// Serve images
app.get('/img/:roomCode/:id', (req, res) => {
  const store = roomImages.get(req.params.roomCode.toUpperCase());
  const img = store?.get(parseInt(req.params.id));
  if (!img) return res.status(404).end();
  res.set('Content-Type', img.mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(img.buffer);
});

// SPA: serve index.html for all non-file routes
app.use(express.static(path.join(__dirname), { index: false }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/ws/') || req.path.startsWith('/img/') || req.path.startsWith('/upload/')) return;
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const rooms = new Map();
let connIdCounter = 0;

server.on('upgrade', (req, socket, head) => {
  const match = req.url.match(/^\/ws\/([A-Z0-9]{4})$/);
  if (!match) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const roomCode = match[1];
    if (!rooms.has(roomCode)) rooms.set(roomCode, new GameRoom(roomCode));
    const room = rooms.get(roomCode);
    ws._connId = String(++connIdCounter);
    room.onConnect(ws);
    ws.on('message', (raw) => room.onMessage(String(raw), ws));
    ws.on('close', () => {
      room.onClose(ws);
      if (room.isEmpty()) {
        setTimeout(() => {
          if (room.isEmpty()) {
            rooms.delete(roomCode);
            roomImages.delete(roomCode);
          }
        }, 300000);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port ' + PORT));

// ============================================================
const HAND_SIZE = 6;
const HAND_SIZE_3P = 7;
const STORYTELLER_TIMEOUT = 60000;
const ACTION_TIMEOUT = 30000;

const BOT_NAMES = [
  'Кеша', 'Буба', 'Шарик', 'Мурзик', 'Пупок', 'Зефир', 'Бублик', 'Кекс',
  'Тостер', 'Пончик', 'Батон', 'Сырок', 'Компот', 'Хрюша', 'Лунтик', 'Чебурек',
  'Пельмень', 'Вафля', 'Кнопка', 'Шуруп',
];
const BOT_CLUES = [
  'Красивая штука', 'Это напоминает мне детство', 'Просто вайб', 'Глубокий смысл',
  'Эмоции и чувства', 'Когда ты дома один', 'Философия жизни', 'Необъяснимое',
  'Сон в летнюю ночь', 'Дежавю', 'Тёплые носки', 'Понедельник утром',
  'Мой внутренний мир', 'Загадка природы', 'Бабушкин совет', 'Мечта идиота',
  'Путь самурая', 'Когда забыл зачем пришёл', 'Искусство быть собой',
  'Это не то чем кажется', 'Случайность не случайна', 'Тайный знак',
  'Вкус свободы', 'Нежданчик', 'Ветер перемен', 'Сила мысли',
  'Запах дождя', 'Космос внутри', 'Последний кусок пиццы',
  'Грустный клоун', 'Когда мама звонит', 'Пятница вечер', 'Утро без кофе',
  'Бесконечная лестница', 'Счастье в мелочах', 'Ошибка 404', 'Дорога в никуда',
  'Первый снег', 'Забытый пароль', 'Танец в темноте', 'Чужие тапки',
  'Секрет бабушки', 'Тишина перед бурей', 'Сломанный зонт', 'Кот на клавиатуре',
  'Неловкая пауза', 'Третий звонок', 'Когда никто не смотрит', 'Зов пустоты',
  'Шаг в неизвестность', 'Вчерашний суп', 'Предчувствие', 'Эффект бабочки',
  'Всё не так просто', 'Шёпот стен', 'Синдром самозванца', 'Сладкая ложь',
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class GameRoom {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.conns = new Set();
    this.players = [];
    this.imageCount = 0;
    this.allCardIds = [];
    this.deck = [];
    this.phase = 'lobby';
    this.round = 0;
    this.winScore = 32;
    this.storytellerIdx = 0;
    this.storytellerCard = null;
    this.clue = '';
    this.contributions = [];
    this.votes = [];
    this.shuffledPool = [];
    this.roundScores = {};
    this.roundLog = [];
    this.usedCards = new Set();
    this.settings = { storytellerTimer: true, actionTimer: true };
    this.stickerCooldowns = {};
    // Timers
    this.stTimer = null; this.stDeadline = null;
    this.ctTimer = null; this.ctDeadline = null;
    this.vtTimer = null; this.vtDeadline = null;
  }

  isEmpty() { return this.conns.size === 0; }
  onConnect(ws) { this.conns.add(ws); }

  onMessage(raw, ws) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    switch (data.type) {
      case 'create': return this.handleCreate(ws, data);
      case 'join': return this.handleJoin(ws, data);
      case 'rejoin': return this.handleRejoin(ws, data);
      case 'addBot': return this.handleAddBot(ws);
      case 'removeBot': return this.handleRemoveBot(ws, data);
      case 'startGame': return this.handleStartGame(ws);
      case 'endGame': return this.handleEndGame(ws);
      case 'storyteller': return this.handleStoryteller(ws, data);
      case 'contribute': return this.handleContribute(ws, data);
      case 'vote': return this.handleVote(ws, data);
      case 'nextRound': return this.handleNextRound(ws);
      case 'sticker': return this.handleSticker(ws, data);
    }
  }

  handleSticker(ws, data) {
    const VALID = ['burger','ivanhitler','kobyakov','kuplinov','litvin','locked','malena','simple'];
    if (!data.stickerId || !VALID.includes(data.stickerId)) return;
    const pidx = this.getPlayerIdx(ws);
    if (pidx < 0) return;
    const now = Date.now();
    if (this.stickerCooldowns[pidx] && now - this.stickerCooldowns[pidx] < 2000) return;
    this.stickerCooldowns[pidx] = now;
    const msg = JSON.stringify({ type: 'sticker', senderName: this.players[pidx].name, stickerId: data.stickerId });
    for (const c of this.conns) { try { c.send(msg); } catch {} }
  }

  onClose(ws) {
    this.conns.delete(ws);
    const pidx = this.players.findIndex(p => p.connId === ws._connId);
    if (pidx < 0) return;
    this.players[pidx].connId = null;
    this.players[pidx].connected = false;
    if (this.phase === 'lobby') {
      this.players.splice(pidx, 1);
      this.broadcastLobby();
    }
  }

  handleCreate(ws, data) {
    if (this.players.length > 0) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Комната уже существует' }));
      return;
    }
    this.winScore = data.winScore || 32;
    this.imageCount = data.imageCount || 0;
    if (data.settings) this.settings = { ...this.settings, ...data.settings };
    this.players.push({ name: data.name, score: 0, hand: [], connId: ws._connId, connected: true });
    ws.send(JSON.stringify({ type: 'joined', playerIdx: 0, roomCode: this.roomCode }));
    this.broadcastLobby();
  }

  handleAddBot(ws) {
    if (this.getPlayerIdx(ws) !== 0) return;
    if (this.phase !== 'lobby') return;
    if (this.players.length >= 8) return;
    const usedNames = new Set(this.players.map(p => p.name));
    const available = BOT_NAMES.filter(n => !usedNames.has(n));
    const name = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : 'Бот' + this.players.length;
    this.players.push({ name, score: 0, hand: [], connId: null, connected: true, isBot: true });
    this.broadcastLobby();
  }

  handleRemoveBot(ws, data) {
    if (this.getPlayerIdx(ws) !== 0) return;
    if (this.phase !== 'lobby') return;
    const idx = data.idx;
    if (idx < 1 || idx >= this.players.length || !this.players[idx].isBot) return;
    this.players.splice(idx, 1);
    this.broadcastLobby();
  }

  handleJoin(ws, data) {
    if (this.phase !== 'lobby') {
      ws.send(JSON.stringify({ type: 'error', msg: 'Игра уже началась' }));
      return;
    }
    if (this.players.length >= 8) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена' }));
      return;
    }
    const idx = this.players.length;
    this.players.push({ name: data.name, score: 0, hand: [], connId: ws._connId, connected: true });
    ws.send(JSON.stringify({ type: 'joined', playerIdx: idx, roomCode: this.roomCode }));
    this.broadcastLobby();
  }

  handleRejoin(ws, data) {
    const pidx = this.players.findIndex(p => p.name === data.name);
    if (pidx < 0) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Игрок не найден' }));
      return;
    }
    this.players[pidx].connId = ws._connId;
    this.players[pidx].connected = true;
    ws.send(JSON.stringify({ type: 'rejoined', playerIdx: pidx }));
    if (this.phase === 'lobby') this.broadcastLobby();
    else this.sendState();
  }

  handleStartGame(ws) {
    if (this.getPlayerIdx(ws) !== 0) return;
    if (this.players.length < 2) return;
    if (this.imageCount < this.players.length * 2) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Мало карт!' }));
      return;
    }
    this.allCardIds = Array.from({ length: this.imageCount }, (_, i) => 'card_' + i);
    this.round = 0;
    this.storytellerIdx = 0;
    this.players.forEach(p => { p.score = 0; p.hand = []; });
    this.dealHands();
    this.startRound();
  }

  handleEndGame(ws) {
    if (this.getPlayerIdx(ws) !== 0) return;
    if (this.phase === 'lobby') return;
    this.clearAllTimers();
    this.phase = 'lobby';
    this.round = 0;
    this.roundLog = [];
    this.players = this.players.filter(p => !p.isBot);
    this.players.forEach(p => { p.score = 0; p.hand = []; });
    this.broadcastLobby();
  }

  handleStoryteller(ws, data) {
    const pidx = this.getPlayerIdx(ws);
    if (this.phase !== 'storyteller' || pidx !== this.storytellerIdx) return;
    this.clearTimer('st');
    this.storytellerCard = data.cardId;
    this.clue = data.clue;
    this.players[pidx].hand = this.players[pidx].hand.filter(c => c !== data.cardId);
    this.contributions.push({ playerIdx: pidx, cardId: data.cardId });
    this.phase = 'contribute';
    this.startActionTimer('ct');
    this.sendState();
    this.checkContributeDone();
  }

  handleContribute(ws, data) {
    const pidx = this.getPlayerIdx(ws);
    if (this.phase !== 'contribute' || pidx === this.storytellerIdx) return;
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    if (this.contributions.filter(c => c.playerIdx === pidx).length >= cardsNeeded) return;
    this.players[pidx].hand = this.players[pidx].hand.filter(c => c !== data.cardId);
    this.contributions.push({ playerIdx: pidx, cardId: data.cardId });
    this.sendState();
    this.checkContributeDone();
  }

  handleVote(ws, data) {
    const pidx = this.getPlayerIdx(ws);
    if (this.phase !== 'vote' || pidx === this.storytellerIdx) return;
    if (this.votes.find(v => v.voterIdx === pidx)) return;
    this.votes.push({ voterIdx: pidx, cardId: data.cardId });
    this.sendState();
    this.checkVoteDone();
  }

  handleNextRound(ws) {
    if (this.getPlayerIdx(ws) !== 0) return;
    if (this.players.some(p => p.score >= this.winScore)) return;
    this.storytellerIdx = (this.storytellerIdx + 1) % this.players.length;
    this.dealHands();
    this.startRound();
  }

  getPlayerIdx(ws) {
    return this.players.findIndex(p => p.connId === ws._connId);
  }

  // --- Timer system ---
  clearTimer(which) {
    if (this[which + 'Timer']) { clearTimeout(this[which + 'Timer']); this[which + 'Timer'] = null; }
    this[which + 'Deadline'] = null;
  }
  clearAllTimers() { this.clearTimer('st'); this.clearTimer('ct'); this.clearTimer('vt'); }

  startStorytellerTimer() {
    if (!this.settings.storytellerTimer) return;
    this.clearTimer('st');
    this.stDeadline = Date.now() + STORYTELLER_TIMEOUT;
    this.stTimer = setTimeout(() => {
      if (this.phase !== 'storyteller') return;
      const st = this.players[this.storytellerIdx];
      if (!st || st.hand.length === 0) return;
      const cardId = st.hand[Math.floor(Math.random() * st.hand.length)];
      this.storytellerCard = cardId;
      this.clue = '...';
      st.hand = st.hand.filter(c => c !== cardId);
      this.contributions.push({ playerIdx: this.storytellerIdx, cardId });
      this.phase = 'contribute';
      this.clearTimer('st');
      this.startActionTimer('ct');
      this.sendState();
      this.checkContributeDone();
    }, STORYTELLER_TIMEOUT);
  }

  startActionTimer(which) {
    if (!this.settings.actionTimer) return;
    this.clearTimer(which);
    this[which + 'Deadline'] = Date.now() + ACTION_TIMEOUT;
    this[which + 'Timer'] = setTimeout(() => {
      if (which === 'ct') this.autoContribute();
      else if (which === 'vt') this.autoVote();
    }, ACTION_TIMEOUT);
  }

  autoContribute() {
    if (this.phase !== 'contribute') return;
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    for (let i = 0; i < this.players.length; i++) {
      if (i === this.storytellerIdx) continue;
      const p = this.players[i];
      const mc = this.contributions.filter(c => c.playerIdx === i).length;
      const remaining = cardsNeeded - mc;
      for (let j = 0; j < remaining && p.hand.length > 0; j++) {
        const pick = p.hand[Math.floor(Math.random() * p.hand.length)];
        p.hand = p.hand.filter(c => c !== pick);
        this.contributions.push({ playerIdx: i, cardId: pick });
      }
    }
    this.clearTimer('ct');
    this.sendState();
    this.checkContributeDone();
  }

  autoVote() {
    if (this.phase !== 'vote') return;
    for (let i = 0; i < this.players.length; i++) {
      if (i === this.storytellerIdx) continue;
      if (this.votes.find(v => v.voterIdx === i)) continue;
      const ownCards = new Set(this.contributions.filter(c => c.playerIdx === i).map(c => c.cardId));
      const votable = this.shuffledPool.filter(e => !ownCards.has(e.cardId));
      if (votable.length === 0) continue;
      const pick = votable[Math.floor(Math.random() * votable.length)];
      this.votes.push({ voterIdx: i, cardId: pick.cardId });
    }
    this.clearTimer('vt');
    this.sendState();
    this.checkVoteDone();
  }

  // --- Game logic ---
  dealHands() {
    const inHands = new Set();
    this.players.forEach(p => p.hand.forEach(c => inHands.add(c)));
    let fresh = this.allCardIds.filter(id => !inHands.has(id) && !this.usedCards.has(id));
    const hs = this.players.length < 4 ? HAND_SIZE_3P : HAND_SIZE;
    if (fresh.length < this.players.length * hs) {
      this.usedCards.clear();
      fresh = this.allCardIds.filter(id => !inHands.has(id));
    }
    this.deck = shuffle(fresh);
    let dealing = true;
    while (dealing) {
      dealing = false;
      for (const p of this.players) {
        if (p.hand.length < hs && this.deck.length > 0) {
          p.hand.push(this.deck.pop());
          dealing = true;
        }
      }
    }
  }

  startRound() {
    this.contributions.forEach(c => this.usedCards.add(c.cardId));
    this.round++;
    this.storytellerCard = null;
    this.clue = '';
    this.contributions = [];
    this.votes = [];
    this.shuffledPool = [];
    this.roundScores = {};
    this.phase = 'storyteller';
    this.startStorytellerTimer();
    this.sendState();
  }

  checkContributeDone() {
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    if (this.contributions.length >= 1 + (this.players.length - 1) * cardsNeeded) {
      this.clearTimer('ct');
      this.shuffledPool = shuffle(this.contributions.map(c => ({ cardId: c.cardId, ownerIdx: c.playerIdx })));
      this.phase = 'vote';
      this.startActionTimer('vt');
      this.sendState();
      this.checkVoteDone();
    }
  }

  checkVoteDone() {
    const nonBotNonSt = this.players.filter((p, i) => i !== this.storytellerIdx && !p.isBot);
    const humanVotes = this.votes.filter(v => nonBotNonSt.some((_, ni) => {
      const realIdx = this.players.findIndex((pp, ii) => ii !== this.storytellerIdx && !pp.isBot && pp === nonBotNonSt[ni]);
      return v.voterIdx === realIdx;
    }));
    // Simpler: just check total votes >= non-storyteller count
    if (this.votes.length >= this.players.length - 1) {
      this.clearTimer('vt');
      this.calculateScores();
      this.phase = 'results';
      this.sendState();
    }
  }

  calculateScores() {
    const scores = {};
    this.players.forEach((_, i) => scores[i] = 0);
    const stIdx = this.storytellerIdx;
    const nonSt = this.players.map((_, i) => i).filter(i => i !== stIdx);
    const correct = this.votes.filter(v => v.cardId === this.storytellerCard);
    if (correct.length === nonSt.length || correct.length === 0) {
      nonSt.forEach(i => scores[i] += 2);
    } else {
      const bonus = (this.players.length === 3 && correct.length === 1) ? 4 : 3;
      scores[stIdx] += bonus;
      correct.forEach(v => scores[v.voterIdx] += bonus);
    }
    nonSt.forEach(oi => {
      this.contributions.filter(c => c.playerIdx === oi).forEach(c => {
        scores[oi] += this.votes.filter(v => v.cardId === c.cardId).length;
      });
    });
    this.players.forEach((p, i) => p.score += scores[i]);
    this.roundScores = scores;
    this.roundLog.push({
      round: this.round,
      clue: this.clue,
      scores: this.players.map((p, i) => ({ name: p.name, pts: scores[i] || 0 }))
    });
  }

  sendState() {
    for (const ws of this.conns) {
      const pidx = this.players.findIndex(p => p.connId === ws._connId);
      if (pidx < 0) continue;
      try { ws.send(JSON.stringify(this.buildStateFor(pidx))); } catch {}
    }
    setTimeout(() => this.botTick(), 800 + Math.random() * 1200);
  }

  botTick() {
    const bots = this.players.map((p, i) => ({ ...p, idx: i })).filter(p => p.isBot);
    if (bots.length === 0) return;

    if (this.phase === 'storyteller') {
      const bot = bots.find(b => b.idx === this.storytellerIdx);
      if (!bot) return;
      const cardId = bot.hand[Math.floor(Math.random() * bot.hand.length)];
      const clue = BOT_CLUES[Math.floor(Math.random() * BOT_CLUES.length)];
      this.storytellerCard = cardId;
      this.clue = clue;
      this.players[bot.idx].hand = this.players[bot.idx].hand.filter(c => c !== cardId);
      this.contributions.push({ playerIdx: bot.idx, cardId });
      this.clearTimer('st');
      this.phase = 'contribute';
      this.startActionTimer('ct');
      this.sendState();
      this.checkContributeDone();
      return;
    }

    if (this.phase === 'contribute') {
      const cardsNeeded = this.players.length < 4 ? 2 : 1;
      for (const bot of bots) {
        if (bot.idx === this.storytellerIdx) continue;
        const myContribs = this.contributions.filter(c => c.playerIdx === bot.idx).length;
        if (myContribs >= cardsNeeded) continue;
        const remaining = cardsNeeded - myContribs;
        const hand = [...this.players[bot.idx].hand];
        for (let i = 0; i < remaining && hand.length > 0; i++) {
          const pick = hand.splice(Math.floor(Math.random() * hand.length), 1)[0];
          this.players[bot.idx].hand = this.players[bot.idx].hand.filter(c => c !== pick);
          this.contributions.push({ playerIdx: bot.idx, cardId: pick });
        }
      }
      this.sendState();
      this.checkContributeDone();
      return;
    }

    if (this.phase === 'vote') {
      for (const bot of bots) {
        if (bot.idx === this.storytellerIdx) continue;
        if (this.votes.find(v => v.voterIdx === bot.idx)) continue;
        const ownCards = new Set(this.contributions.filter(c => c.playerIdx === bot.idx).map(c => c.cardId));
        const votable = this.shuffledPool.filter(e => !ownCards.has(e.cardId));
        if (votable.length === 0) continue;
        const pick = votable[Math.floor(Math.random() * votable.length)];
        this.votes.push({ voterIdx: bot.idx, cardId: pick.cardId });
      }
      this.sendState();
      this.checkVoteDone();
      return;
    }
  }

  buildStateFor(idx) {
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    const s = {
      type: 'state', phase: this.phase,
      players: this.players.map(p => ({ name: p.name, score: p.score })),
      round: this.round, winScore: this.winScore,
      storytellerIdx: this.storytellerIdx, clue: this.clue,
      myIdx: idx, hand: [...this.players[idx].hand],
      contributedCount: this.contributions.length - 1,
      totalNonSt: this.players.length - 1,
      cardsNeeded, votedCount: this.votes.length,
      isCreator: idx === 0,
      roundLog: this.roundLog,
      storytellerName: this.players[this.storytellerIdx]?.name || '',
      imageCount: this.imageCount,
      settings: this.settings,
    };
    // Timer info for whichever phase is active
    if (this.phase === 'storyteller' && this.stDeadline) {
      s.timerRemaining = Math.max(0, this.stDeadline - Date.now());
      s.timerTotal = STORYTELLER_TIMEOUT;
    }
    if (this.phase === 'contribute' && this.ctDeadline) {
      s.timerRemaining = Math.max(0, this.ctDeadline - Date.now());
      s.timerTotal = ACTION_TIMEOUT;
    }
    if (this.phase === 'vote' && this.vtDeadline) {
      s.timerRemaining = Math.max(0, this.vtDeadline - Date.now());
      s.timerTotal = ACTION_TIMEOUT;
    }
    if (this.phase === 'vote' || this.phase === 'results')
      s.pool = this.shuffledPool.map(e => e.cardId);
    if (this.phase === 'contribute') {
      const mc = this.contributions.filter(c => c.playerIdx === idx).length;
      const isSt = idx === this.storytellerIdx;
      s.myContribCount = isSt ? 0 : mc;
      s.totalContribNeeded = (this.players.length - 1) * cardsNeeded;
      s.alreadyContributed = !isSt && mc >= cardsNeeded;
    }
    if (this.phase === 'vote') {
      s.ownCardIds = this.contributions.filter(c => c.playerIdx === idx).map(c => c.cardId);
      s.alreadyVoted = this.votes.some(v => v.voterIdx === idx);
    }
    if (this.phase === 'results') {
      s.results = {
        storytellerCard: this.storytellerCard,
        pool: this.shuffledPool.map(e => ({
          cardId: e.cardId, ownerIdx: e.ownerIdx,
          ownerName: this.players[e.ownerIdx].name,
          isStoryteller: e.cardId === this.storytellerCard,
          voters: this.votes.filter(v => v.cardId === e.cardId).map(v => this.players[v.voterIdx].name)
        })),
        roundScores: this.roundScores,
        isGameOver: this.players.some(p => p.score >= this.winScore)
      };
    }
    return s;
  }

  broadcastLobby() {
    const msg = JSON.stringify({
      type: 'lobby', players: this.players.map(p => ({ name: p.name, isBot: !!p.isBot })),
      winScore: this.winScore, roomCode: this.roomCode,
      imageCount: this.imageCount,
      settings: this.settings,
    });
    for (const ws of this.conns) { try { ws.send(msg); } catch {} }
  }
}
