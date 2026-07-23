/**
 * StudyBuddyZone Backend - Step 4 (Firestore + Search + Follow + Gallery Engine)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// 1. Firebase Admin SDK Initialization
let serviceAccount;

try {
  serviceAccount = require('./serviceAccountKey.json');
} catch (err) {
  console.error('❌ Failed to load serviceAccountKey.json');
  process.exit(1);
}

try {
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

// 2. Express App Setup
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
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
      await userRef.set(updates, { merge: true });
      return res.status(200).json({ success: true, message: 'User updated successfully.' });
    }

    const newUser = {
      uid,
      name: name || null,
      email: resolvedEmail,
      username: username || null,
      photo_url: photoURL || null,
      gallery_photos: [], // 8-10 तस्वीरें स्टोर करने के लिए ऐरे
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

// 7. Limited Photo Gallery Engine (Max 10 Photos)
app.post('/api/gallery/add', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ success: false, message: 'Image URL आवश्यक है।' });
    }

    const userRef = usersCollection.doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ success: false, message: 'User नहीं मिला।' });
    }

    const currentPhotos = userSnap.data().gallery_photos || [];

    // लिमिट चेक: अधिकतम 10 तस्वीरें
    if (currentPhotos.length >= 10) {
      return res.status(400).json({
        success: false,
        message: 'सीमा समाप्त: आप अधिकतम 10 फ़ोटो ही अपलोड कर सकते हैं।'
      });
    }

    await userRef.update({
      gallery_photos: admin.firestore.FieldValue.arrayUnion(imageUrl)
    });

    res.status(200).json({
      success: true,
      message: 'फ़ोटो गैलरी में सफलतापूर्वक जुड़ गई!',
      photosCount: currentPhotos.length + 1
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gallery error.' });
  }
});

// फ़ोटो हटाने के लिए
app.post('/api/gallery/remove', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { imageUrl } = req.body;

    const userRef = usersCollection.doc(uid);
    await userRef.update({
      gallery_photos: admin.firestore.FieldValue.arrayRemove(imageUrl)
    });

    res.status(200).json({ success: true, message: 'फ़ोटो गैलरी से हटा दी गई!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Delete photo error.' });
  }
});

// 8. Start Server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
