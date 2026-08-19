const { useState, useEffect, useRef } = React;

const VERSION = "v0.4.0";

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

const CATEGORIES = [
  { id: "vegetables", label: "ירקות ופירות",   emoji: "🥦" },
  { id: "pantry",     label: "קפה ושימורים",   emoji: "☕" },
  { id: "cleaning",   label: "חומרי ניקוי",    emoji: "🧴" },
  { id: "dairy",      label: "מוצרי חלב",      emoji: "🥛" },
  { id: "eggs",       label: "ביצים",           emoji: "🥚" },
  { id: "paper",      label: "מוצרי נייר",     emoji: "🧻" },
  { id: "other",      label: "שונות",           emoji: "🛍️" },
];
const UNITS = ["יחידות", "ק\"ג", "גרם", "ליטר", "מ\"ל", "קופסה", "חבילה", "צרור"];

function categoryOrder(label) {
  const i = CATEGORIES.findIndex(c => c.label === label);
  return i === -1 ? CATEGORIES.length : i;
}
function groupByCategory(items) {
  const map = {};
  items.forEach(item => {
    const label = item.category || "שונות";
    if (!map[label]) map[label] = { label, emoji: item.categoryEmoji || "🛍️", items: [] };
    map[label].items.push(item);
  });
  return Object.values(map).sort((a, b) => categoryOrder(a.label) - categoryOrder(b.label));
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

function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />;
}

