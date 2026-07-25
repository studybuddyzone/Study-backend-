/**
 * StudyBuddyZone Backend — Supabase (PostgreSQL) + Search + Follow + Gallery + Socket.io Chat
 * Firebase is used ONLY for verifying client ID tokens (admin.auth().verifyIdToken()).
 * All data (users, follows, messages) now lives in Supabase/Postgres.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED SUPABASE SCHEMA (run once in the Supabase SQL editor before deploying):
 *
 *   create table if not exists users (
 *     uid            text primary key,
 *     name           text,
 *     username       text,
 *     email          text,
 *     photo_url      text,
 *     gallery_photos text[] not null default '{}',
 *     created_at     timestamptz not null default now(),
 *     updated_at     timestamptz not null default now()
 *   );
 *   create index if not exists users_name_idx on users using gin (name gin_trgm_ops);
 *   create index if not exists users_username_idx on users using gin (username gin_trgm_ops);
 *   -- (the two indexes above need: create extension if not exists pg_trgm;)
 *
 *   create table if not exists follows (
 *     id            bigserial primary key,
 *     follower_id   text not null,
 *     following_id  text not null,
 *     created_at    timestamptz not null default now(),
 *     unique (follower_id, following_id)
 *   );
 *   create index if not exists follows_follower_idx on follows (follower_id);
 *   create index if not exists follows_following_idx on follows (following_id);
 *
 *   -- Private-account + follow-request + notification support (see migration.sql
 *   -- for the full script, including the "is_private" column on users and the
 *   -- public_users view used to keep photo_url/gallery_photos out of anon reads):
 *   create table if not exists follow_requests (
 *     id            bigserial primary key,
 *     requester_id  text not null,
 *     target_id     text not null,
 *     status        text not null default 'pending', -- pending | accepted | rejected
 *     created_at    timestamptz not null default now(),
 *     updated_at    timestamptz not null default now(),
 *     unique (requester_id, target_id)
 *   );
 *   create index if not exists follow_requests_target_idx on follow_requests (target_id, status);
 *
 *   create table if not exists notifications (
 *     id            bigserial primary key,
 *     user_id       text not null,   -- recipient
 *     type          text not null,   -- 'follow_request' | 'follow_accepted'
 *     from_uid      text not null,
 *     from_name     text,
 *     from_username text,
 *     is_read       boolean not null default false,
 *     created_at    timestamptz not null default now()
 *   );
 *   create index if not exists notifications_user_idx on notifications (user_id, created_at desc);
 *
 *   create table if not exists messages (
 *     id           bigserial primary key,
 *     room_id      text not null,
 *     sender_id    text not null,
 *     receiver_id  text not null,
 *     text         text not null,
 *     timestamp    timestamptz not null default now()
 *   );
 *   create index if not exists messages_room_ts_idx on messages (room_id, timestamp);
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// 1. Firebase Admin SDK Initialization — kept ONLY for ID token verification
let serviceAccount;

try {
  if (process.env.serviceAccountKey) {
    // Render / Production environment ke liye env var se load karo
    serviceAccount = JSON.parse(process.env.serviceAccountKey);
  } else {
    // Local testing ke liye file se load karo
    serviceAccount = require('./serviceAccountKey.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin SDK initialized successfully (token verification only).');
} catch (err) {
  console.error('❌ Firebase Admin SDK initialization failed:', err.message);
  process.exit(1);
}

// 1b. Supabase Client Initialization
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, // server-side service-role client, no session needed
});
console.log('✅ Supabase client initialized.');

// 2. Express & HTTP Server Setup
const app = express();
const server = http.createServer(app);

const CORS_OPTIONS = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
};

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  allowEIO3: true,
  transports: ['polling', 'websocket'],
});

const PORT = process.env.PORT || 5000;

app.use(cors(CORS_OPTIONS));
app.options('*', cors(CORS_OPTIONS));
// Videos sent as base64 are much bigger than photos — default 100kb limit is too small.
app.use(express.json({ limit: '30mb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// 3. Authentication Middleware — unchanged: still Firebase ID token verification
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

// 4. In-Memory Search Cache (unchanged)
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

// Escapes PostgREST filter special characters (%, ,, ), *) inside a user-supplied search term
function escapeIlikeTerm(raw) {
  return raw.replace(/[%,)*]/g, (ch) => '\\' + ch);
}

// ── Privacy / follow-request helpers ────────────────────────────────────────
async function getUserPrivacyRow(uid) {
  const { data, error } = await supabase
    .from('users')
    .select('uid, name, username, photo_url, is_private')
    .eq('uid', uid)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function checkIsFollowing(followerId, targetId) {
  const { data, error } = await supabase
    .from('follows')
    .select('id')
    .eq('follower_id', followerId)
    .eq('following_id', targetId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// Creates a notification row. Deliberately never includes a photo — notifications
// only ever carry name/username so a request can't be used to leak a private photo.
async function createNotification({ userId, type, fromUid, fromName, fromUsername }) {
  const { error } = await supabase.from('notifications').insert({
    user_id: userId,
    type,
    from_uid: fromUid,
    from_name: fromName || 'Student',
    from_username: fromUsername || '',
    is_read: false,
  });
  if (error) console.error('❌ notification insert error:', error.message);
}

// 5. Basic Routes
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'StudyBuddyZone backend (Supabase) is up and running 🚀',
  });
});

// User Sync API
app.post('/api/users/sync', authenticateUser, async (req, res) => {
  try {
    const { name, email, photoURL, username, isPrivate } = req.body || {};
    const { uid } = req.user;
    const resolvedEmail = email || req.user.email || null;

    // Only include fields that were actually provided — Supabase upsert's UPDATE branch
    // only touches columns present in the payload, so omitted fields keep their existing
    // value on an existing row (same "merge" behaviour as the old Firestore version).
    const payload = { uid, email: resolvedEmail, updated_at: new Date().toISOString() };
    if (name !== undefined) payload.name = name;
    if (photoURL !== undefined) payload.photo_url = photoURL;
    if (username !== undefined) payload.username = username;
    if (isPrivate !== undefined) payload.is_private = !!isPrivate;

    const { error } = await supabase
      .from('users')
      .upsert(payload, { onConflict: 'uid' });

    if (error) throw error;
    return res.status(200).json({ success: true, message: 'User synced successfully.' });
  } catch (err) {
    console.error('❌ sync error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to sync user.' });
  }
});

// Search API — case-insensitive match on name OR username
app.get('/api/users/search', authenticateUser, async (req, res) => {
  try {
    const rawQuery = (req.query.q || '').trim();
    if (!rawQuery) return res.status(400).json({ success: false, message: 'Query is required.' });

    const cacheKey = rawQuery.toLowerCase();
    const cached = getCachedSearch(cacheKey);
    if (cached) return res.status(200).json({ success: true, cached: true, users: cached });

    const RESULT_LIMIT = 10;
    const term = `%${escapeIlikeTerm(rawQuery)}%`;

    // NOTE: photo_url is deliberately NOT selected here — profile photos must never
    // be visible from a public search result, only the name and S ID (username).
    const { data, error } = await supabase
      .from('users')
      .select('uid, name, username, is_private')
      .or(`name.ilike.${term},username.ilike.${term}`)
      .limit(RESULT_LIMIT);

    if (error) throw error;

    setCachedSearch(cacheKey, data);
    return res.status(200).json({ success: true, cached: false, users: data });
  } catch (err) {
    console.error('❌ search error:', err.message);
    return res.status(500).json({ success: false, message: 'Search failed.' });
  }
});

// User Profile Lookup API (needed because /api/following & /api/followers
// only return UIDs — the frontend chat list needs name/username/photo too)
app.get('/api/users/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const requesterId = req.user.uid;

    const data = await getUserPrivacyRow(uid);
    if (!data) return res.status(404).json({ success: false, message: 'User not found.' });

    const isSelf = requesterId === uid;
    const following = isSelf ? true : await checkIsFollowing(requesterId, uid);

    // Private account, not yourself, and not an accepted follower yet →
    // never send photo_url down the wire. Name + S ID only.
    if (data.is_private && !isSelf && !following) {
      let hasPendingRequest = false;
      try {
        const { data: reqRow } = await supabase
          .from('follow_requests')
          .select('id')
          .eq('requester_id', requesterId)
          .eq('target_id', uid)
          .eq('status', 'pending')
          .maybeSingle();
        hasPendingRequest = !!reqRow;
      } catch (e) { /* non-fatal */ }

      return res.status(200).json({
        success: true,
        user: { uid: data.uid, name: data.name, username: data.username, is_private: true },
        isFollowing: false,
        hasPendingRequest,
      });
    }

    return res.status(200).json({ success: true, user: data, isFollowing: following });
  } catch (err) {
    console.error('❌ get user error:', err.message);
    return res.status(500).json({ success: false, message: 'Get user error.' });
  }
});

