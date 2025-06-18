import express from 'express';
import { Server } from "socket.io";
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';
import { escape } from 'html-escaper';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

// Configuration
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3500;
const ADMIN = "Admin";
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/realtime-chat';
const DB_NAME = 'chatApp';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SALT_ROUNDS = 12;

// Database Collections
const COLLECTIONS = {
  MESSAGES: 'messages',
  USERS: 'users',
  SESSIONS: 'sessions'
};

// Initialize Express
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Database Connection
let db, mongoClient;

async function connectDB() {
  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      serverSelectionTimeoutMS: 5000
    });
    
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    
    // Create indexes
    await db.collection(COLLECTIONS.MESSAGES).createIndexes([
      { key: { room: 1 } },
      { key: { timestamp: -1 } },
      { key: { "user.id": 1 } }
    ]);
    
    await db.collection(COLLECTIONS.USERS).createIndexes([
      { key: { email: 1 }, unique: true },
      { key: { lastActive: -1 } }
    ]);
    
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }
}

// Authentication Middleware
const authMiddleware = {
  socket: async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) throw new Error('Missing token');

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.collection(COLLECTIONS.USERS).findOne(
        { _id: new ObjectId(decoded.userId) },
        { projection: { _id: 1, name: 1, email: 1 } }
      );

      if (!user) throw new Error('User not found');
      
      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email
      };
      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  },

  http: async (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'Unauthorized' });

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.collection(COLLECTIONS.USERS).findOne(
        { _id: new ObjectId(decoded.userId) },
        { projection: { password: 0 } }
      );

      if (!user) return res.status(404).json({ error: 'User not found' });
      
      req.user = user;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid token' });
    }
  }
};

// User State Management
class UserState {
  constructor() {
    this.users = new Map();
  }

  add(socketId, userData) {
    this.users.set(socketId, {
      ...userData,
      lastActive: Date.now()
    });
  }

  remove(socketId) {
    this.users.delete(socketId);
  }

  get(socketId) {
    return this.users.get(socketId);
  }

  getByRoom(room) {
    return Array.from(this.users.values())
      .filter(user => user.room === room)
      .map(({ name }) => name);
  }

  getAllRooms() {
    return [...new Set(
      Array.from(this.users.values())
        .map(user => user.room)
        .filter(Boolean)
    )];
  }

  cleanupInactive(threshold = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [id, user] of this.users) {
      if (now - user.lastActive > threshold) {
        this.remove(id);
      }
    }
  }
}

