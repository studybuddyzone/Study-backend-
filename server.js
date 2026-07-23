/**
 * StudyBuddyZone Backend - Final Updated Engine (Firestore + Search + Follow + Gallery + Socket.io Chat)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');

// 1. Firebase Admin SDK Initialization (Render Environment + Local File Handling)
let serviceAccount;

try {
  if (process.env.serviceAccountKey) {
    // Render या Production Environment के लिए Environment Variable से लोड करें
    serviceAccount = JSON.parse(process.env.serviceAccountKey);
  } else {
    // Local Testing के लिए फ़ाइल से लोड करें
    serviceAccount = require('./serviceAccountKey.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin SDK initialized successfully.');
} catch (err) {
  console.error('❌ Firebase Admin SDK initialization failed:', err.message);
  process.exit(1);
}

const db = admin.firestore();
const usersCollection = db.collection('users');
const followsCollection = db.collection('follows');
const messagesCollection = db.collection('messages');

// 2. Express & HTTP Server Setup (CORS and Transports Fixed)
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// 3. Authentication Middleware
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: No token provided.',
    });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (err) {
    console.error('❌ Token verification failed:', err.message);
    return res.status(403).json({
      success: false,
      message: 'Forbidden: Invalid token.',
    });
  }
}

// 4. In-Memory Search Cache
const SEARCH_CACHE_TTL_MS = 60 * 1000;
const searchCache = new Map();

function getCachedSearch(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedSearch(key, data) {
  searchCache.set(key, { data, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
}

// 5. Basic Routes
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'StudyBuddyZone backend is up and running 🚀',
  });
});

// User Sync API
app.post('/api/users/sync', authenticateUser, async (req, res) => {
  try {
    const { name, email, photoURL, username } = req.body || {};
    const { uid } = req.user;

    const userRef = usersCollection.doc(uid);
    const userSnap = await userRef.get();

    const resolvedEmail = email || req.user.email || null;

    if (userSnap.exists) {
      const updates = {
        name: name || userSnap.data().name || null,
        photo_url: photoURL || userSnap.data().photo_url || null,
        email: resolvedEmail,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (username) updates.username = username;
      
      await userRef.set(updates, { merge: true });
      return res.status(200).json({ success: true, message: 'User updated successfully.' });
    }

    const newUser = {
      uid,
      name: name || null,
      email: resolvedEmail,
      username: username || null,
      photo_url: photoURL || null,
      gallery_photos: [],
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(newUser);
    return res.status(201).json({ success: true, message: 'User created successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to sync user.' });
  }
});

// Search API
app.get('/api/users/search', authenticateUser, async (req, res) => {
  try {
    const rawQuery = (req.query.q || '').trim();
    if (!rawQuery) return res.status(400).json({ success: false, message: 'Query is required.' });

    const cacheKey = rawQuery.toLowerCase();
    const cached = getCachedSearch(cacheKey);
    if (cached) return res.status(200).json({ success: true, cached: true, users: cached });

    const RESULT_LIMIT = 10;
    const endBound = rawQuery + '\uf8ff';

    const [usernameSnap, nameSnap] = await Promise.all([
      usersCollection.where('username', '>=', rawQuery).where('username', '<=', endBound).limit(RESULT_LIMIT).get(),
      usersCollection.where('name', '>=', rawQuery).where('name', '<=', endBound).limit(RESULT_LIMIT).get(),
    ]);

    const resultsByUid = new Map();
    for (const doc of [...usernameSnap.docs, ...nameSnap.docs]) {
      if (!resultsByUid.has(doc.id)) {
        const data = doc.data();
        resultsByUid.set(doc.id, {
          uid: doc.id,
          name: data.name || null,
          username: data.username || null,
          photo_url: data.photo_url || null,
        });
      }
    }

    const users = Array.from(resultsByUid.values()).slice(0, RESULT_LIMIT);
    setCachedSearch(cacheKey, users);

    return res.status(200).json({ success: true, cached: false, users });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Search failed.' });
  }
});

// 6. Follow / Follow-Back System Engine
app.post('/api/follow', authenticateUser, async (req, res) => {
  try {
    const followerId = req.user.uid;
    const { targetUserId } = req.body;

    if (!targetUserId) return res.status(400).json({ success: false, message: 'Target ID required.' });
    if (followerId === targetUserId) return res.status(400).json({ success: false, message: 'Cannot follow yourself.' });

    const followDocId = `${followerId}_${targetUserId}`;
    await followsCollection.doc(followDocId).set({
      follower_id: followerId,
      following_id: targetUserId,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.status(200).json({ success: true, message: 'Followed successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Follow error.' });
  }
});

app.post('/api/unfollow', authenticateUser, async (req, res) => {
  try {
    const followerId = req.user.uid;
    const { targetUserId } = req.body;

    if (!targetUserId) return res.status(400).json({ success: false, message: 'Target ID required.' });

    const followDocId = `${followerId}_${targetUserId}`;
    await followsCollection.doc(followDocId).delete();

    res.status(200).json({ success: true, message: 'Unfollowed successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Unfollow error.' });
  }
});

app.get('/api/followers/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await followsCollection.where('following_id', '==', uid).get();
    const followerIds = snap.docs.map(doc => doc.data().follower_id);

    res.status(200).json({ success: true, count: followerIds.length, followers: followerIds });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Get followers error.' });
  }
});

app.get('/api/following/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await followsCollection.where('follower_id', '==', uid).get();
    const followingIds = snap.docs.map(doc => doc.data().following_id);

    res.status(200).json({ success: true, count: followingIds.length, following: followingIds });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Get following error.' });
  }
});

// 7. Limited Photo Gallery Engine
app.post('/api/gallery/add', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { imageUrl, imageBase64 } = req.body;
    const photoToSave = imageUrl || imageBase64;

    if (!photoToSave) return res.status(400).json({ success: false, message: 'Image data required.' });

    const userRef = usersCollection.doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) return res.status(404).json({ success: false, message: 'User not found.' });

    const currentPhotos = userSnap.data().gallery_photos || [];

    if (currentPhotos.length >= 10) {
      return res.status(400).json({ success: false, message: 'Limit reached: Maximum 10 photos allowed.' });
    }

    await userRef.update({
      gallery_photos: admin.firestore.FieldValue.arrayUnion(photoToSave)
    });

    res.status(200).json({ success: true, message: 'Photo added to gallery!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gallery error.' });
  }
});

// Get User Gallery Photos API
app.get('/api/gallery/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const userSnap = await usersCollection.doc(uid).get();

    if (!userSnap.exists) return res.status(404).json({ success: false, message: 'User not found.' });

    const photos = userSnap.data().gallery_photos || [];
    res.status(200).json({ success: true, count: photos.length, photos });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Get gallery error.' });
  }
});

// Chat Messages History API (पुरानी चैट लोड करने के लिए)
app.get('/api/messages/:otherUserId', authenticateUser, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const { otherUserId } = req.params;

    const chatRoomId = [currentUserId, otherUserId].sort().join('_');

    const snap = await messagesCollection
      .where('room_id', '==', chatRoomId)
      .orderBy('timestamp', 'asc')
      .limit(50)
      .get();

    const messages = snap.docs.map(doc => doc.data());

    res.status(200).json({ success: true, count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Chat history error.' });
  }
});

// 8. Socket.io Real-time Chat Engine
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));

    const decodedToken = await admin.auth().verifyIdToken(token);
    socket.user = decodedToken;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log(`⚡ User connected to Live Chat: ${socket.user.uid}`);

  socket.join(socket.user.uid);

  socket.on('send_message', async (data) => {
    const { receiverId, text } = data;
    const senderId = socket.user.uid;

    if (!receiverId || !text) return;

    const chatRoomId = [senderId, receiverId].sort().join('_');

    const messageData = {
      room_id: chatRoomId,
      sender_id: senderId,
      receiver_id: receiverId,
      text: text,
      timestamp: new Date().toISOString()
    };

    io.to(receiverId).emit('receive_message', messageData);

    try {
      await messagesCollection.add(messageData);
    } catch (err) {
      console.error('Error saving chat message:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.user.uid}`);
  });
});

// 9. Start Server
server.listen(PORT, () => {
  console.log(`✅ Server running with Socket.io Chat Engine on port ${PORT}`);
});
                                         