// 6. Follow / Follow-Back System Engine
app.post('/api/follow', authenticateUser, async (req, res) => {
  try {
    const followerId = req.user.uid;
    const { targetUserId } = req.body || {};

    if (!targetUserId) return res.status(400).json({ success: false, message: 'Target ID required.' });
    if (followerId === targetUserId) return res.status(400).json({ success: false, message: 'Cannot follow yourself.' });

    const alreadyFollowing = await checkIsFollowing(followerId, targetUserId);
    if (alreadyFollowing) {
      return res.status(200).json({ success: true, followed: true, message: 'Already following.' });
    }

    const target = await getUserPrivacyRow(targetUserId);
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });

    if (target.is_private) {
      // Private account → send a pending request instead of following directly.
      // upsert so re-requesting after a rejection just flips the row back to pending.
      const { error: reqErr } = await supabase
        .from('follow_requests')
        .upsert(
          { requester_id: followerId, target_id: targetUserId, status: 'pending', updated_at: new Date().toISOString() },
          { onConflict: 'requester_id,target_id' }
        );
      if (reqErr) throw reqErr;

      const requester = await getUserPrivacyRow(followerId);
      await createNotification({
        userId: targetUserId,
        type: 'follow_request',
        fromUid: followerId,
        fromName: requester ? requester.name : 'Student',
        fromUsername: requester ? requester.username : '',
      });

      return res.status(200).json({ success: true, requested: true, message: 'Follow request sent.' });
    }

    // upsert on the (follower_id, following_id) unique constraint — safe to call twice (idempotent)
    const { error } = await supabase
      .from('follows')
      .upsert({ follower_id: followerId, following_id: targetUserId }, { onConflict: 'follower_id,following_id' });

    if (error) throw error;
    return res.status(200).json({ success: true, followed: true, message: 'Followed successfully!' });
  } catch (err) {
    console.error('❌ follow error:', err.message);
    return res.status(500).json({ success: false, message: 'Follow error.' });
  }
});

