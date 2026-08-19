    const { useState, useEffect } = React;

    const VERSION = "v0.1.0";

    // ── CONFIG ────────────────────────────────────────────────────────────────────
    // TODO: replace once the Firebase project exists — copy this block from
    // Project settings → General → Your apps → SDK setup and configuration.
    const FIREBASE_CONFIG = {
      apiKey: "AIzaSyAGgVfSLivPF_UPvp_0ZjlFzTmj8sqT-rU",
      authDomain: "superzola.firebaseapp.com",
      projectId: "superzola",
      storageBucket: "superzola.firebasestorage.app",
      messagingSenderId: "1010693964960",
      appId: "1:1010693964960:web:423a4f829bc94e8aa235c5"
    };

    // ── FIREBASE ──────────────────────────────────────────────────────────────────
    firebase.initializeApp(FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db   = firebase.firestore();
    const fns  = firebase.app().functions("europe-west1"); // must match functions region in functions/index.js

    function signIn() {
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    }
    function signOut() {
      auth.signOut();
    }

    // ── APP ───────────────────────────────────────────────────────────────────────
    function App() {
      const [user, setUser] = useState(undefined); // undefined = still resolving
      const [profile, setProfile] = useState(null);

      useEffect(() => {
        return auth.onAuthStateChanged(setUser);
      }, []);

      useEffect(() => {
        if (!user) { setProfile(null); return; }
        // Created server-side by the onUserCreate auth trigger — may not
        // exist yet on the very first sign-in until that trigger finishes.
        return db.collection("users").doc(user.uid).onSnapshot(snap => {
          setProfile(snap.exists ? snap.data() : null);
        });
      }, [user]);

      useEffect(() => {
        if (!user) return;
        db.collection("users").doc(user.uid).update({
          lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {}); // no-op until the profile doc exists
      }, [user]);

      if (user === undefined) {
        return React.createElement("div", { className: "min-h-dvh flex items-center justify-center text-gray-500" }, "טוען...");
      }

      if (!user) {
        return React.createElement("div", { className: "min-h-dvh flex flex-col items-center justify-center gap-6" },
          React.createElement("h1", { className: "text-2xl font-bold" }, "SuperZola"),
          React.createElement("button", {
            className: "bg-blue-600 text-white px-6 py-3 rounded-2xl font-semibold",
            onClick: signIn
          }, "התחברות עם Google")
        );
      }

      return React.createElement("div", { className: "min-h-dvh flex flex-col items-center justify-center gap-3 text-center px-6" },
        React.createElement("h1", { className: "text-2xl font-bold" }, "SuperZola"),
        React.createElement("p", { className: "text-gray-600" }, "מחוברת/מחובר בתור " + user.email),
        React.createElement("p", { className: "text-gray-400 text-sm" }, "תפקיד: " + (profile ? profile.role : "נטען...")),
        React.createElement("button", {
          className: "text-blue-600 underline text-sm mt-4",
          onClick: signOut
        }, "התנתקות")
      );
    }

    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
