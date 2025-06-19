import express from 'express';
import { Server } from "socket.io";
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';
import { escape } from 'html-escaper';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cors from 'cors';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3500;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'chatApp';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SALT_ROUNDS = 12;
const ADMIN = 'Admin';

// ✅ Allowed frontend origins
const allowedOrigins = [
  'https://chitchat-74a43.web.app',
  'https://realtime-chat-app-lakshya.web.app',
  'https://realtime-chat-app-lakshya.firebaseapp.com',
  'http://localhost:5500'
];

const app = express();

// ✅ CORS Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ✅ Handle preflight
app.options('*', cors());

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

// ✅ MongoDB Connection
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('messages').createIndex({ room: 1 });
  console.log('✅ MongoDB connected');
}

// ✅ Auth Middleware
const authMiddleware = {
  socket: async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) throw new Error('Missing token');

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.collection('users').findOne(
        { _id: new ObjectId(decoded.userId) },
        { projection: { name: 1, email: 1 } }
      );
      if (!user) throw new Error('User not found');
      socket.user = { id: user._id.toString(), name: user.name, email: user.email };
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  },

  http: async (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'Unauthorized' });

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.collection('users').findOne(
        { _id: new ObjectId(decoded.userId) },
        { projection: { password: 0 } }
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  }
};

// ✅ User state memory
class UserState {
  constructor() {
    this.users = new Map();
  }

  add(id, user) {
    this.users.set(id, { ...user, lastActive: Date.now() });
  }

  remove(id) {
    this.users.delete(id);
  }

  get(id) {
    return this.users.get(id);
  }

  getByRoom(room) {
    return Array.from(this.users.values()).filter(u => u.room === room).map(u => u.name);
  }

  getAllRooms() {
    return [...new Set(Array.from(this.users.values()).map(u => u.room).filter(Boolean))];
  }

  cleanup() {
    const now = Date.now();
    for (const [id, u] of this.users.entries()) {
      if (now - u.lastActive > 30 * 60 * 1000) {
        this.users.delete(id);
      }
    }
  }
}

// ✅ Routes
function setupRoutes() {
  app.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'All fields are required' });

    const existing = await db.collection('users').findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await db.collection('users').insertOne({
      name,
      email,
      password: hashed,
      createdAt: new Date(),
      lastActive: new Date()
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

    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { lastActive: new Date() } }
    );

    res.json({
      token,
      user: { id: user._id.toString(), name: user.name, email: user.email }
    });
  });

  app.get('/auth/me', authMiddleware.http, (req, res) => {
    res.json(req.user);
  });
}

// ✅ Socket.IO
function setupSocketIO(server) {
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  const userState = new UserState();
  io.use(authMiddleware.socket);

  io.on('connection', (socket) => {
    socket.emit('message', {
      _id: new ObjectId().toString(),
      name: ADMIN,
      text: `Welcome ${socket.user.name}!`,
      room: null,
      time: new Date().toLocaleTimeString()
    });

    socket.on('enterRoom', async ({ room }) => {
      const r = escape(room.trim());
      const current = userState.get(socket.id);
      if (current?.room && current.room !== r) await leaveRoom(socket, current.room);

      userState.add(socket.id, { ...socket.user, room: r });
      socket.join(r);

      const history = await db.collection('messages')
        .find({ room: r })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();

      socket.emit('messageHistory', history.reverse().map(m => ({
        ...m, _id: m._id.toString()
      })));

      socket.to(r).emit('message', {
        _id: new ObjectId().toString(),
        name: ADMIN,
        text: `${socket.user.name} joined`,
        room: r,
        time: new Date().toLocaleTimeString()
      });

      updateRooms();
    });

    socket.on('message', async ({ text }) => {
      const u = userState.get(socket.id);
      if (!u?.room || !text) return;

      const msg = {
        _id: new ObjectId(),
        name: u.name,
        text: escape(text),
        room: u.room,
        time: new Date().toLocaleTimeString(),
        timestamp: new Date()
      };

      io.to(u.room).emit('message', { ...msg, _id: msg._id.toString() });
      db.collection('messages').insertOne(msg).catch(console.error);
    });

    socket.on('activity', () => {
      const u = userState.get(socket.id);
      if (u) u.lastActive = Date.now();
    });

    socket.on('disconnect', () => {
      const u = userState.get(socket.id);
      if (u?.room) leaveRoom(socket, u.room);
      userState.remove(socket.id);
    });

    function leaveRoom(socket, room) {
      socket.leave(room);
      socket.to(room).emit('message', {
        _id: new ObjectId().toString(),
        name: ADMIN,
        text: `${socket.user.name} left`,
        room,
        time: new Date().toLocaleTimeString()
      });
      updateRooms();
    }

    function updateRooms() {
      const rooms = userState.getAllRooms();
      io.emit('roomList', { rooms });
      rooms.forEach(r => {
        io.to(r).emit('userList', {
          users: userState.getByRoom(r)
        });
      });
    }
  });

  setInterval(() => userState.cleanup(), 60 * 60 * 1000);
  return io;
}

// ✅ Launch Server
async function startServer() {
  await connectDB();
  setupRoutes();
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
  });
  setupSocketIO(server);
}

startServer().catch(err => {
  console.error('🔥 Server error:', err);
  process.exit(1);
});
