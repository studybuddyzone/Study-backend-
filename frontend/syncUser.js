/**
 * syncUser.js
 * -----------------------------------------------------------------------
 * Frontend helper for StudyBuddyZone.
 * Call this right after a successful Firebase sign-in (e.g. in your
 * onAuthStateChanged callback, or right after signInWithPopup/Email/etc.)
 * to sync the user's profile with the Node.js backend.
 * -----------------------------------------------------------------------
 *
 * Usage:
 *   import { syncUserWithBackend } from './syncUser.js';
 *
 *   onAuthStateChanged(auth, async (firebaseUser) => {
 *     if (firebaseUser) {
 *       await syncUserWithBackend(firebaseUser, 'http://localhost:5000');
 *     }
 *   });
 */

/**
 * Sends the current Firebase user's profile + ID token to the backend
 * so it can be recorded/synced server-side.
 *
 * @param {import('firebase/auth').User} firebaseUser - The signed-in Firebase user object.
 * @param {string} backendBaseUrl - Base URL of the backend, e.g. "http://localhost:5000".
 * @returns {Promise<object|null>} The backend's response data, or null if the sync failed.
 */
export async function syncUserWithBackend(firebaseUser, backendBaseUrl) {
  if (!firebaseUser) {
    console.warn('⚠️ syncUserWithBackend called without a valid firebaseUser.');
    return null;
  }

  if (!backendBaseUrl) {
    console.warn('⚠️ syncUserWithBackend called without a backendBaseUrl.');
    return null;
  }

  try {
    // Force-refresh is optional; pass true if you want a guaranteed-fresh token.
    const idToken = await firebaseUser.getIdToken();

    const response = await fetch(`${backendBaseUrl}/api/users/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        name: firebaseUser.displayName || null,
        email: firebaseUser.email || null,
        photoURL: firebaseUser.photoURL || null,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.error('❌ Failed to parse sync response as JSON:', parseErr.message);
      return null;
    }

    if (!response.ok) {
      console.error(
        `❌ User sync failed (status ${response.status}):`,
        data?.message || 'Unknown error'
      );
      return null;
    }

    console.log('✅ User synced with backend:', data.user);
    return data;
  } catch (err) {
    // Covers network failures, CORS issues, token retrieval errors, etc.
    console.error('❌ Error syncing user with backend:', err.message);
    return null;
  }
}
