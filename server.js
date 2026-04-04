const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname)));

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
        setTimeout(() => { if (room.isEmpty()) rooms.delete(roomCode); }, 300000);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port ' + PORT));

// ============================================================
const HAND_SIZE = 5;

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
    this.imageFiles = [];
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
      case 'startGame': return this.handleStartGame(ws);
      case 'storyteller': return this.handleStoryteller(ws, data);
      case 'contribute': return this.handleContribute(ws, data);
      case 'vote': return this.handleVote(ws, data);
      case 'nextRound': return this.handleNextRound(ws);
    }
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
    this.imageFiles = data.imageFiles || [];
    this.players.push({ name: data.name, score: 0, hand: [], connId: ws._connId, connected: true });
    ws.send(JSON.stringify({ type: 'joined', playerIdx: 0, roomCode: this.roomCode }));
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
    if (this.imageFiles.length < this.players.length * 2) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Мало карт!' }));
      return;
    }
    this.allCardIds = this.imageFiles.map((_, i) => 'card_' + i);
    this.round = 0;
    this.storytellerIdx = 0;
    this.players.forEach(p => { p.score = 0; p.hand = []; });
    this.dealHands();
    this.startRound();
  }

  handleStoryteller(ws, data) {
    const pidx = this.getPlayerIdx(ws);
    if (this.phase !== 'storyteller' || pidx !== this.storytellerIdx) return;
    this.storytellerCard = data.cardId;
    this.clue = data.clue;
    this.players[pidx].hand = this.players[pidx].hand.filter(c => c !== data.cardId);
    this.contributions.push({ playerIdx: pidx, cardId: data.cardId });
    this.phase = 'contribute';
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

  dealHands() {
    const inHands = new Set();
    this.players.forEach(p => p.hand.forEach(c => inHands.add(c)));
    this.deck = shuffle(this.allCardIds.filter(id => !inHands.has(id)));
    let dealing = true;
    while (dealing) {
      dealing = false;
      for (const p of this.players) {
        if (p.hand.length < HAND_SIZE && this.deck.length > 0) {
          p.hand.push(this.deck.pop());
          dealing = true;
        }
      }
    }
  }

  startRound() {
    this.round++;
    this.storytellerCard = null;
    this.clue = '';
    this.contributions = [];
    this.votes = [];
    this.shuffledPool = [];
    this.roundScores = {};
    this.phase = 'storyteller';
    this.sendState();
  }

  checkContributeDone() {
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    if (this.contributions.length >= 1 + (this.players.length - 1) * cardsNeeded) {
      this.shuffledPool = shuffle(this.contributions.map(c => ({ cardId: c.cardId, ownerIdx: c.playerIdx })));
      this.phase = 'vote';
      this.sendState();
      this.checkVoteDone();
    }
  }

  checkVoteDone() {
    if (this.votes.length >= this.players.length - 1) {
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
      scores[stIdx] += 3;
      correct.forEach(v => scores[v.voterIdx] += 3);
    }
    nonSt.forEach(oi => {
      this.contributions.filter(c => c.playerIdx === oi).forEach(c => {
        scores[oi] += this.votes.filter(v => v.cardId === c.cardId).length;
      });
    });
    this.players.forEach((p, i) => p.score += scores[i]);
    this.roundScores = scores;
  }

  sendState() {
    for (const ws of this.conns) {
      const pidx = this.players.findIndex(p => p.connId === ws._connId);
      if (pidx < 0) continue;
      try { ws.send(JSON.stringify(this.buildStateFor(pidx))); } catch {}
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
    };
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
      type: 'lobby', players: this.players.map(p => ({ name: p.name })),
      winScore: this.winScore, roomCode: this.roomCode,
      imageFiles: this.imageFiles,
    });
    for (const ws of this.conns) { try { ws.send(msg); } catch {} }
  }
}
