const HAND_SIZE = 5;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default class XaxitServer {
  constructor(room) {
    this.room = room;
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

  onConnect(conn, ctx) {
    // wait for join/create message
  }

  onMessage(raw, sender) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    switch (data.type) {
      case 'create': return this.handleCreate(sender, data);
      case 'join': return this.handleJoin(sender, data);
      case 'rejoin': return this.handleRejoin(sender, data);
      case 'startGame': return this.handleStartGame(sender);
      case 'storyteller': return this.handleStoryteller(sender, data);
      case 'contribute': return this.handleContribute(sender, data);
      case 'vote': return this.handleVote(sender, data);
      case 'nextRound': return this.handleNextRound(sender);
    }
  }

  onClose(conn) {
    const pidx = this.players.findIndex(p => p.connId === conn.id);
    if (pidx < 0) return;
    this.players[pidx].connId = null;
    this.players[pidx].connected = false;
    if (this.phase === 'lobby') {
      this.players.splice(pidx, 1);
      this.broadcastLobby();
    }
  }

  handleCreate(conn, data) {
    if (this.players.length > 0) {
      conn.send(JSON.stringify({ type: 'error', msg: 'Комната уже существует' }));
      return;
    }
    this.winScore = data.winScore || 32;
    this.imageFiles = data.imageFiles || [];
    this.players.push({ name: data.name, score: 0, hand: [], connId: conn.id, connected: true });
    conn.send(JSON.stringify({ type: 'joined', playerIdx: 0, roomCode: this.room.id }));
    this.broadcastLobby();
  }

  handleJoin(conn, data) {
    if (this.phase !== 'lobby') {
      conn.send(JSON.stringify({ type: 'error', msg: 'Игра уже началась' }));
      return;
    }
    if (this.players.length >= 8) {
      conn.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена' }));
      return;
    }
    const idx = this.players.length;
    this.players.push({ name: data.name, score: 0, hand: [], connId: conn.id, connected: true });
    conn.send(JSON.stringify({ type: 'joined', playerIdx: idx, roomCode: this.room.id }));
    this.broadcastLobby();
  }

  handleRejoin(conn, data) {
    const pidx = this.players.findIndex(p => p.name === data.name);
    if (pidx < 0) {
      conn.send(JSON.stringify({ type: 'error', msg: 'Игрок не найден' }));
      return;
    }
    this.players[pidx].connId = conn.id;
    this.players[pidx].connected = true;
    conn.send(JSON.stringify({ type: 'rejoined', playerIdx: pidx }));
    if (this.phase === 'lobby') {
      this.broadcastLobby();
    } else {
      this.sendState();
    }
  }

  handleStartGame(conn) {
    const pidx = this.getPlayerIdx(conn);
    if (pidx !== 0) return;
    if (this.players.length < 2) return;
    const totalCards = this.imageFiles.length;
    if (totalCards < this.players.length * 2) {
      conn.send(JSON.stringify({ type: 'error', msg: 'Мало карт! Нужно ' + (this.players.length * 2) + ', есть ' + totalCards }));
      return;
    }
    this.allCardIds = this.imageFiles.map((_, i) => 'card_' + i);
    this.round = 0;
    this.storytellerIdx = 0;
    this.players.forEach(p => { p.score = 0; p.hand = []; });
    this.dealHands();
    this.startRound();
  }

  handleStoryteller(conn, data) {
    const pidx = this.getPlayerIdx(conn);
    if (this.phase !== 'storyteller' || pidx !== this.storytellerIdx) return;
    this.storytellerCard = data.cardId;
    this.clue = data.clue;
    this.players[pidx].hand = this.players[pidx].hand.filter(c => c !== data.cardId);
    this.contributions.push({ playerIdx: pidx, cardId: data.cardId });
    this.phase = 'contribute';
    this.sendState();
    this.checkContributeDone();
  }

  handleContribute(conn, data) {
    const pidx = this.getPlayerIdx(conn);
    if (this.phase !== 'contribute') return;
    if (pidx === this.storytellerIdx) return;
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    const myContribs = this.contributions.filter(c => c.playerIdx === pidx).length;
    if (myContribs >= cardsNeeded) return;
    this.players[pidx].hand = this.players[pidx].hand.filter(c => c !== data.cardId);
    this.contributions.push({ playerIdx: pidx, cardId: data.cardId });
    this.sendState();
    this.checkContributeDone();
  }

  handleVote(conn, data) {
    const pidx = this.getPlayerIdx(conn);
    if (this.phase !== 'vote') return;
    if (pidx === this.storytellerIdx) return;
    if (this.votes.find(v => v.voterIdx === pidx)) return;
    this.votes.push({ voterIdx: pidx, cardId: data.cardId });
    this.sendState();
    this.checkVoteDone();
  }

  handleNextRound(conn) {
    const pidx = this.getPlayerIdx(conn);
    if (pidx !== 0) return;
    if (this.players.some(p => p.score >= this.winScore)) return;
    this.storytellerIdx = (this.storytellerIdx + 1) % this.players.length;
    this.dealHands();
    this.startRound();
  }

  getPlayerIdx(conn) {
    return this.players.findIndex(p => p.connId === conn.id);
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
    const needed = 1 + (this.players.length - 1) * cardsNeeded;
    if (this.contributions.length >= needed) {
      this.shuffledPool = shuffle(this.contributions.map(c => ({ cardId: c.cardId, ownerIdx: c.playerIdx })));
      this.phase = 'vote';
      this.sendState();
      this.checkVoteDone();
    }
  }

  checkVoteDone() {
    const needed = this.players.length - 1;
    if (this.votes.length >= needed) {
      this.calculateScores();
      this.phase = 'results';
      this.sendState();
    }
  }

  calculateScores() {
    const scores = {};
    this.players.forEach((_, i) => scores[i] = 0);
    const stCard = this.storytellerCard;
    const stIdx = this.storytellerIdx;
    const nonSt = this.players.map((_, i) => i).filter(i => i !== stIdx);
    const correctVoters = this.votes.filter(v => v.cardId === stCard);
    const allFound = correctVoters.length === nonSt.length;
    const noneFound = correctVoters.length === 0;

    if (allFound || noneFound) {
      nonSt.forEach(i => scores[i] += 2);
    } else {
      scores[stIdx] += 3;
      correctVoters.forEach(v => scores[v.voterIdx] += 3);
    }

    nonSt.forEach(ownerIdx => {
      const ownerCards = this.contributions.filter(c => c.playerIdx === ownerIdx).map(c => c.cardId);
      ownerCards.forEach(cardId => {
        scores[ownerIdx] += this.votes.filter(v => v.cardId === cardId).length;
      });
    });

    this.players.forEach((p, i) => p.score += scores[i]);
    this.roundScores = scores;
  }

  sendState() {
    for (const conn of this.room.getConnections()) {
      const pidx = this.players.findIndex(p => p.connId === conn.id);
      if (pidx < 0) continue;
      conn.send(JSON.stringify(this.buildStateFor(pidx)));
    }
  }

  buildStateFor(idx) {
    const cardsNeeded = this.players.length < 4 ? 2 : 1;
    const state = {
      type: 'state',
      phase: this.phase,
      players: this.players.map(p => ({ name: p.name, score: p.score })),
      round: this.round,
      winScore: this.winScore,
      storytellerIdx: this.storytellerIdx,
      clue: this.clue,
      myIdx: idx,
      hand: [...this.players[idx].hand],
      contributedCount: this.contributions.length - 1,
      totalNonSt: this.players.length - 1,
      cardsNeeded,
      votedCount: this.votes.length,
      isCreator: idx === 0,
    };

    if (this.phase === 'vote' || this.phase === 'results') {
      state.pool = this.shuffledPool.map(e => e.cardId);
    }
    if (this.phase === 'contribute') {
      const myContribs = this.contributions.filter(c => c.playerIdx === idx).length;
      const isSt = idx === this.storytellerIdx;
      state.myContribCount = isSt ? 0 : myContribs;
      state.totalContribNeeded = (this.players.length - 1) * cardsNeeded;
      state.alreadyContributed = !isSt && myContribs >= cardsNeeded;
    }
    if (this.phase === 'vote') {
      state.ownCardIds = this.contributions.filter(c => c.playerIdx === idx).map(c => c.cardId);
      state.alreadyVoted = this.votes.some(v => v.voterIdx === idx);
    }
    if (this.phase === 'results') {
      state.results = {
        storytellerCard: this.storytellerCard,
        pool: this.shuffledPool.map(e => ({
          cardId: e.cardId,
          ownerIdx: e.ownerIdx,
          ownerName: this.players[e.ownerIdx].name,
          isStoryteller: e.cardId === this.storytellerCard,
          voters: this.votes.filter(v => v.cardId === e.cardId).map(v => this.players[v.voterIdx].name)
        })),
        roundScores: this.roundScores,
        isGameOver: this.players.some(p => p.score >= this.winScore)
      };
    }

    return state;
  }

  broadcastLobby() {
    const msg = JSON.stringify({
      type: 'lobby',
      players: this.players.map(p => ({ name: p.name })),
      winScore: this.winScore,
      roomCode: this.room.id,
      imageFiles: this.imageFiles,
    });
    for (const conn of this.room.getConnections()) {
      conn.send(msg);
    }
  }
}
