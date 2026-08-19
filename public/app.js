const { useState, useEffect } = React;

const VERSION = "v0.3.0";

// ── CONFIG ────────────────────────────────────────────────────────────────────
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

function formatPrice(n) {
  return "₪" + n.toFixed(2);
}

// ── SHARED UI ─────────────────────────────────────────────────────────────────
function AppIcon({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="shrink-0">
      <rect width="100" height="100" rx="22" fill="#E3A939" />
      <g stroke="#2B2418" strokeWidth="4" strokeLinecap="round">
        <line x1="80" y1="50" x2="90" y2="50" />
        <line x1="71.2" y1="71.2" x2="78.3" y2="78.3" />
        <line x1="50" y1="80" x2="50" y2="90" />
        <line x1="28.8" y1="71.2" x2="21.7" y2="78.3" />
        <line x1="20" y1="50" x2="10" y2="50" />
        <line x1="28.8" y1="28.8" x2="21.7" y2="21.7" />
        <line x1="50" y1="20" x2="50" y2="10" />
        <line x1="71.2" y1="28.8" x2="78.3" y2="21.7" />
      </g>
      <circle cx="50" cy="50" r="22" fill="#FBF4E7" />
      <text x="50" y="59" textAnchor="middle" style={{ fontFamily: "'Suez One', serif" }} fontSize="26" fill="#2B2418">SZ</text>
    </svg>
  );
}

function TopBar({ children }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-3">
      <AppIcon size={30} />
      <div className="text-[17px]" style={{ fontFamily: "'Suez One', serif", color: "#2E4A3B" }}>SuperZola</div>
      <div className="flex-1" />
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#FBF4E7] text-[#8A7F66]">
      טוען...
    </div>
  );
}

function SignInScreen() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-8 bg-[#FBF4E7] px-6">
      <AppIcon size={72} />
      <h1 className="text-3xl" style={{ fontFamily: "'Suez One', serif", color: "#2E4A3B" }}>SuperZola</h1>
      <button
        className="bg-[#2E4A3B] text-[#FBF4E7] px-7 py-3.5 rounded-2xl font-bold text-[15px] shadow-sm"
        onClick={signIn}
      >
        התחברות עם Google
      </button>
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function Home({ uid, onOpenList, onSignOut }) {
  const [lists, setLists] = useState(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    return db.collection("lists").where("ownerId", "==", uid)
      .onSnapshot(snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        setLists(rows);
      });
  }, [uid]);

  async function createList() {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    setAdding(false);
    await db.collection("lists").add({
      name,
      ownerId: uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <TopBar>
        <button onClick={onSignOut} className="text-[13px] text-[#8A7F66] underline">התנתקות</button>
      </TopBar>

      <div className="px-4 pb-4">
        <h1 className="text-2xl" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הרשימות שלי</h1>
      </div>

      <div className="px-4 flex flex-col gap-2">
        {lists === null && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">טוען רשימות...</div>
        )}
        {lists !== null && lists.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">אין עדיין רשימות. צרו את הראשונה!</div>
        )}
        {lists && lists.map(list => (
          <button
            key={list.id}
            onClick={() => onOpenList(list.id, list.name)}
            className="bg-white border border-[#E0D4B4] rounded-2xl px-4 py-4 flex items-center justify-between text-right shadow-sm"
          >
            <span className="text-[16px] font-medium text-[#2B2418]">{list.name}</span>
            <span className="text-[#C7B78E] text-lg">‹</span>
          </button>
        ))}
      </div>

      <div className="px-4 mt-4">
        {adding ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") createList(); if (e.key === "Escape") setAdding(false); }}
              placeholder="שם הרשימה"
              className="flex-1 bg-white border border-[#C7B78E] rounded-xl px-3 py-2.5 text-[15px] outline-none"
            />
            <button onClick={createList} className="bg-[#2E4A3B] text-[#FBF4E7] px-4 rounded-xl font-bold">הוספה</button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="w-full border-2 border-dashed border-[#C7B78E] rounded-2xl py-3 text-[#A0906B] text-[15px]"
          >
            + רשימה חדשה
          </button>
        )}
      </div>
    </div>
  );
}

