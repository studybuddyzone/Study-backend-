/**
 * StudyBuddyZone Backend - Step 2 (Firestore Integration)
 * -----------------------------------------------------------------------
 * Express server backed by Firebase Firestore (via Firebase Admin SDK).
 * Handles Firebase Admin initialization, Firebase ID token verification,
 * a POST /api/users/sync endpoint (create-or-update user profile), and a
 * GET /api/users/search endpoint with a small in-memory cache to keep
 * Firestore reads low.
 *
 * NOTE: Firestore's free (Spark) tier gives you 50,000 reads / 20,000
 * writes / 20,000 deletes per day and 1 GiB storage. The search cache
 * below exists specifically to keep repeated identical searches from
 * burning through your daily read quota.
 * -----------------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// -------------------------------------------------------------------------
// 1. Firebase Admin SDK Initialization
// -------------------------------------------------------------------------
// Requires a serviceAccountKey.json file in the project root.
// Download this from: Firebase Console > Project Settings > Service Accounts
// > Generate New Private Key. NEVER commit this file (see .gitignore).
let serviceAccount;

try {
  serviceAccount = require('./serviceAccountKey.json');
} catch (err) {
  console.error(
    '❌ Failed to load serviceAccountKey.json. ' +
    'Make sure the file exists in the project root. ' +
    'See README / setup instructions for how to generate it.'
  );
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

// Firestore handle, used by all routes below.
const db = admin.firestore();
const usersCollection = db.collection('users');

// -------------------------------------------------------------------------
// 2. Express App Setup
// -------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 5000;

// Allow all origins for now (tighten this before production)
app.use(cors({ origin: '*' }));

// Parse incoming JSON request bodies
app.use(express.json());

// Basic request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// -------------------------------------------------------------------------
// 3. Authentication Middleware
// -------------------------------------------------------------------------
/**
 * Verifies the Firebase ID token sent in the Authorization header.
 * Expected header format: "Authorization: Bearer <idToken>"
 * On success, attaches the decoded token to req.user and calls next().
 * On failure, responds with 401/403 and does not call next().
 */
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: No token provided. Expected "Authorization: Bearer <token>".',
    });
  }

  const idToken = authHeader.split('Bearer ')[1];

  if (!idToken) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Malformed Authorization header.',
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (err) {
    console.error('❌ Token verification failed:', err.message);
    return res.status(403).json({
      success: false,
      message: 'Forbidden: Invalid or expired token.',
    });
  }
}

// -------------------------------------------------------------------------
// 4. Simple In-Memory Search Cache
// -------------------------------------------------------------------------
// Keeps repeated/duplicate search queries from re-hitting Firestore.
// This is process-local (resets on restart, not shared across instances) —
// fine for a single small backend instance on a free-tier setup.
const SEARCH_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const searchCache = new Map(); // key: normalized query -> { data, expiresAt }

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

// Periodically clear expired entries so the cache doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of searchCache.entries()) {
    if (now > entry.expiresAt) searchCache.delete(key);
  }
}, SEARCH_CACHE_TTL_MS).unref();

// -------------------------------------------------------------------------
// 5. Routes
// -------------------------------------------------------------------------

// Public health-check route
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'StudyBuddyZone backend is up and running 🚀',
    environment: process.env.NODE_ENV || 'development',
  });
});

// Protected test route
app.get('/api/protected-test', authenticateUser, (req, res) => {
  res.status(200).json({
    success: true,
    message: 'You have accessed a protected route!',
    user: {
      uid: req.user.uid,
      email: req.user.email || null,
    },
  });
});

// -------------------------------------------------------------------------
// POST /api/users/sync
// Creates the user's Firestore document if it doesn't exist yet, or
// updates name/photo_url/email on an existing one.
// -------------------------------------------------------------------------
app.post('/api/users/sync', authenticateUser, async (req, res) => {
  try {
    const { name, email, photoURL, username } = req.body || {};
    const { uid } = req.user;

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: Missing user identity from token.',
      });
    }

    if (!name && !email) {
      return res.status(400).json({
        success: false,
        message: 'Bad Request: At least "name" or "email" is required to sync a user.',
      });
    }

    const userRef = usersCollection.doc(uid);
    const userSnap = await userRef.get(); // 1 Firestore read

    const resolvedEmail = email || req.user.email || null;

    if (userSnap.exists) {
      // Existing user -> update only the fields we're allowed to touch here.
      const updates = {
        name: name || userSnap.data().name || null,
        photo_url: photoURL || userSnap.data().photo_url || null,
        email: resolvedEmail,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };

      await userRef.set(updates, { merge: true }); // 1 Firestore write

      console.log(`👤 User Synced (updated): ${updates.name} (${uid})`);

      return res.status(200).json({
        success: true,
        message: 'User updated successfully.',
        user: { uid, ...updates, updated_at: undefined, wasCreated: false },
      });
    }

    // New user -> create the document.
    const newUser = {
      uid,
      name: name || null,
      email: resolvedEmail,
      username: username || null,
      photo_url: photoURL || null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(newUser); // 1 Firestore write

    console.log(`👤 User Synced (created): ${newUser.name} (${uid})`);

    return res.status(201).json({
      success: true,
      message: 'User created successfully.',
      user: { ...newUser, created_at: undefined, updated_at: undefined, wasCreated: true },
    });
  } catch (err) {
    console.error('❌ Error syncing user:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error: Failed to sync user.',
    });
  }
});

// -------------------------------------------------------------------------
// GET /api/users/search?q=query
// Searches the 'users' collection by username or name prefix.
// Firestore has no native full-text/contains search, so this uses prefix
// range queries (>= q, <= q + '\uf8ff') on each field, merges + dedupes
// the results, and caches the response briefly to reduce read volume.
// -------------------------------------------------------------------------
app.get('/api/users/search', authenticateUser, async (req, res) => {
  try {
    const rawQuery = (req.query.q || '').trim();

    if (!rawQuery) {
      return res.status(400).json({
        success: false,
        message: 'Bad Request: Query parameter "q" is required.',
      });
    }

    const cacheKey = rawQuery.toLowerCase();
    const cached = getCachedSearch(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        message: 'Search results (cached).',
        cached: true,
        count: cached.length,
        users: cached,
      });
    }

    const RESULT_LIMIT = 10;
    const endBound = rawQuery + '\uf8ff';

    // Two prefix queries run in parallel: one on "username", one on "name".
    const [usernameSnap, nameSnap] = await Promise.all([
      usersCollection
        .where('username', '>=', rawQuery)
        .where('username', '<=', endBound)
        .limit(RESULT_LIMIT)
        .get(), // up to RESULT_LIMIT Firestore reads
      usersCollection
        .where('name', '>=', rawQuery)
        .where('name', '<=', endBound)
        .limit(RESULT_LIMIT)
        .get(), // up to RESULT_LIMIT Firestore reads
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

    return res.status(200).json({
      success: true,
      message: 'Search results.',
      cached: false,
      count: users.length,
      users,
    });
  } catch (err) {
    console.error('❌ Error searching users:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error: Failed to search users.',
    });
  }
});

// -------------------------------------------------------------------------
// 6. 404 Handler
// -------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// -------------------------------------------------------------------------
// 7. Global Error Handler
// -------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    message: 'Internal Server Error',
  });
});

// -------------------------------------------------------------------------
// 8. Start Server
// -------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
});

module.exports = app;
