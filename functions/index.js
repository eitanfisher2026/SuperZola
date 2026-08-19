const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const REGION = 'europe-west1'; // must match the client's functions("europe-west1") call

// Creates the Firestore profile the moment a Google sign-in produces a new
// Auth user — server-side only, so the client never writes (and can never
// forge) its own role. Every new account starts as a plain 'user'; admin
// promotes editors/admins by hand later.
exports.onUserCreate = functions.region(REGION).auth.user().onCreate(async (user) => {
  await db.collection('users').doc(user.uid).set({
    email: user.email || null,
    displayName: user.displayName || null,
    role: 'user',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});
