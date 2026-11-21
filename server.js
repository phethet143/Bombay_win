const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/colorgame';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 10000 },
  refCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  referralsCount: { type: Number, default: 0 },
  referralEarnings: { type: Number, default: 0 }
});

const roundSchema = new mongoose.Schema({
  room: String,
  period: String,
  number: Number,
  colors: [String],
  size: String,
  createdAt: { type: Date, default: Date.now }
});

const betSchema = new mongoose.Schema({
  username: String,
  room: String,
  period: String,
  selection: String,
  amount: Number,
  payout: { type: Number, default: 0 },
  status: { type: String, default: 'Pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Round = mongoose.model('Round', roundSchema);
const Bet = mongoose.model('Bet', betSchema);

const colorMap = {
  0: ['red', 'violet'], 1: ['green'], 2: ['red'], 3: ['green'], 4: ['red'],
  5: ['green', 'violet'], 6: ['red'], 7: ['green'], 8: ['red'], 9: ['green']
};

const rooms = {
  '30s': { duration: 30, timeLeft: 30, counter: Math.floor(Date.now() / 30000), forced: null },
  '1m':  { duration: 60, timeLeft: 60, counter: Math.floor(Date.now() / 60000), forced: null },
  '3m':  { duration: 180, timeLeft: 180, counter: Math.floor(Date.now() / 180000), forced: null },
  '5m':  { duration: 300, timeLeft: 300, counter: Math.floor(Date.now() / 300000), forced: null }
};

function getRoomPeriod(roomKey) {
  const d = new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = roomKey === '30s' ? '1' : roomKey === '1m' ? '2' : roomKey === '3m' ? '3' : '4';
  return `${datePart}${prefix}${String(rooms[roomKey].counter % 10000).padStart(4, '0')}`;
}

setInterval(async () => {
  const tickPayload = {};

  for (const key of Object.keys(rooms)) {
    const r = rooms[key];
    r.timeLeft--;

    if (r.timeLeft <= 0) {
      const finishedPeriod = getRoomPeriod(key);
      const winNum = r.forced !== null ? r.forced : Math.floor(Math.random() * 10);
      r.forced = null;

      const winColors = colorMap[winNum];
      const winSize = winNum >= 5 ? 'Big' : 'Small';

      await Round.create({ room: key, period: finishedPeriod, number: winNum, colors: winColors, size: winSize });

      const pendingBets = await Bet.find({ room: key, period: finishedPeriod, status: 'Pending' });
      for (const bet of pendingBets) {
        let winAmount = 0;
        const sel = bet.selection.toLowerCase();

        if (sel === String(winNum)) {
          winAmount = bet.amount * 9;
        } else if (sel === 'violet' && winColors.includes('violet')) {
          winAmount = bet.amount * 4.5;
        } else if ((sel === 'green' && winColors.includes('green')) || (sel === 'red' && winColors.includes('red'))) {
          winAmount = winColors.includes('violet') ? bet.amount * 1.5 : bet.amount * 2;
        } else if (sel === winSize.toLowerCase()) {
          winAmount = bet.amount * 2;
        }

        if (winAmount > 0) {
          bet.status = 'Won';
          bet.payout = winAmount;
          await User.updateOne({ username: bet.username }, { $inc: { balance: winAmount } });
        } else {
          bet.status = 'Lost';
        }
        await bet.save();
      }

      io.emit('roundResult', { room: key, period: finishedPeriod, winNum, winColors, winSize });
      r.counter++;
      r.timeLeft = r.duration;
    }

    tickPayload[key] = { period: getRoomPeriod(key), timeLeft: r.timeLeft };
  }

  io.emit('tickAll', tickPayload);
}, 1000);

app.post('/api/auth', async (req, res) => {
  try {
    const { username, password, mode, inviteCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username & password required' });

    if (mode === 'register') {
      const exists = await User.findOne({ username });
      if (exists) return res.status(400).json({ error: 'Username already taken' });

      const hash = await bcrypt.hash(password, 10);
      const myRefCode = username.slice(0, 4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
      let startBalance = 10000;
      let validReferrer = null;

      if (inviteCode && inviteCode.trim() !== '') {
        const referrer = await User.findOne({ refCode: inviteCode.trim().toUpperCase() });
        if (referrer) {
          validReferrer = referrer.username;
          startBalance += 500;
          referrer.balance += 500;
          referrer.referralsCount += 1;
          referrer.referralEarnings += 500;
          await referrer.save();
        }
      }

      const user = await User.create({
        username,
        password: hash,
        balance: startBalance,
        refCode: myRefCode,
        referredBy: validReferrer
      });
      return res.json({ username: user.username });
    } else {
      const user = await User.findOne({ username });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      return res.json({ username: user.username });
    }
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/state/:username/:room', async (req, res) => {
  const { username, room } = req.params;
  const user = await User.findOne({ username });
  const history = await Round.find({ room }).sort({ createdAt: -1 }).limit(15);
  const myBets = await Bet.find({ username, room }).sort({ createdAt: -1 }).limit(15);
  res.json({
    balance: user ? user.balance : 0,
    refCode: user ? user.refCode : '',
    referralsCount: user ? user.referralsCount : 0,
    referralEarnings: user ? user.referralEarnings : 0,
    history,
    myBets
  });
});

app.post('/api/bet', async (req, res) => {
  const { username, room, selection, amount } = req.body;
  if (!rooms[room]) return res.status(400).json({ error: 'Invalid room' });
  if (rooms[room].timeLeft <= 5) return res.status(400).json({ error: 'Betting locked!' });

  const user = await User.findOne({ username });
  if (!user || user.balance < amount || amount <= 0) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  user.balance -= amount;
  await user.save();

  const bet = await Bet.create({
    username,
    room,
    period: getRoomPeriod(room),
    selection: String(selection),
    amount
  });

  res.json({ balance: user.balance, bet });
});

const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
app.post('/api/admin/set-result', (req, res) => {
  const { key, room = '30s', number } = req.body;
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Wrong Admin Password' });
  if (rooms[room]) rooms[room].forced = number === null ? null : Number(number);
  res.json({ success: true });
});

app.get('/api/admin/stats', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const room = req.query.room || '30s';
  const currentPeriod = getRoomPeriod(room);
  const currentBets = await Bet.find({ room, period: currentPeriod });
  const totalUsers = await User.countDocuments();
  res.json({ currentPeriod, totalUsers, currentBets, forcedNextNumber: rooms[room].forced });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
