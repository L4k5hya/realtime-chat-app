// server.js
import express from 'express';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';
import { escape } from 'html-escaper';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();
const PORT = process.env.PORT || 3500;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'chatApp';
const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 12;
const ADMIN = 'Admin';

const allowedOrigins = [
  'https://chitchat-74a43.web.app',
  'https://realtime-chat-app-lakshya.web.app',
  'https://realtime-chat-app-lakshya.firebaseapp.com',
  'http://localhost:5500'
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// ⚙️ CORS workaround – reliably adds appropriate headers
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('messages').createIndex({ room: 1 });
  console.log('✅ MongoDB connected');
}

const authMiddleware = {
  http: async (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'Unauthorized' });

      const { userId } = jwt.verify(token, JWT_SECRET);
      const user = await db.collection('users').findOne(
        { _id: new ObjectId(userId) }, 
        { projection: { password: 0 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });

      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  },

  socket: async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) throw new Error('Missing token');

      const { userId } = jwt.verify(token, JWT_SECRET);
      const user = await db.collection('users').findOne(
        { _id: new ObjectId(userId) }, 
        { projection: { name: 1, email: 1 } }
      );
      if (!user) throw new Error('User not found');

      socket.user = { id: user._id.toString(), name: user.name, email: user.email };
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  }
};

class UserState {
  constructor() { this.users = new Map(); }
  add(id, user) { this.users.set(id, { ...user, lastActive: Date.now() }); }
  remove(id) { this.users.delete(id); }
  get(id) { return this.users.get(id); }
  getByRoom(room) { return Array.from(this.users.values()).filter(u => u.room === room).map(u => u.name); }
  getAllRooms() { return [...new Set(Array.from(this.users.values()).map(u => u.room).filter(Boolean))]; }
  cleanup() {
    const now = Date.now();
    for (const [id, u] of this.users) {
      if (now - u.lastActive > 30 * 60 * 1000) this.users.delete(id);
    }
  }
}

function setupRoutes() {
  app.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'All fields are required' });

    const exists = await db.collection('users').findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already exists' });

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.collection('users').insertOne({
      name, email, password: hashed, createdAt: new Date(), lastActive: new Date()
    });

    const token = jwt.sign({ userId: result.insertedId.toString() }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({
      token,
      user: { id: result.insertedId.toString(), name, email }
    });
  });

  app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await db.collection('users').findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '24h' });
    await db.collection('users').updateOne({ _id: user._id }, { $set: { lastActive: new Date() } });

    res.json({ token, user: { id: user._id.toString(), name: user.name, email: user.email } });
  });

  app.get('/auth/me', authMiddleware.http, (req, res) => {
    res.json(req.user);
  });
}

function setupSocketIO(server) {
  const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }
  });
  const state = new UserState();
  io.use(authMiddleware.socket);

  io.on('connection', socket => {
    socket.emit('message', { _id: new ObjectId().toString(), name: ADMIN, text: `Welcome ${socket.user.name}!`, room: null, time: new Date().toLocaleTimeString() });

    socket.on('enterRoom', async ({ room }) => {
      const r = escape(room.trim());
      const cur = state.get(socket.id);
      if (cur?.room && cur.room !== r) leaveRoom(socket, cur.room);
      state.add(socket.id, { ...socket.user, room: r });
      socket.join(r);

      const history = await db.collection('messages')
        .find({ room: r }).sort({ timestamp: -1 }).limit(100).toArray();

      socket.emit('messageHistory', history.reverse().map(m => ({ ...m, _id: m._id.toString() })));
      socket.to(r).emit('message', { _id: new ObjectId().toString(), name: ADMIN, text: `${socket.user.name} joined`, room: r, time: new Date().toLocaleTimeString() });
      updateRooms();
    });

    socket.on('message', async ({ text }) => {
      const u = state.get(socket.id);
      if (!u?.room) return;
      const msg = { _id: new ObjectId(), name: u.name, text: escape(text), room: u.room, time: new Date().toLocaleTimeString(), timestamp: new Date() };
      io.to(u.room).emit('message', { ...msg, _id: msg._id.toString() });
      db.collection('messages').insertOne(msg).catch(console.error);
    });

    socket.on('activity', () => {
      const u = state.get(socket.id);
      if (u) u.lastActive = Date.now();
    });

    socket.on('disconnect', () => {
      const u = state.get(socket.id);
      if (u?.room) leaveRoom(socket, u.room);
      state.remove(socket.id);
    });

    function leaveRoom(sock, room) {
      sock.leave(room);
      sock.to(room).emit('message', { _id: new ObjectId().toString(), name: ADMIN, text: `${sock.user.name} left`, room, time: new Date().toLocaleTimeString() });
      updateRooms();
    }

    function updateRooms() {
      const rooms = state.getAllRooms();
      io.emit('roomList', { rooms });
      rooms.forEach(r => io.to(r).emit('userList', { users: state.getByRoom(r) }));
    }
  });

  setInterval(() => state.cleanup(), 60 * 60 * 1000);
  return io;
}

async function startServer() {
  await connectDB();
  setupRoutes();
  const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
  setupSocketIO(server);
}

startServer().catch(err => { console.error('🔥 Fatal:', err); process.exit(1); });