// Accept / reject an incoming follow request (only the target user can act on it)
app.post('/api/follow-requests/:requesterUid/accept', authenticateUser, async (req, res) => {
  try {
    const me = req.user.uid;
    const { requesterUid } = req.params;

    const { data: reqRow, error: findErr } = await supabase
      .from('follow_requests')
      .select('id')
      .eq('requester_id', requesterUid)
      .eq('target_id', me)
      .eq('status', 'pending')
      .maybeSingle();
    if (findErr) throw findErr;
    if (!reqRow) return res.status(404).json({ success: false, message: 'No pending request found.' });

    const { error: updErr } = await supabase
      .from('follow_requests')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', reqRow.id);
    if (updErr) throw updErr;

    const { error: followErr } = await supabase
      .from('follows')
      .upsert({ follower_id: requesterUid, following_id: me }, { onConflict: 'follower_id,following_id' });
    if (followErr) throw followErr;

    const approver = await getUserPrivacyRow(me);
    await createNotification({
      userId: requesterUid,
      type: 'follow_accepted',
      fromUid: me,
      fromName: approver ? approver.name : 'Student',
      fromUsername: approver ? approver.username : '',
    });

    return res.status(200).json({ success: true, message: 'Request accepted.' });
  } catch (err) {
    console.error('❌ accept follow request error:', err.message);
    return res.status(500).json({ success: false, message: 'Accept request error.' });
  }
});

app.post('/api/follow-requests/:requesterUid/reject', authenticateUser, async (req, res) => {
  try {
    const me = req.user.uid;
    const { requesterUid } = req.params;

    const { error } = await supabase
      .from('follow_requests')
      .delete()
      .eq('requester_id', requesterUid)
      .eq('target_id', me);
    if (error) throw error;

    return res.status(200).json({ success: true, message: 'Request rejected.' });
  } catch (err) {
    console.error('❌ reject follow request error:', err.message);
    return res.status(500).json({ success: false, message: 'Reject request error.' });
  }
});

// Lets the REQUESTER withdraw their own pending request (mirrors reject, but keyed by target uid + caller-as-requester)
app.post('/api/follow-requests/:targetUid/cancel', authenticateUser, async (req, res) => {
  try {
    const me = req.user.uid;
    const { targetUid } = req.params;

    const { error } = await supabase
      .from('follow_requests')
      .delete()
      .eq('requester_id', me)
      .eq('target_id', targetUid);
    if (error) throw error;

    return res.status(200).json({ success: true, message: 'Request cancelled.' });
  } catch (err) {
    console.error('❌ cancel follow request error:', err.message);
    return res.status(500).json({ success: false, message: 'Cancel request error.' });
  }
});