// ── LIST DETAIL ───────────────────────────────────────────────────────────────
function ListDetail({ uid, listId, listName, onBack }) {
  const [items, setItems] = useState(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    return db.collection("lists").doc(listId).collection("items").orderBy("addedAt")
      .onSnapshot(snap => setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [listId]);

  async function addItem() {
    const n = name.trim();
    if (!n) return;
    const parsed = price.trim() ? parseFloat(price.replace(",", ".")) : null;
    setName("");
    setPrice("");
    await db.collection("lists").doc(listId).collection("items").add({
      name: n,
      price: Number.isFinite(parsed) ? parsed : null,
      done: false,
      addedBy: uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  function toggleItem(item) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).update({ done: !item.done });
  }

  function deleteItem(item) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).delete();
  }

  function deleteList() {
    if (!window.confirm(`למחוק את הרשימה "${listName}"?`)) return;
    db.collection("lists").doc(listId).delete();
    onBack();
  }

  const total = (items || []).reduce((sum, it) => sum + (typeof it.price === "number" ? it.price : 0), 0);
  const doneCount = (items || []).filter(it => it.done).length;

  return (
    <div className="min-h-dvh bg-[#FBF4E7] flex flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <button onClick={onBack} className="text-[#2E4A3B] text-xl px-1">›</button>
        <h1 className="text-xl flex-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>{listName}</h1>
        <span className="text-[12px] text-[#8A7F66]">{items ? `${doneCount} מתוך ${items.length}` : ""}</span>
        <button onClick={deleteList} className="text-[#B8462F] text-[13px] px-2">מחיקה</button>
      </div>

      <div className="px-4 pb-3 flex gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addItem(); }}
          placeholder="הוספת פריט"
          className="flex-1 bg-white border border-[#C7B78E] rounded-xl px-3 py-2.5 text-[15px] outline-none"
        />
        <input
          value={price}
          onChange={e => setPrice(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addItem(); }}
          placeholder="מחיר"
          inputMode="decimal"
          className="w-20 bg-white border border-[#C7B78E] rounded-xl px-2 py-2.5 text-[15px] outline-none text-center"
        />
        <button onClick={addItem} className="bg-[#2E4A3B] text-[#FBF4E7] w-11 rounded-xl font-bold text-lg">+</button>
      </div>

      <div className="flex-1 px-3">
        {items === null && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">טוען...</div>
        )}
        {items !== null && items.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">הרשימה ריקה</div>
        )}
        {items && items.map(item => (
          <div key={item.id} className="flex items-center gap-3 py-2.5 px-1 border-b-2 border-dotted border-[#E0D4B4]">
            <button
              onClick={() => toggleItem(item)}
              className={"w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] shrink-0 " +
                (item.done ? "bg-[#B8462F] border-[#B8462F] text-white" : "border-[#B8462F] text-transparent")}
            >✓</button>
            <span className={"flex-1 text-[15px] " + (item.done ? "line-through text-[#A79A7C]" : "text-[#2B2418]")}>
              {item.name}
            </span>
            {typeof item.price === "number" && (
              <span className="text-[14px] font-bold text-[#2E4A3B] tabular-nums">{formatPrice(item.price)}</span>
            )}
            <button onClick={() => deleteItem(item)} className="text-[#C7B78E] text-[13px] px-1">✕</button>
          </div>
        ))}
      </div>

      <div className="bg-[#26361F] px-4 pt-3 pb-6 flex items-center justify-between">
        <span className="text-[#F3ECD9] text-[15px]">סה"כ</span>
        <span className="text-[#F3ECD9] text-xl font-bold tabular-nums">{formatPrice(total)}</span>
      </div>
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
function App() {
  const [user, setUser] = useState(undefined); // undefined = still resolving
  const [screen, setScreen] = useState({ view: "home" });

  useEffect(() => {
    return auth.onAuthStateChanged(setUser);
  }, []);

  useEffect(() => {
    if (!user) return;
    db.collection("users").doc(user.uid).update({
      lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {}); // no-op until the profile doc exists
  }, [user]);

  if (user === undefined) return <Loading />;
  if (!user) return <SignInScreen />;

  if (screen.view === "list") {
    return (
      <ListDetail
        uid={user.uid}
        listId={screen.id}
        listName={screen.name}
        onBack={() => setScreen({ view: "home" })}
      />
    );
  }

  return (
    <Home
      uid={user.uid}
      onOpenList={(id, name) => setScreen({ view: "list", id, name })}
      onSignOut={signOut}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