// Bottom sheet used for every dialog in the app — drag the handle down (or
// tap the scrim) to dismiss, matching the native "sheet" feel instead of a
// centered popup box.
function Modal({ onClose, children, disableClose, footer }) {
  const [dragY, setDragY] = useState(0);
  const startYRef = useRef(null);
  const handleRef = useRef(null);

  const onPointerDown = (e) => {
    if (disableClose) return;
    startYRef.current = e.clientY;
    if (handleRef.current) handleRef.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (startYRef.current === null) return;
    setDragY(Math.max(0, e.clientY - startYRef.current));
  };
  const onPointerUp = () => {
    if (dragY > 80) onClose();
    else setDragY(0);
    startYRef.current = null;
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-end" onClick={disableClose ? undefined : onClose}>
      <div
        className="relative bg-[#FBF4E7] w-full max-w-md sm:max-w-lg mx-auto rounded-t-3xl flex flex-col"
        style={{ transform: `translateY(${dragY}px)`, transition: dragY === 0 ? "transform 0.2s ease" : "none", maxHeight: "88dvh" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex-shrink-0 px-6 pt-4">
          <div
            ref={handleRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className={"w-10 h-1.5 bg-[#DECBA1] rounded-full mx-auto mb-3 " + (disableClose ? "" : "cursor-grab active:cursor-grabbing touch-none")}
          />
        </div>
        <div className={"overflow-y-auto px-6 min-h-0 flex-1 " + (footer ? "pb-4" : "pb-8")}>
          {children}
        </div>
        {footer && <div className="flex-shrink-0 px-6 pt-3 pb-6 border-t border-[#E5D8B5]">{footer}</div>}
      </div>
    </div>
  );
}

function ConfirmDialog({ message, confirmLabel, onConfirm, onClose }) {
  return (
    <Modal onClose={onClose}>
      <p className="text-center text-[#2B2418] font-medium text-base mb-6">{message}</p>
      <div className="grid grid-cols-2 gap-3">
        <button onClick={onClose} className="py-3 rounded-2xl border border-[#DECBA1] text-[#8A7F66] font-medium">ביטול</button>
        <button onClick={() => { onClose(); onConfirm(); }} className="py-3 rounded-2xl bg-[#B8462F] text-white font-semibold">{confirmLabel || "מחיקה"}</button>
      </div>
    </Modal>
  );
}

function RenameDialog({ title, initialValue, onSave, onClose }) {
  const [value, setValue] = useState(initialValue || "");
  return (
    <Modal onClose={onClose} footer={
      <button
        onClick={() => { const v = value.trim(); if (v) { onSave(v); onClose(); } }}
        disabled={!value.trim()}
        className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40"
      >
        שמירה
      </button>
    }>
      <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>{title}</h3>
      <input
        autoFocus
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && value.trim()) { onSave(value.trim()); onClose(); } }}
        className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none"
      />
    </Modal>
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

// ── ITEM DIALOG (add / edit) ─────────────────────────────────────────────────
function ItemDialog({ mode, item, onInsert, onSave, onClose }) {
  const isEdit = mode === "edit";
  const blankDraft = () => {
    const other = CATEGORIES.find(c => c.id === "other") || CATEGORIES[CATEGORIES.length - 1];
    return { name: "", category: other.label, categoryEmoji: other.emoji, quantity: 1, unit: "יחידות", note: "", price: "" };
  };
  const [draft, setDraft] = useState(() => {
    if (!isEdit || !item) return blankDraft();
    return Object.assign({}, blankDraft(), item, { price: typeof item.price === "number" ? String(item.price) : "" });
  });
  const [saving, setSaving] = useState(false);
  const [savingQuit, setSavingQuit] = useState(false);

  const set = (patch) => setDraft(prev => Object.assign({}, prev, patch));

  const toPayload = (d) => {
    const parsedPrice = d.price !== "" ? parseFloat(String(d.price).replace(",", ".")) : null;
    return {
      name: d.name.trim(),
      category: d.category,
      categoryEmoji: d.categoryEmoji,
      quantity: parseFloat(d.quantity) || 1,
      unit: d.unit,
      note: d.note.trim(),
      price: Number.isFinite(parsedPrice) ? parsedPrice : null,
    };
  };

  const doSave = (quitAfter) => {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    setSavingQuit(!!quitAfter);
    if (isEdit) {
      onSave(toPayload(draft));
      return;
    }
    onInsert(toPayload(draft), () => {
      setSaving(false);
      if (quitAfter) { onClose(); return; }
      setDraft(blankDraft());
    });
  };

  return (
    <Modal onClose={onClose} disableClose={!isEdit} footer={
      isEdit ? (
        <button onClick={() => doSave(true)} disabled={!draft.name.trim() || saving}
          className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
          {saving ? <Spinner /> : "שמירת שינויים"}
        </button>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => doSave(false)} disabled={!draft.name.trim() || saving}
            className="flex-1 bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
            {saving && !savingQuit ? <Spinner /> : "+ הוספה"}
          </button>
          <button onClick={() => doSave(true)} disabled={!draft.name.trim() || saving}
            className="flex-1 py-3 rounded-2xl border border-[#DECBA1] text-[#8A7F66] font-medium text-sm disabled:opacity-40">
            {saving && savingQuit ? <Spinner /> : "סיום"}
          </button>
        </div>
      )
    }>
      <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>
        {isEdit ? "עריכת פריט" : "הוספת פריט"}
      </h3>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-[#8A7F66] block mb-1">שם</label>
          <input
            autoFocus={!isEdit}
            value={draft.name}
            onChange={e => set({ name: e.target.value })}
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-[#8A7F66] block mb-1">כמות</label>
            <div className="flex items-center gap-1">
              <button type="button"
                onClick={() => set({ quantity: Math.max(0.1, Math.round(((parseFloat(draft.quantity) || 1) - 1) * 10) / 10) })}
                className="w-10 h-11 rounded-xl bg-[#EFE4C6] text-[#8A7F66] text-xl font-bold flex items-center justify-center flex-shrink-0">−</button>
              <input type="number" min="0.1" step="0.1" value={draft.quantity}
                onChange={e => set({ quantity: e.target.value })}
                className="w-full min-w-0 border border-[#C7B78E] bg-white rounded-xl px-1 py-3 text-center outline-none" />
              <button type="button"
                onClick={() => set({ quantity: Math.round(((parseFloat(draft.quantity) || 0) + 1) * 10) / 10 })}
                className="w-10 h-11 rounded-xl bg-[#E3A939]/25 text-[#8A5A15] text-xl font-bold flex items-center justify-center flex-shrink-0">+</button>
            </div>
          </div>
          <div>
            <label className="text-xs text-[#8A7F66] block mb-1">יחידה</label>
            <select value={draft.unit} onChange={e => set({ unit: e.target.value })}
              className="w-full border border-[#C7B78E] bg-white rounded-xl px-3 py-3 text-right outline-none">
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs text-[#8A7F66] block mb-1">קטגוריה</label>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map(cat => {
              const selected = draft.category === cat.label;
              return (
                <button key={cat.id} type="button"
                  onClick={() => set({ category: cat.label, categoryEmoji: cat.emoji })}
                  className={"text-xs px-2.5 py-1.5 rounded-full border transition " +
                    (selected ? "bg-[#2E4A3B] text-[#FBF4E7] border-[#2E4A3B]" : "bg-white text-[#5B5749] border-[#DECBA1]")}>
                  {cat.emoji} {cat.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-xs text-[#8A7F66] block mb-1">מחיר משוער (אופציונלי)</label>
          <input
            value={draft.price}
            onChange={e => set({ price: e.target.value })}
            inputMode="decimal"
            placeholder="₪"
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none"
          />
        </div>

        <div>
          <label className="text-xs text-[#8A7F66] block mb-1">הערה</label>
          <input value={draft.note} onChange={e => set({ note: e.target.value })} placeholder="אופציונלי"
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none" />
        </div>
      </div>
    </Modal>
  );
}

// ── ITEM ROW ──────────────────────────────────────────────────────────────────
function ItemRow({ item, onToggle, onDelete, onEdit, onUpdateNote }) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteVal, setNoteVal] = useState(item.note || "");

  const openNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(true); };
  const saveNote = (e) => { e.stopPropagation(); onUpdateNote(noteVal.trim()); setEditingNote(false); };
  const cancelNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(false); };

  const qtyCount = item.quantity && item.quantity !== 1 ? `(${item.quantity})` : "";
  const qtyUnit = item.unit && item.unit !== "יחידות" ? item.unit : "";
  const qty = [qtyCount, qtyUnit].filter(Boolean).join(" ");

  return (
    <div className="py-2.5 border-b-2 border-dotted border-[#E0D4B4]">
      <div className="flex items-center gap-3">
        <button
          onClick={() => onToggle(item)}
          className={"w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] shrink-0 " +
            (item.done ? "bg-[#B8462F] border-[#B8462F] text-white" : "border-[#B8462F] text-transparent")}
        >✓</button>

        <div className="flex-1 min-w-0" onClick={() => onEdit(item)}>
          <span className={"text-[15px] " + (item.done ? "line-through text-[#A79A7C]" : "text-[#2B2418]")}>
            {item.name}
          </span>
          {!editingNote && item.note ? (
            <div onClick={openNote} className="text-xs text-[#A79A7C] mt-0.5 flex items-start gap-1">
              <span className="flex-shrink-0">💬</span><span className="break-words">{item.note}</span>
            </div>
          ) : !editingNote ? (
            <button onClick={openNote} className="text-xs text-[#C7B78E] mt-0.5 flex items-center gap-0.5">
              <span>💬</span><span>הוסף הערה</span>
            </button>
          ) : null}
        </div>

        {qty ? (
          <span className="text-xs font-medium text-[#8A7F66] bg-[#EFE4C6] px-2 py-0.5 rounded-full flex-shrink-0">{qty}</span>
        ) : null}
        {typeof item.price === "number" && (
          <span className="text-[14px] font-bold text-[#2E4A3B] tabular-nums flex-shrink-0">{formatPrice(item.price)}</span>
        )}
        <button onClick={() => onDelete(item)} className="text-[#C7B78E] text-[13px] px-1 flex-shrink-0">✕</button>
      </div>

      {editingNote && (
        <div className="pt-2 pr-8">
          <textarea value={noteVal} onChange={e => setNoteVal(e.target.value)} autoFocus rows={2}
            placeholder="הוסף הערה..."
            className="w-full text-sm border border-[#C7B78E] bg-white rounded-xl px-3 py-2 resize-none outline-none text-right" />
          <div className="flex gap-2 mt-1.5">
            <button onClick={saveNote} className="text-xs bg-[#2E4A3B] text-white px-4 py-1.5 rounded-lg font-medium">שמירה</button>
            <button onClick={cancelNote} className="text-xs text-[#8A7F66] px-3 py-1.5 rounded-lg border border-[#DECBA1]">ביטול</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── LIST CARD (home row) ─────────────────────────────────────────────────────
function ListCard({ list, onOpen, menuOpen, onMenuToggle, onRename, onDuplicate, onMarkDone, onRestore, onDelete }) {
  const menuBtnRef = useRef(null);
  const [menuLayout, setMenuLayout] = useState(null);

  const handleMenuToggle = (e) => {
    if (!menuOpen && menuBtnRef.current) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const upward = spaceBelow < 260 && spaceAbove > spaceBelow;
      setMenuLayout({
        openUpward: upward,
        left: Math.max(8, rect.right - 190),
        top: upward ? null : rect.bottom + 4,
        bottom: upward ? window.innerHeight - rect.top + 4 : null,
      });
    }
    onMenuToggle(e);
  };

  return (
    <div className="relative">
      <div
        onClick={onOpen}
        className={"bg-white border rounded-2xl px-4 py-4 flex items-center gap-2 shadow-sm cursor-pointer " +
          (list.done ? "border-[#E0D4B4]" : "border-[#E0D4B4]")}
      >
        <span className="text-[16px] font-medium text-right flex-1 min-w-0 truncate " style={{ color: list.done ? "#A79A7C" : "#2B2418", textDecoration: list.done ? "line-through" : "none" }}>
          {list.name}
        </span>
        <button ref={menuBtnRef} onClick={e => { e.stopPropagation(); handleMenuToggle(e); }}
          className="text-[#C7B78E] text-xl px-1 flex-shrink-0">⋮</button>
      </div>

      {menuOpen && menuLayout && (
        <div
          className="fixed bg-white rounded-xl shadow-xl border border-[#E5D8B5] z-20 min-w-44 overflow-hidden"
          style={{ left: menuLayout.left, top: menuLayout.top ?? undefined, bottom: menuLayout.bottom ?? undefined }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={onRename} className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2">
            <span>✏️</span><span>שינוי שם</span>
          </button>
          <button onClick={onDuplicate} className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2">
            <span>📋</span><span>שכפול רשימה</span>
          </button>
          {!list.done ? (
            <button onClick={onMarkDone} className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2">
              <span>✅</span><span>סימון כהושלם</span>
            </button>
          ) : (
            <button onClick={onRestore} className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2">
              <span>↩️</span><span>החזרה לפעיל</span>
            </button>
          )}
          <button onClick={onDelete} className="w-full text-right px-4 py-3 text-sm text-[#B8462F] hover:bg-[#FBEAE5] flex items-center gap-2 border-t border-[#E5D8B5]">
            <span>🗑️</span><span>מחיקה</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function Home({ uid, onOpenList, onSignOut }) {
  const [lists, setLists] = useState(null);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [renaming, setRenaming] = useState(null); // list or null
  const [confirmDelete, setConfirmDelete] = useState(null); // list or null
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    return db.collection("lists").where("ownerId", "==", uid)
      .onSnapshot(snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        setLists(rows);
      });
  }, [uid]);

  useEffect(() => {
    const close = () => setMenuOpenId(null);
    if (menuOpenId) { window.addEventListener("click", close); return () => window.removeEventListener("click", close); }
  }, [menuOpenId]);

  // Tapping "+" creates an auto-named list immediately and jumps straight
  // into it — no naming step up front. Renaming later (from the list's own
  // menu) is one tap, and this way starting a list never blocks on typing.
  async function quickCreate() {
    if (creating) return;
    setCreating(true);
    const prefix = "רשימת קניות #";
    let maxNum = 0;
    (lists || []).forEach(l => {
      if (l.name && l.name.indexOf(prefix) === 0) {
        const num = parseInt(l.name.substring(prefix.length), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    });
    const name = prefix + (maxNum + 1);
    const ref = await db.collection("lists").add({
      name,
      ownerId: uid,
      done: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setCreating(false);
    onOpenList(ref.id, name);
  }

  function renameList(list, name) {
    db.collection("lists").doc(list.id).update({ name });
  }

  async function duplicateList(list) {
    const itemsSnap = await db.collection("lists").doc(list.id).collection("items").get();
    const newRef = await db.collection("lists").add({
      name: list.name + " (עותק)",
      ownerId: uid,
      done: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    const batch = db.batch();
    itemsSnap.docs.forEach(d => {
      const data = d.data();
      const itemRef = newRef.collection("items").doc();
      batch.set(itemRef, Object.assign({}, data, { done: false, addedAt: firebase.firestore.FieldValue.serverTimestamp() }));
    });
    await batch.commit();
  }

  function markDone(list) { db.collection("lists").doc(list.id).update({ done: true }); }
  function restoreList(list) { db.collection("lists").doc(list.id).update({ done: false }); }

  async function deleteList(list) {
    const itemsSnap = await db.collection("lists").doc(list.id).collection("items").get();
    const batch = db.batch();
    itemsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection("lists").doc(list.id));
    await batch.commit();
  }

  const active = (lists || []).filter(l => !l.done);
  const done = (lists || []).filter(l => l.done);

  function renderCard(list) {
    return (
      <ListCard
        key={list.id}
        list={list}
        onOpen={() => onOpenList(list.id, list.name)}
        menuOpen={menuOpenId === list.id}
        onMenuToggle={() => setMenuOpenId(menuOpenId === list.id ? null : list.id)}
        onRename={() => { setMenuOpenId(null); setRenaming(list); }}
        onDuplicate={() => { setMenuOpenId(null); duplicateList(list); }}
        onMarkDone={() => { setMenuOpenId(null); markDone(list); }}
        onRestore={() => { setMenuOpenId(null); restoreList(list); }}
        onDelete={() => { setMenuOpenId(null); setConfirmDelete(list); }}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <AppIcon size={30} />
        <div className="text-[17px]" style={{ fontFamily: "'Suez One', serif", color: "#2E4A3B" }}>SuperZola</div>
        <div className="flex-1" />
        <button onClick={onSignOut} className="text-[13px] text-[#8A7F66] underline">התנתקות</button>
      </div>

      <div className="px-4 pb-4">
        <h1 className="text-2xl" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הרשימות שלי</h1>
      </div>

      <div className="px-4 flex flex-col gap-2">
        {lists === null && <div className="text-[#8A7F66] text-sm py-6 text-center">טוען רשימות...</div>}
        {lists !== null && lists.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">אין עדיין רשימות. צרו את הראשונה!</div>
        )}
        {active.map(renderCard)}
      </div>

      <div className="px-4 mt-4">
        <button
          onClick={quickCreate}
          disabled={creating}
          className="w-full border-2 border-dashed border-[#C7B78E] rounded-2xl py-3 text-[#A0906B] text-[15px] disabled:opacity-50"
        >
          {creating ? "יוצר..." : "+ רשימה חדשה"}
        </button>
      </div>

      {done.length > 0 && (
        <div className="px-4 mt-8">
          <div className="text-xs font-semibold text-[#A79A7C] mb-2 uppercase tracking-wide">הושלמו</div>
          <div className="flex flex-col gap-2">{done.map(renderCard)}</div>
        </div>
      )}

      {renaming && (
        <RenameDialog title="שינוי שם הרשימה" initialValue={renaming.name}
          onSave={name => renameList(renaming, name)} onClose={() => setRenaming(null)} />
      )}
      {confirmDelete && (
        <ConfirmDialog message={`למחוק את הרשימה "${confirmDelete.name}"?`}
          onConfirm={() => deleteList(confirmDelete)} onClose={() => setConfirmDelete(null)} />
      )}
    </div>
  );
}

// ── LIST SCREEN ───────────────────────────────────────────────────────────────
function ListScreen({ uid, listId, listName, onBack }) {
  const [list, setList] = useState({ name: listName, done: false });
  const [items, setItems] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDeleteList, setConfirmDeleteList] = useState(false);

  useEffect(() => db.collection("lists").doc(listId).onSnapshot(snap => {
    if (snap.exists) setList({ id: snap.id, ...snap.data() });
  }), [listId]);

  useEffect(() => {
    return db.collection("lists").doc(listId).collection("items").orderBy("addedAt")
      .onSnapshot(snap => setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [listId]);

  function insertItem(payload, done) {
    db.collection("lists").doc(listId).collection("items").add(Object.assign({}, payload, {
      done: false,
      addedBy: uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    })).then(() => done());
  }

  function saveEdit(payload) {
    db.collection("lists").doc(listId).collection("items").doc(editItem.id).update(payload).then(() => setEditItem(null));
  }

  function toggleItem(item) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).update({ done: !item.done });
  }
  function deleteItem(item) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).delete();
  }
  function updateNote(item, note) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).update({ note });
  }

  function renameList(name) { db.collection("lists").doc(listId).update({ name }); }
  function toggleListDone() { db.collection("lists").doc(listId).update({ done: !list.done }); }
  async function deleteList() {
    const itemsSnap = await db.collection("lists").doc(listId).collection("items").get();
    const batch = db.batch();
    itemsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection("lists").doc(listId));
    await batch.commit();
    onBack();
  }

  const total = (items || []).reduce((sum, it) => sum + (typeof it.price === "number" ? it.price : 0), 0);
  const doneCount = (items || []).filter(it => it.done).length;
  const groups = groupByCategory(items || []);

  return (
    <div className="min-h-dvh bg-[#FBF4E7] flex flex-col">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <button onClick={onBack} className="text-[#F3ECD9] text-xl px-1">›</button>
        <h1 className="text-xl flex-1 min-w-0 truncate" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>{list.name}</h1>
        <span className="text-[12px] text-[#C9BE9E] flex-shrink-0">{items ? `${doneCount} מתוך ${items.length}` : ""}</span>
        <button onClick={() => setShowMenu(true)} className="text-[#F3ECD9] text-lg w-8 h-8 flex items-center justify-center bg-white/10 rounded-full flex-shrink-0">☰</button>
      </div>

      <div className="flex-1 px-3 pt-3">
        {items === null && <div className="text-[#8A7F66] text-sm py-6 text-center">טוען...</div>}
        {items !== null && items.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">הרשימה ריקה</div>
        )}
        {groups.map(group => (
          <div key={group.label} className="mb-5">
            <div className="text-xs font-semibold text-[#8A9A72] mb-1.5 flex items-center gap-1.5 uppercase tracking-wide px-1">
              <span>{group.emoji}</span><span>{group.label}</span>
            </div>
            <div>
              {group.items.map(item => (
                <ItemRow key={item.id} item={item}
                  onToggle={toggleItem} onDelete={deleteItem} onEdit={setEditItem}
                  onUpdateNote={note => updateNote(item, note)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setShowAdd(true)}
        className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-[#2E4A3B] text-[#FBF4E7] px-5 py-3 rounded-2xl shadow-xl font-semibold text-sm flex items-center gap-1.5"
      >
        <span className="text-base font-light">+</span> הוספת פריט
      </button>

      <div className="bg-[#26361F] px-4 pt-3 pb-6 flex items-center justify-between">
        <span className="text-[#F3ECD9] text-[15px]">סה"כ</span>
        <span className="text-[#F3ECD9] text-xl font-bold tabular-nums">{formatPrice(total)}</span>
      </div>

      {showAdd && (
        <ItemDialog mode="add" onInsert={insertItem} onClose={() => setShowAdd(false)} />
      )}
      {editItem && (
        <ItemDialog mode="edit" item={editItem} onSave={saveEdit} onClose={() => setEditItem(null)} />
      )}

      {showMenu && (
        <Modal onClose={() => setShowMenu(false)}>
          <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>פעולות</h3>
          <div className="space-y-1">
            <button onClick={() => { setShowMenu(false); setRenaming(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">✏️</span><span className="text-sm font-medium text-[#2B2418]">שינוי שם</span>
            </button>
            <button onClick={() => { setShowMenu(false); toggleListDone(); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">{list.done ? "↩️" : "✅"}</span>
              <span className="text-sm font-medium text-[#2B2418]">{list.done ? "החזרה לפעיל" : "סימון כהושלם"}</span>
            </button>
            <button onClick={() => { setShowMenu(false); setConfirmDeleteList(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#FBEAE5] text-[#B8462F]">
              <span className="text-lg">🗑️</span><span className="text-sm font-medium">מחיקת רשימה</span>
            </button>
          </div>
        </Modal>
      )}
      {renaming && (
        <RenameDialog title="שינוי שם הרשימה" initialValue={list.name} onSave={renameList} onClose={() => setRenaming(false)} />
      )}
      {confirmDeleteList && (
        <ConfirmDialog message={`למחוק את הרשימה "${list.name}"?`} onConfirm={deleteList} onClose={() => setConfirmDeleteList(false)} />
      )}
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
      <ListScreen
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