app.post('/api/unfollow', authenticateUser, async (req, res) => {
  try {
    const followerId = req.user.uid;
    const { targetUserId } = req.body || {};

    if (!targetUserId) return res.status(400).json({ success: false, message: 'Target ID required.' });

    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', followerId)
      .eq('following_id', targetUserId);

    if (error) throw error;
    return res.status(200).json({ success: true, message: 'Unfollowed successfully!' });
  } catch (err) {
    console.error('❌ unfollow error:', err.message);
    return res.status(500).json({ success: false, message: 'Unfollow error.' });
  }
});

app.get('/api/followers/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const { data, error } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('following_id', uid);

    if (error) throw error;
    const followerIds = (data || []).map((row) => row.follower_id);

    return res.status(200).json({ success: true, count: followerIds.length, followers: followerIds });
  } catch (err) {
    console.error('❌ get followers error:', err.message);
    return res.status(500).json({ success: false, message: 'Get followers error.' });
  }
});

app.get('/api/following/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const { data, error } = await supabase
      .from('follows')
      .select('following_id')
      .eq('follower_id', uid);

    if (error) throw error;
    const followingIds = (data || []).map((row) => row.following_id);

    return res.status(200).json({ success: true, count: followingIds.length, following: followingIds });
  } catch (err) {
    console.error('❌ get following error:', err.message);
    return res.status(500).json({ success: false, message: 'Get following error.' });
  }
});

// Notifications API — powers both the main app's bell icon and Social Mode's own
// notification list. Never includes a photo field by design (see createNotification).
app.get('/api/notifications', authenticateUser, async (req, res) => {
  try {
    const me = req.user.uid;

    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, from_uid, from_name, from_username, is_read, created_at')
      .eq('user_id', me)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const notifications = data || [];

    // For follow_request notifications, attach the *current* request status so the
    // UI can grey out Accept/Reject once it's already been actioned.
    const requesterIds = notifications.filter((n) => n.type === 'follow_request').map((n) => n.from_uid);
    let statusByRequester = {};
    if (requesterIds.length > 0) {
      const { data: reqRows, error: reqErr } = await supabase
        .from('follow_requests')
        .select('requester_id, status')
        .eq('target_id', me)
        .in('requester_id', requesterIds);
      if (!reqErr && reqRows) {
        statusByRequester = reqRows.reduce((acc, r) => { acc[r.requester_id] = r.status; return acc; }, {});
      }
    }

    const enriched = notifications.map((n) => (
      n.type === 'follow_request'
        ? Object.assign({}, n, { requestStatus: statusByRequester[n.from_uid] || 'pending' })
        : n
    ));

    const unreadCount = enriched.filter((n) => !n.is_read).length;
    return res.status(200).json({ success: true, notifications: enriched, unreadCount });
  } catch (err) {
    console.error('❌ get notifications error:', err.message);
    return res.status(500).json({ success: false, message: 'Get notifications error.' });
  }
});

app.post('/api/notifications/mark-read', authenticateUser, async (req, res) => {
  try {
    const me = req.user.uid;
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', me)
      .eq('is_read', false);
    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ mark notifications read error:', err.message);
    return res.status(500).json({ success: false, message: 'Mark read error.' });
  }
});