// API Routes
function setupRoutes() {
  // Auth Endpoints
  app.post('/auth/register', async (req, res) => {
    try {
      const { name, email, password } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
      }

      const existingUser = await db.collection(COLLECTIONS.USERS).findOne({ email });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      const user = {
        name,
        email,
        password: hashedPassword,
        createdAt: new Date(),
        lastActive: new Date()
      };

      const result = await db.collection(COLLECTIONS.USERS).insertOne(user);
      const token = jwt.sign(
        { userId: result.insertedId.toString() }, 
        JWT_SECRET, 
        { expiresIn: '24h' }
      );

      res.status(201).json({ 
        token,
        user: {
          id: result.insertedId.toString(),
          name: user.name,
          email: user.email
        }
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await db.collection(COLLECTIONS.USERS).findOne({ email });

      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { userId: user._id.toString() }, 
        JWT_SECRET, 
        { expiresIn: '24h' }
      );

      // Update last active time
      await db.collection(COLLECTIONS.USERS).updateOne(
        { _id: user._id },
        { $set: { lastActive: new Date() } }
      );

      res.json({ 
        token,
        user: {
          id: user._id.toString(),
          name: user.name,
          email: user.email
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.get('/auth/me', authMiddleware.http, (req, res) => {
    res.json(req.user);
  });

  // Protected Example Endpoint
  app.get('/api/user-count', authMiddleware.http, async (req, res) => {
    const count = await db.collection(COLLECTIONS.USERS).countDocuments();
    res.json({ count });
  });
}

// Socket.IO Setup
function setupSocketIO(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.NODE_ENV === "production" 
        ? false 
        : ["http://localhost:5500", "http://127.0.0.1:5500"],
      methods: ["GET", "POST"],
      credentials: true
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
      skipMiddlewares: true
    }
  });

  const userState = new UserState();

  // Authentication
  io.use(authMiddleware.socket);

  // Connection Handler
  io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.user.name} (${socket.id})`);

    // Welcome message
    socket.emit('message', createMessage(
      ADMIN, 
      `Welcome ${socket.user.name}!`, 
      null,
      true
    ));

    // Room Management
    socket.on('enterRoom', async ({ room }) => {
      if (!room) return;

      const sanitizedRoom = escape(room.trim());
      const currentUser = userState.get(socket.id);

      // Leave previous room if different
      if (currentUser?.room && currentUser.room !== sanitizedRoom) {
        await leaveRoom(socket, currentUser.room);
      }

      // Join new room
      userState.add(socket.id, {
        ...socket.user,
        room: sanitizedRoom
      });

      socket.join(sanitizedRoom);

      // Load message history
      try {
        const history = await db.collection(COLLECTIONS.MESSAGES)
          .find({ room: sanitizedRoom })
          .sort({ timestamp: -1 })
          .limit(100)
          .toArray();

        socket.emit('messageHistory', history.reverse().map(msg => ({
          ...msg,
          _id: msg._id.toString()
        })));
      } catch (err) {
        console.error('Error loading history:', err);
      }

      // Notifications
      socket.emit('message', createMessage(
        ADMIN,
        `You joined ${sanitizedRoom}`,
        sanitizedRoom,
        true
      ));

      socket.to(sanitizedRoom).emit('message', createMessage(
        ADMIN,
        `${socket.user.name} joined the room`,
        sanitizedRoom,
        true
      ));

      updateRoomLists(io, userState, sanitizedRoom);
    });

    // Message Handling
    socket.on('message', async ({ text }) => {
      if (!text || text.length > 500) return;
      
      const user = userState.get(socket.id);
      if (!user?.room) return;

      const message = createMessage(
        user.name,
        text,
        user.room
      );

      // Broadcast immediately
      io.to(user.room).emit('message', {
        ...message,
        _id: message._id.toString()
      });

      // Persist to DB
      db.collection(COLLECTIONS.MESSAGES).insertOne(message)
        .catch(err => console.error('Message save error:', err));
    });

    // Activity Tracking
    socket.on('activity', () => {
      const user = userState.get(socket.id);
      if (user) {
        user.lastActive = Date.now();
      }
    });

    // Disconnection
    socket.on('disconnect', () => {
      const user = userState.get(socket.id);
      if (user?.room) {
        leaveRoom(socket, user.room);
      }
      userState.remove(socket.id);
    });
  });

  // Cleanup inactive users every hour
  setInterval(() => userState.cleanupInactive(), 60 * 60 * 1000);

  return io;
}

// Helper Functions
function createMessage(name, text, room, isAdmin = false) {
  return {
    _id: new ObjectId(),
    name: isAdmin ? ADMIN : escape(name),
    text: escape(text),
    room: room ? escape(room) : null,
    time: new Date().toLocaleTimeString(),
    timestamp: new Date()
  };
}

async function leaveRoom(socket, room) {
  socket.leave(room);
  socket.to(room).emit('message', createMessage(
    ADMIN,
    `${socket.user.name} has left`,
    room,
    true
  ));
}

function updateRoomLists(io, userState, room) {
  io.to(room).emit('userList', { 
    users: userState.getByRoom(room) 
  });
  io.emit('roomList', { 
    rooms: userState.getAllRooms() 
  });
}

// Server Startup
async function startServer() {
  await connectDB();
  setupRoutes();
  
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  const io = setupSocketIO(server);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('🛑 Shutting down gracefully...');
    server.close();
    mongoClient.close().finally(() => process.exit(0));
  });
}

startServer().catch(err => {
  console.error('🔥 Critical failure:', err);
  process.exit(1);
});