// 7. Limited Photo Gallery Engine
app.post('/api/gallery/add', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.user;
    const { imageBase64 } = req.body || {};

    if (!imageBase64) return res.status(400).json({ success: false, message: 'Image or video data required.' });
    if (!/^data:(image|video)\//.test(imageBase64)) {
      return res.status(400).json({ success: false, message: 'Valid base64 image or video data URL required.' });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ success: false, message: 'Cloudinary env vars not set (CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET).' });
    }

    // Server-side safety cap (base64 runs ~1.37x the raw byte size) — keeps big video
    // uploads from hammering Render's free-tier CPU/bandwidth or timing out.
    const approxBytes = Math.floor(imageBase64.length * 0.75);
    const MAX_BYTES = 20 * 1024 * 1024; // 20MB
    if (approxBytes > MAX_BYTES) {
      return res.status(400).json({ success: false, message: 'File too large (max ~20MB).' });
    }

    const { data: userRow, error: fetchErr } = await supabase
      .from('users')
      .select('gallery_photos')
      .eq('uid', uid)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!userRow) return res.status(404).json({ success: false, message: 'User not found.' });

    const currentPhotos = userRow.gallery_photos || [];
    if (currentPhotos.length >= 10) {
      return res.status(400).json({ success: false, message: 'Limit reached: Maximum 10 items allowed.' });
    }

    // Upload to Cloudinary — resource_type "auto" lets Cloudinary detect image vs video.
    // Each gallery item gets its own public_id (unlike the profile photo, which overwrites
    // the same id) so multiple gallery uploads never clobber each other.
    let uploadResult;
    try {
      uploadResult = await cloudinary.uploader.upload(imageBase64, {
        folder: `gallery/${uid}`,
        resource_type: 'auto',
      });
    } catch (err) {
      console.error('❌ Cloudinary gallery upload error:', err.message);
      return res.status(502).json({ success: false, message: 'Cloudinary upload failed.' });
    }

    const mediaUrl = uploadResult.secure_url;

    // NOTE: read-then-write like this can theoretically race under near-simultaneous
    // uploads from the same user (unlike Firestore's atomic arrayUnion). For this app's
    // usage pattern (one user uploading from one device at a time) that's an acceptable
    // trade-off; swap for a Postgres function (e.g. array_append via .rpc()) if you ever
    // need hard atomicity guarantees.
    const updatedPhotos = [...currentPhotos, mediaUrl];
    const { error: updateErr } = await supabase
      .from('users')
      .update({ gallery_photos: updatedPhotos, updated_at: new Date().toISOString() })
      .eq('uid', uid);

    if (updateErr) throw updateErr;
    return res.status(200).json({ success: true, message: 'Added to gallery!', url: mediaUrl });
  } catch (err) {
    console.error('❌ gallery add error:', err.message);
    return res.status(500).json({ success: false, message: 'Gallery error.' });
  }
});

// Get User Gallery Photos API
app.get('/api/gallery/:uid', authenticateUser, async (req, res) => {
  try {
    const { uid } = req.params;
    const requesterId = req.user.uid;

    if (requesterId !== uid) {
      const privacyRow = await getUserPrivacyRow(uid);
      if (!privacyRow) return res.status(404).json({ success: false, message: 'User not found.' });
      if (privacyRow.is_private) {
        const following = await checkIsFollowing(requesterId, uid);
        if (!following) {
          return res.status(403).json({ success: false, locked: true, message: 'This account is private.' });
        }
      }
    }

    const { data, error } = await supabase
      .from('users')
      .select('gallery_photos')
      .eq('uid', uid)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'User not found.' });

    const photos = data.gallery_photos || [];
    return res.status(200).json({ success: true, count: photos.length, photos });
  } catch (err) {
    console.error('❌ get gallery error:', err.message);
    return res.status(500).json({ success: false, message: 'Get gallery error.' });
  }
});

// Chat Messages History API (purani chat load karne ke liye)
app.get('/api/messages/:otherUserId', authenticateUser, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const { otherUserId } = req.params;

    const chatRoomId = [currentUserId, otherUserId].sort().join('_');

    const { data, error } = await supabase
      .from('messages')
      .select('room_id, sender_id, receiver_id, text, timestamp')
      .eq('room_id', chatRoomId)
      .order('timestamp', { ascending: true })
      .limit(50);

    if (error) throw error;

    return res.status(200).json({ success: true, count: data.length, messages: data });
  } catch (err) {
    console.error('❌ chat history error:', err.message);
    return res.status(500).json({ success: false, message: 'Chat history error.' });
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
    const { receiverId, text } = data || {};
    const senderId = socket.user.uid;

    if (!receiverId || !text) return;

    const chatRoomId = [senderId, receiverId].sort().join('_');
    const nowIso = new Date().toISOString();

    const messageData = {
      room_id: chatRoomId,
      sender_id: senderId,
      receiver_id: receiverId,
      text: text,
      timestamp: nowIso,
    };

    // Emit immediately for real-time responsiveness, then persist to Supabase
    io.to(receiverId).emit('receive_message', messageData);

    try {
      const { error } = await supabase.from('messages').insert(messageData);
      if (error) console.error('❌ Error saving chat message:', error.message);
    } catch (err) {
      console.error('❌ Error saving chat message:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.user.uid}`);
  });
});

// 9. Start Server
server.listen(PORT, () => {
  console.log(`✅ Server running with Socket.io Chat Engine (Supabase) on port ${PORT}`);
});
