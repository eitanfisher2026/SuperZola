const { useState, useEffect, useRef } = React;

const VERSION = "v1.8";

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

// Seeded into Firestore (categories collection) the first time it's empty —
// from then on this is only the emergency fallback if that read ever fails.
const DEFAULT_CATEGORIES = [
  { id: "vegetables", label: "ירקות ופירות",   emoji: "🥦", order: 0 },
  { id: "pantry",     label: "קפה ושימורים",   emoji: "☕", order: 1 },
  { id: "cleaning",   label: "חומרי ניקוי",    emoji: "🧴", order: 2 },
  { id: "dairy",      label: "מוצרי חלב",      emoji: "🥛", order: 3 },
  { id: "eggs",       label: "ביצים",           emoji: "🥚", order: 4 },
  { id: "paper",      label: "מוצרי נייר",     emoji: "🧻", order: 5 },
  { id: "other",      label: "שונות",           emoji: "🛍️", order: 6 },
];
const UNITS = ["יחידות", "ק\"ג", "גרם", "ליטר", "מ\"ל", "קופסה", "חבילה", "צרור"];

// Live categories from Firestore, ordered per the admin-managed sort order
// (Settings). Seeds the collection with the defaults above the first time
// it's genuinely empty, so a brand-new project isn't left with no
// categories at all until someone visits Settings.
function useCategories() {
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  useEffect(() => {
    return db.collection("categories").onSnapshot(snap => {
      if (snap.empty) {
        const batch = db.batch();
        DEFAULT_CATEGORIES.forEach(cat => batch.set(db.collection("categories").doc(cat.id), cat));
        batch.commit().catch(() => {});
        return;
      }
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      setCategories(rows);
    });
  }, []);
  return categories;
}

function categoryOrder(label, categories) {
  const i = categories.findIndex(c => c.label === label);
  return i === -1 ? categories.length : i;
}
function groupByCategory(items, categories) {
  const map = {};
  items.forEach(item => {
    const label = item.category || "שונות";
    if (!map[label]) map[label] = { label, emoji: item.categoryEmoji || "🛍️", items: [] };
    map[label].items.push(item);
  });
  return Object.values(map).sort((a, b) => categoryOrder(a.label, categories) - categoryOrder(b.label, categories));
}

// ── VENDOR PRICE COMPARISON — shared helpers ─────────────────────────────────
const VENDOR_LIST = [
  { id: "ramiLevy", label: "רמי לוי" },
  { id: "osherAd", label: "אושר עד" },
  { id: "keshet", label: "קשת טעמים" },
  { id: "yohananof", label: "יוחננוף" },
  { id: "superYuda", label: "סופר יודה" },
  { id: "lahav", label: "פרש מרקט" },
  { id: "shufersal", label: "שופרסל" },
  { id: "carrefour", label: "קרפור" },
  { id: "tivTaam", label: "טיב טעם" },
  { id: "salachDabach", label: "דבאח" },
  { id: "stopMarket", label: "סטופ מרקט" },
  { id: "victory", label: "ויקטורי" },
  { id: "mahsaniAshuk", label: "מחסני השוק" },
  { id: "haziHinam", label: "חצי חינם" },
  { id: "wolt", label: "וולט מרקט" },
];
function vendorLabel(id) {
  const v = VENDOR_LIST.find(x => x.id === id);
  return v ? v.label : id;
}
function itemVendorBarcode(item, vendorId) {
  return (item.barcodes && item.barcodes[vendorId]) || null;
}
function profileLabel(profile, allProfiles) {
  let label = vendorLabel(profile.vendor);
  const sameChainCount = allProfiles.filter(p => p.vendor === profile.vendor).length;
  if (sameChainCount > 1) label += ` (סניף ${parseInt(profile.branchId, 10)})`;
  return label;
}
// Resolves an item's price at every active profile it has a barcode for.
// promo.active reflects whether the item's actual quantity meets minQty.
function itemProfilePrices(item, activeProfiles, priceMap, promoMap) {
  const out = [];
  const qty = item.quantity || 1;
  (activeProfiles || []).forEach(p => {
    const bc = itemVendorBarcode(item, p.vendor);
    if (!bc) return;
    const vendorPrices = priceMap[p.id];
    if (!vendorPrices || !(bc in vendorPrices)) return;
    const price = vendorPrices[bc];
    const rawPromo = promoMap && promoMap[p.id] ? promoMap[p.id][bc] : null;
    let promo = null;
    if (rawPromo && rawPromo.price != null && (price == null || rawPromo.price < price)) {
      const minQty = rawPromo.minQty || 1;
      promo = Object.assign({}, rawPromo, { active: qty >= minQty });
    }
    out.push({ profile: p, price, promo });
  });
  return out;
}
function cheapestTextClass(mine, others) {
  if (mine == null) return "text-[#A79A7C]";
  const known = others.filter(o => o != null);
  if (known.length === 0 || known.every(o => mine < o)) return "text-[#2E7D4F]";
  return "text-[#5B5749]";
}
function promoTagPhrase(promo) {
  if (promo.weighted && promo.discountedPrice != null) return "₪" + promo.discountedPrice.toFixed(2) + ' לק"ג';
  if (promo.discountedPrice != null) return promo.minQty + " ב-₪" + promo.discountedPrice.toFixed(2);
  if (promo.discountRate != null) return "-" + Math.round(promo.discountRate) + "%";
  return "";
}
// True only once `active` has stayed true for `delayMs` — lets a search
// show a plain "מחפש..." for the common (fast, already-warm) case, and only
// mention a possible longer wait once it's actually taking a while.
function useDelayedFlag(active, delayMs) {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!active) { setLong(false); return; }
    const t = setTimeout(() => setLong(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return long;
}

function useActiveVendorProfiles(uid) {
  const [profiles, setProfiles] = useState([]);
  useEffect(() => {
    if (!uid) return;
    return db.collection("users").doc(uid).collection("vendorProfiles")
      .where("active", "==", true)
      .onSnapshot(snap => setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [uid]);
  return profiles;
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

function Toast({ msg }) {
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-[#2B2418] text-[#FBF4E7] text-sm px-5 py-2.5 rounded-full shadow-lg z-50 whitespace-nowrap">
      {msg}
    </div>
  );
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

// ── PRICE COMPARISON TABLE ────────────────────────────────────────────────────
// One row per item, one column per active vendor branch — lets you compare
// prices at a glance instead of reading them off each item's own chips.
function PriceComparisonTable({ items, activeProfiles, priceMap, promoMap, onEditItem }) {
  const notDone = items.filter(i => !i.done);
  const done = items.filter(i => i.done);
  const ordered = notDone.concat(done);

  const totals = {};
  activeProfiles.forEach(p => { totals[p.id] = { sum: 0, count: 0 }; });
  notDone.forEach(item => {
    const qty = item.quantity || 1;
    itemProfilePrices(item, activeProfiles, priceMap, promoMap).forEach(e => {
      if (e.price == null) return;
      const effective = (e.promo && e.promo.active) ? e.promo.price : e.price;
      totals[e.profile.id].sum += effective * qty;
      totals[e.profile.id].count++;
    });
  });

  if (activeProfiles.length === 0) {
    return <p className="text-center text-[#A79A7C] text-sm py-10">אין סניפים פעילים להשוואה — הוסיפו סניף בהגדרות</p>;
  }

  return (
    <div className="overflow-x-auto -mx-3 border border-[#E0D4B4] rounded-xl">
      <table className="min-w-full text-xs" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
        <thead>
          <tr>
            <th className="sticky right-0 bg-[#F3ECD9] z-10 font-semibold text-[#5B5749] text-right px-3 py-2 border-b border-[#E0D4B4]" style={{ minWidth: 140 }}>פריט</th>
            {activeProfiles.map(p => (
              <th key={p.id} className="font-semibold text-[#5B5749] text-center px-3 py-2 border-b border-[#E0D4B4] whitespace-nowrap">{profileLabel(p, activeProfiles)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map(item => {
            const priced = itemProfilePrices(item, activeProfiles, priceMap, promoMap);
            const byId = {};
            priced.forEach(e => { byId[e.profile.id] = e; });
            const qty = item.quantity || 1;
            return (
              <tr key={item.id} className="cursor-pointer active:bg-[#FBF4E7]" onClick={() => onEditItem(item)}>
                <td className={"sticky right-0 bg-white z-10 px-3 py-2 border-b border-[#F0E9D4] text-right " + (item.done ? "line-through text-[#A79A7C]" : "text-[#2B2418]")}>
                  {item.name}{qty !== 1 && <span className="text-[#A79A7C]"> ({qty})</span>}
                </td>
                {activeProfiles.map(p => {
                  const bc = itemVendorBarcode(item, p.vendor);
                  const vendorPrices = priceMap[p.id];
                  const fetched = !!(bc && vendorPrices && (bc in vendorPrices));
                  const price = fetched ? vendorPrices[bc] : null;
                  const promo = byId[p.id] ? byId[p.id].promo : null;
                  const promoActive = !!(promo && promo.active);
                  const effectivePrice = promoActive ? promo.price : price;
                  const others = priced.filter(e => e.profile.id !== p.id).map(e => (e.promo && e.promo.active) ? e.promo.price : e.price);
                  const cellClass = !bc ? "text-[#DECBA1]" : !fetched ? "text-[#DECBA1]" : cheapestTextClass(effectivePrice, others);
                  return (
                    <td key={p.id} className={"text-center px-3 py-2 border-b border-[#F0E9D4] " + cellClass}>
                      {!bc ? "—" : !fetched ? "…" : price != null ? (
                        <div className="leading-tight">
                          {promoActive ? (
                            <div>
                              <div className="font-bold">₪{(promo.price * qty).toFixed(2)}*</div>
                              <div className="text-[10px] text-[#A79A7C]">(₪{(price * qty).toFixed(2)})</div>
                            </div>
                          ) : (
                            <div>₪{(price * qty).toFixed(2)}</div>
                          )}
                        </div>
                      ) : "אין"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="sticky right-0 bg-[#F3ECD9] z-10 font-bold px-3 py-2 border-t-2 border-[#DECBA1] text-right">סה"כ</td>
            {activeProfiles.map(p => {
              const others = activeProfiles.filter(o => o.id !== p.id).map(o => totals[o.id].sum);
              return <td key={p.id} className={"font-bold text-center px-3 py-2 border-t-2 border-[#DECBA1] " + cheapestTextClass(totals[p.id].sum, others)}>₪{totals[p.id].sum.toFixed(2)}</td>;
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── ITEM ROW ──────────────────────────────────────────────────────────────────
function ItemRow({ item, activeProfiles, priceMap, promoMap, onToggle, onDelete, onEdit, onUpdateNote }) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteVal, setNoteVal] = useState(item.note || "");

  const openNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(true); };
  const saveNote = (e) => { e.stopPropagation(); onUpdateNote(noteVal.trim()); setEditingNote(false); };
  const cancelNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(false); };

  const qtyCount = item.quantity && item.quantity !== 1 ? `(${item.quantity})` : "";
  const qtyUnit = item.unit && item.unit !== "יחידות" ? item.unit : "";
  const qty = [qtyCount, qtyUnit].filter(Boolean).join(" ");

  const pricedEntries = itemProfilePrices(item, activeProfiles, priceMap || {}, promoMap || {});

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
          {pricedEntries.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1">
              {pricedEntries.map(e => {
                const effective = (e.promo && e.promo.active) ? e.promo.price : e.price;
                return (
                  <span key={e.profile.id} className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[#EFE4C6] text-[#5B5749] leading-tight">
                    {profileLabel(e.profile, activeProfiles)}: {e.promo && e.promo.active ? "₪" + e.promo.price.toFixed(2) + "*" : (e.price != null ? "₪" + e.price.toFixed(2) : "לא נמכר כאן")}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {qty ? (
          <span className="text-xs font-medium text-[#8A7F66] bg-[#EFE4C6] px-2 py-0.5 rounded-full flex-shrink-0">{qty}</span>
        ) : null}
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

// ── BULK ADD (AI) ─────────────────────────────────────────────────────────────
function BulkAddModal({ categories, hasAi, onInsertMany, onClose }) {
  const [text, setText] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");

  function process() {
    const t = text.trim();
    if (!t) return;
    setProcessing(true);
    setError("");
    fns.httpsCallable("parseItems")({ text: t, categories: categories.map(c => ({ label: c.label })) }).then(res => {
      setProcessing(false);
      onInsertMany(res.data.items || []);
      onClose();
    }).catch(e => {
      setProcessing(false);
      setError((e && e.message) || "שגיאה בעיבוד הטקסט");
    });
  }

  return (
    <Modal onClose={onClose} footer={
      hasAi ? (
        <button onClick={process} disabled={!text.trim() || processing}
          className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
          {processing ? <Spinner /> : "פענוח והוספה"}
        </button>
      ) : null
    }>
      <h3 className="text-lg text-center mb-3" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הוספה מרובה (AI)</h3>
      {!hasAi ? (
        <p className="text-sm text-[#8A7F66] text-center py-4">יש להגדיר ספק AI תחילה בהגדרות כדי להשתמש בתכונה הזו.</p>
      ) : (
        <React.Fragment>
          <textarea value={text} onChange={e => setText(e.target.value)} autoFocus rows={5}
            placeholder={'לדוגמה:\n3 ק"ג עגבניות\nחלב 3% שני ליטר\nסבון כלים\n6 ביצים'}
            className="w-full border border-[#C7B78E] bg-white rounded-xl p-3 text-right resize-none outline-none text-sm" />
          {error && <p className="text-[#B8462F] text-sm text-center mt-2">{error}</p>}
        </React.Fragment>
      )}
    </Modal>
  );
}

// ── ITEM WIZARD (add + edit) ─────────────────────────────────────────────────
// Item details first, price matching as its own explicit step — replaces
// the old tabbed ItemDialog entirely, for both adding and editing.
//
// The price step's own behavior is driven by data, not a mode flag: once
// draft.barcodes has ANY vendor in it (a fresh pick mid-add, or an item
// being edited that was already matched), it switches from "search openly"
// to "manage" — a settled summary of what's matched, a scoped search per
// still-missing vendor only (so a gap-fill can never overwrite a working
// match), and one explicit "🔄 החלפה" action that clears everything and
// starts over. See the "Edit Item Flow" proposal for the reasoning.
function PriceMatchStep({ draft, setDraft, activeProfiles, showToast, priceMap, setPriceMap, promoMap, setPromoMap }) {
  const [searchQuery, setSearchQuery] = useState(draft.name || "");
  const [candidates, setCandidates] = useState(null);
  const [isResolving, setIsResolving] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const searchTakingLong = useDelayedFlag(isResolving, 4000);

  const matchedVendorIds = Object.keys(draft.barcodes || {});
  const hasAnyMatch = matchedVendorIds.length > 0;
  const missingProfiles = (activeProfiles || []).filter(p => matchedVendorIds.indexOf(p.vendor) === -1);
  const matchedProductName = hasAnyMatch ? draft.matchedNames[matchedVendorIds[0]] : null;

  const runSearch = (vendorId, queryOverride) => {
    const q = (queryOverride || searchQuery || draft.name || "").trim();
    if (!q) return;
    setIsResolving(true);
    const payload = { items: [q], force: true };
    if (vendorId) payload.vendors = [vendorId];
    fns.httpsCallable("resolveItemBarcodes", { timeout: 180000 })(payload).then(res => {
      setIsResolving(false);
      setHasSearched(true);
      const r = (res.data.results || {})[q];
      setCandidates({ vendors: (r && r.missingVendors) || (vendorId ? [vendorId] : []), list: (r && r.candidates) || [] });
    }, () => { setIsResolving(false); showToast("שגיאה בחיפוש"); });
  };

  useEffect(() => {
    if (!hasAnyMatch) runSearch(null, draft.name);
    // eslint-disable-next-line
  }, []);

  const pickCandidate = (c) => {
    const searchedVendors = (candidates && candidates.vendors) || Object.keys(c.prices || {});
    const vendorsToConfirm = searchedVendors.filter(v => c.prices && c.prices[v] != null);
    if (vendorsToConfirm.length === 0) return;
    setDraft(prev => {
      const nb = Object.assign({}, prev.barcodes), nn = Object.assign({}, prev.matchedNames);
      vendorsToConfirm.forEach(v => { nb[v] = c.barcode; nn[v] = c.name; });
      return Object.assign({}, prev, { barcodes: nb, matchedNames: nn });
    });
    setPriceMap(prev => {
      const next = Object.assign({}, prev);
      (activeProfiles || []).forEach(p => {
        if (vendorsToConfirm.indexOf(p.vendor) === -1) return;
        next[p.id] = Object.assign({}, next[p.id]);
        next[p.id][c.barcode] = c.prices[p.vendor];
      });
      return next;
    });
    setPromoMap(prev => {
      const next = Object.assign({}, prev);
      (activeProfiles || []).forEach(p => {
        if (vendorsToConfirm.indexOf(p.vendor) === -1) return;
        const promoInfo = c.promoPrices && c.promoPrices[p.vendor];
        if (!promoInfo) return;
        next[p.id] = Object.assign({}, next[p.id]);
        next[p.id][c.barcode] = promoInfo;
      });
      return next;
    });
    setCandidates(null);
    fns.httpsCallable("confirmItemBarcode")({ name: draft.name, barcode: c.barcode, matchedName: c.name, vendors: vendorsToConfirm }).catch(() => {});
  };

  function replaceMatch() {
    if (!window.confirm("להסיר את ההתאמה הקיימת בכל הרשתות ולחפש מוצר אחר?")) return;
    setDraft(prev => Object.assign({}, prev, { barcodes: {}, matchedNames: {} }));
    setPriceMap({});
    setPromoMap({});
    setCandidates(null);
    setSearchQuery(draft.name || "");
    runSearch(null, draft.name);
  }

  let cheapest = null;
  itemProfilePrices(draft, activeProfiles, priceMap, promoMap).forEach(e => {
    const eff = (e.promo && e.promo.active) ? e.promo.price : e.price;
    if (eff != null && (cheapest === null || eff < cheapest.price)) cheapest = { profile: e.profile, price: eff };
  });

  return (
    <div>
      {hasAnyMatch && (
        <React.Fragment>
          <div className="bg-[#26361F] rounded-xl px-3 py-2.5 mb-2 text-[#F3ECD9] text-sm">
            ✓ הותאם ב-{matchedVendorIds.length} מתוך {(activeProfiles || []).length} רשתות
            {cheapest && <span> · הכי זול: <b className="text-[#E3A939]">{profileLabel(cheapest.profile, activeProfiles)} {formatPrice(cheapest.price)}</b></span>}
          </div>
          {matchedProductName && (
            <div className="bg-[#EEF5EC] border border-[#B9D9B0] rounded-xl px-3 py-2.5 mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[#2B2418] truncate">{matchedProductName}</div>
                <div className="text-[11px] text-[#5B7A63] mt-0.5">המוצר שהותאם</div>
              </div>
              <button onClick={replaceMatch} className="text-xs text-[#B8462F] font-bold flex-shrink-0">🔄 החלפה</button>
            </div>
          )}
          {missingProfiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {missingProfiles.map(p => (
                <button key={p.id} onClick={() => runSearch(p.vendor)} disabled={isResolving}
                  className="text-xs bg-[#FBEAE5] text-[#B8462F] rounded-full px-2.5 py-1 flex items-center gap-1 disabled:opacity-50">
                  {profileLabel(p, activeProfiles)} <span className="underline font-bold">חפש שוב</span>
                </button>
              ))}
            </div>
          )}
        </React.Fragment>
      )}

      {!hasAnyMatch && (
        <div className="flex gap-2 mb-2">
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") runSearch(null); }}
            className="flex-1 min-w-0 border border-[#C7B78E] bg-white rounded-xl px-3 py-2.5 text-sm outline-none" />
          <button onClick={() => runSearch(null)} disabled={!searchQuery.trim() || isResolving}
            className="px-4 rounded-xl bg-[#2E4A3B] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0">
            {isResolving ? <Spinner /> : "חיפוש"}
          </button>
        </div>
      )}
      {!hasAnyMatch && hasSearched && !isResolving && candidates && (
        <p className="text-xs text-[#A79A7C] mb-2">נמצאו {candidates.list.length} תוצאות עבור "{searchQuery}"</p>
      )}

      {isResolving && (
        <p className="text-xs text-[#A79A7C] text-center py-2">
          {searchTakingLong ? "עדיין מחפש — ברשתות חדשות זה לוקח קצת יותר זמן." : "מחפש..."}
        </p>
      )}

      {candidates && !isResolving && (
        <div className="space-y-2">
          {candidates.list.length === 0 ? (
            <p className="text-center text-[#A79A7C] text-sm py-6">
              {hasAnyMatch ? "לא נמצאה התאמה לרשת החסרה" : `לא נמצאו התאמות ל"${draft.name}"`}
            </p>
          ) : candidates.list.map(c => {
            const searchedVendors = candidates.vendors || [];
            let cheapV = null;
            searchedVendors.forEach(v => {
              const pr = c.prices ? c.prices[v] : null;
              const promo = c.promoPrices ? c.promoPrices[v] : null;
              const eff = (promo && pr != null && promo.price < pr) ? promo.price : pr;
              if (eff != null && (cheapV === null || eff < cheapV)) cheapV = eff;
            });
            return (
              <button key={c.barcode} onClick={() => pickCandidate(c)}
                className="w-full text-right rounded-xl px-3 py-3 bg-white border border-[#E5D8B5] hover:bg-[#FBF4E7]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#2B2418]">{c.name}</div>
                    <div className="text-[11px] text-[#A79A7C] mt-0.5">ברקוד {c.barcode}</div>
                  </div>
                  <span className="w-5 h-5 rounded-full border-2 border-[#DECBA1] flex-shrink-0" />
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {searchedVendors.map(v => {
                    const price = c.prices ? c.prices[v] : null;
                    const promo = c.promoPrices ? c.promoPrices[v] : null;
                    const promoActive = !!(promo && price != null && promo.price < price);
                    const eff = promoActive ? promo.price : price;
                    const isCheap = eff != null && eff === cheapV;
                    return (
                      <span key={v} className={"text-[11px] rounded px-2 py-0.5 " + (price == null ? "bg-[#F7F2E4] text-[#C7B78E]" : isCheap ? "bg-[#DDEEDA] text-[#256A3F] font-bold" : "bg-[#EFE4C6] text-[#5B5749]")}>
                        {vendorLabel(v)}: {price != null ? (promoActive ? "₪" + promo.price.toFixed(2) + "*" : "₪" + price.toFixed(2)) : "לא נמכר כאן"}
                      </span>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {hasAnyMatch && missingProfiles.length === 0 && !candidates && (
        <p className="text-xs text-[#A79A7C] text-center py-2">הותאם בכל הרשתות הפעילות ✓</p>
      )}
    </div>
  );
}

function ItemWizard({ mode, item, categories, activeProfiles, onInsert, onSave, onClose, showToast }) {
  const isEdit = mode === "edit";
  const [step, setStep] = useState(1);
  const blankDraft = () => {
    const other = categories.find(c => c.id === "other") || categories[categories.length - 1];
    return { name: "", category: other.label, categoryEmoji: other.emoji, quantity: 1, unit: "יחידות", note: "", barcodes: {}, matchedNames: {} };
  };
  const [draft, setDraft] = useState(() => {
    if (!isEdit || !item) return blankDraft();
    return Object.assign({}, blankDraft(), item, {
      barcodes: Object.assign({}, item.barcodes || {}),
      matchedNames: Object.assign({}, item.matchedNames || {}),
    });
  });
  const [showNote, setShowNote] = useState(isEdit && !!(item && item.note));
  const [saving, setSaving] = useState(false);
  const [priceMap, setPriceMap] = useState({});
  const [promoMap, setPromoMap] = useState({});
  const pricingEnabled = (activeProfiles || []).length > 0;

  // Editing an already-matched item: seed real prices once on open so the
  // step-1 summary and step-2 "manage" view have something to show without
  // waiting for a search.
  useEffect(() => {
    if (!isEdit || !item || !item.barcodes || Object.keys(item.barcodes).length === 0) return;
    if (!activeProfiles || activeProfiles.length === 0) return;
    const payload = {};
    activeProfiles.forEach(p => {
      const bc = item.barcodes[p.vendor];
      if (bc) { payload[p.vendor] = payload[p.vendor] || []; if (payload[p.vendor].indexOf(bc) === -1) payload[p.vendor].push(bc); }
    });
    if (Object.keys(payload).length === 0) return;
    fns.httpsCallable("getBasketPrices", { timeout: 180000 })({ barcodesByVendor: payload }).then(res => {
      setPriceMap(res.data.prices || {});
      setPromoMap(res.data.promoPrices || {});
    }).catch(() => {});
    // eslint-disable-next-line
  }, []);

  const set = (patch) => setDraft(prev => Object.assign({}, prev, patch));

  const toPayload = (d) => ({
    name: d.name.trim(), category: d.category, categoryEmoji: d.categoryEmoji,
    quantity: parseFloat(d.quantity) || 1, unit: d.unit, note: d.note.trim(),
    barcodes: d.barcodes || {}, matchedNames: d.matchedNames || {},
  });

  function finish() {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    if (isEdit) { onSave(toPayload(draft)); return; }
    onInsert(toPayload(draft), () => { setSaving(false); onClose(); });
  }

  const matchedVendorIds = Object.keys(draft.barcodes || {});
  let cheapest = null;
  itemProfilePrices(draft, activeProfiles, priceMap, promoMap).forEach(e => {
    const eff = (e.promo && e.promo.active) ? e.promo.price : e.price;
    if (eff != null && (cheapest === null || eff < cheapest.price)) cheapest = { profile: e.profile, price: eff };
  });

  return (
    <Modal onClose={onClose} disableClose={!isEdit} footer={
      step === 1 ? (
        isEdit ? (
          <button onClick={finish} disabled={!draft.name.trim() || saving}
            className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
            {saving ? <Spinner /> : "שמירת שינויים"}
          </button>
        ) : (
          <div className="space-y-2">
            {pricingEnabled ? (
              <button onClick={() => setStep(2)} disabled={!draft.name.trim()}
                className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
                המשך להשוואת מחירים ←
              </button>
            ) : (
              <button onClick={finish} disabled={!draft.name.trim() || saving}
                className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
                {saving ? <Spinner /> : "+ הוספה"}
              </button>
            )}
            {pricingEnabled && (
              <button onClick={finish} disabled={!draft.name.trim() || saving} className="w-full text-center text-xs text-[#8A7F66] underline">
                {saving ? "שומר..." : "הוספה בלי השוואת מחירים"}
              </button>
            )}
          </div>
        )
      ) : (
        <button onClick={finish} disabled={!draft.name.trim() || saving}
          className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
          {saving ? <Spinner /> : (isEdit ? "שמירת שינויים" : "סיום והוספה לרשימה")}
        </button>
      )
    }>
      <div className="flex items-center gap-2 mb-4">
        {step === 2 && <button onClick={() => setStep(1)} className="text-[#2E4A3B] text-lg px-1">›</button>}
        <h3 className="flex-1 text-lg text-center" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>
          {step === 1 ? (isEdit ? "עריכת פריט" : "הוספת פריט") : "השוואת מחירים"}
        </h3>
        {!isEdit ? (
          <div className="flex gap-1 flex-shrink-0">
            <span className={"h-1.5 rounded-full transition-all " + (step === 1 ? "w-4 bg-[#2E4A3B]" : "w-1.5 bg-[#DECBA1]")} />
            <span className={"h-1.5 rounded-full transition-all " + (step === 2 ? "w-4 bg-[#2E4A3B]" : "w-1.5 bg-[#DECBA1]")} />
          </div>
        ) : (step === 2 && <span style={{ width: 20 }} />)}
      </div>

      {step === 1 ? (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-[#8A7F66] block mb-1">שם</label>
            <input autoFocus={!isEdit} value={draft.name} onChange={e => set({ name: e.target.value })}
              className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none" />
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
            <select
              value={draft.category}
              onChange={e => { const cat = categories.find(c => c.label === e.target.value); if (cat) set({ category: cat.label, categoryEmoji: cat.emoji }); }}
              className="w-full border border-[#C7B78E] bg-white rounded-xl px-3 py-3 text-right outline-none"
            >
              {categories.slice().sort((a, b) => a.label.localeCompare(b.label, "he")).map(cat => (
                <option key={cat.id} value={cat.label}>{cat.emoji} {cat.label}</option>
              ))}
            </select>
          </div>
          {showNote ? (
            <div>
              <label className="text-xs text-[#8A7F66] block mb-1">הערה</label>
              <input value={draft.note} onChange={e => set({ note: e.target.value })} placeholder="אופציונלי"
                className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none" />
            </div>
          ) : (
            <button onClick={() => setShowNote(true)} className="text-xs text-[#C7B78E]">+ הוספת הערה</button>
          )}

          {isEdit && pricingEnabled && (
            <div className="pt-2">
              {matchedVendorIds.length > 0 ? (
                <div className="bg-[#26361F] rounded-xl px-3 py-2.5 mb-2 text-[#F3ECD9] text-sm">
                  ✓ הותאם ב-{matchedVendorIds.length} מתוך {(activeProfiles || []).length} רשתות
                  {cheapest && <span> · הכי זול: <b className="text-[#E3A939]">{profileLabel(cheapest.profile, activeProfiles)} {formatPrice(cheapest.price)}</b></span>}
                </div>
              ) : (
                <p className="text-xs text-[#8A7F66] mb-2">לא הותאם מחיר עדיין</p>
              )}
              <button onClick={() => setStep(2)} className="text-xs font-bold text-[#2E4A3B]">→ ניהול השוואת מחירים</button>
            </div>
          )}
        </div>
      ) : (
        <PriceMatchStep draft={draft} setDraft={setDraft} activeProfiles={activeProfiles} showToast={showToast}
          priceMap={priceMap} setPriceMap={setPriceMap} promoMap={promoMap} setPromoMap={setPromoMap} />
      )}
    </Modal>
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
function Home({ uid, onOpenList, onOpenSettings, onSignOut }) {
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
        <button onClick={onOpenSettings} className="text-[#8A7F66] text-lg w-8 h-8 flex items-center justify-center">⚙️</button>
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

      <div className="text-center py-8 text-[11px] text-[#C7B78E]">
        SuperZola {VERSION} · © {new Date().getFullYear()} כל הזכויות שמורות
      </div>

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

// A branch list can run into the hundreds for a big chain, so this is a
// live-filtered dropdown (opens as soon as you start typing) rather than a
// plain <select> the user has to open separately and scroll through.
function BranchPicker({ branches, branchId, onPick }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const loading = branches === "loading";

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener("click", onClickAway);
    return () => window.removeEventListener("click", onClickAway);
  }, [open]);

  const q = query.trim().toLowerCase();
  const entries = (branches && !loading)
    ? Object.entries(branches)
        .filter(([id, b]) => {
          if (!q) return true;
          const hay = ((b.name || "") + " " + (b.address || "") + " " + (b.city || "") + " " + id).toLowerCase();
          return hay.indexOf(q) !== -1;
        })
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "he"))
        .slice(0, 60)
    : [];
  const selected = (branches && !loading) ? branches[branchId] : null;
  const displayValue = open ? query : (selected ? selected.name + (selected.city ? " · " + selected.city : "") : query);

  return (
    <div className="relative" ref={wrapRef}>
      <div className="relative">
        <input
          value={displayValue}
          onChange={e => { onPick(""); setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="חיפוש סניף לפי שם, כתובת, עיר או מספר..."
          disabled={loading}
          className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none text-sm disabled:bg-[#F7F2E4]"
        />
        {loading && <span className="absolute left-3 top-1/2 -translate-y-1/2"><Spinner /></span>}
      </div>
      {open && !loading && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-[#DECBA1] rounded-xl shadow-lg max-h-56 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="text-xs text-[#8A7F66] text-center py-3">לא נמצאו סניפים</div>
          ) : entries.map(([id, b]) => (
            <button key={id} type="button"
              onClick={() => { onPick(id); setQuery(""); setOpen(false); }}
              className="w-full text-right px-3 py-2 text-sm hover:bg-[#FBF4E7] border-b border-[#F0E9D4] last:border-0">
              <div className="text-[#2B2418]">{b.name}</div>
              <div className="text-[11px] text-[#A79A7C]">{b.address}{b.city ? ", " + b.city : ""} · סניף {parseInt(id, 10)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function SettingsScreen({ uid, onBack }) {
  const [profiles, setProfiles] = useState(null);
  const [branchCache, setBranchCache] = useState({}); // { vendorId: { branchId: {name,address,city} } | "loading" }
  const [addingVendor, setAddingVendor] = useState("");
  const [branchId, setBranchId] = useState("");
  const [ai, setAi] = useState(null);
  const [aiDraft, setAiDraft] = useState({ provider: "", geminiApiKey: "", openaiApiKey: "", anthropicApiKey: "" });
  const [savingAi, setSavingAi] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => db.collection("users").doc(uid).collection("vendorProfiles")
    .onSnapshot(snap => setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })))), [uid]);

  useEffect(() => db.collection("users").doc(uid).onSnapshot(snap => {
    const data = snap.data() || {};
    setAi(data.ai || null);
    if (data.ai) setAiDraft(prev => Object.assign({}, prev, data.ai));
  }), [uid]);

  function loadBranches(vendorId) {
    setBranchCache(prev => Object.assign({}, prev, { [vendorId]: "loading" }));
    fns.httpsCallable("getVendorBranches")({ vendor: vendorId }).then(res => {
      setBranchCache(prev => Object.assign({}, prev, { [vendorId]: res.data.branches || {} }));
    }).catch(() => {
      setBranchCache(prev => Object.assign({}, prev, { [vendorId]: {} }));
      setToast("שגיאה בטעינת סניפים");
    });
  }

  // Fetch branch names/addresses for every vendor already in the user's
  // profile list, purely so those rows can show a real place name instead
  // of a bare branch number.
  useEffect(() => {
    (profiles || []).forEach(p => {
      if (!branchCache[p.vendor]) loadBranches(p.vendor);
    });
    // eslint-disable-next-line
  }, [profiles]);

  function pickVendor(vendorId) {
    setAddingVendor(vendorId);
    setBranchId("");
    if (vendorId && !branchCache[vendorId]) loadBranches(vendorId);
  }

  function addProfile() {
    if (!addingVendor || !branchId) return;
    const already = (profiles || []).some(p => p.vendor === addingVendor && String(p.branchId) === String(branchId));
    if (already) { setToast("הסניף כבר ברשימה שלך"); return; }
    db.collection("users").doc(uid).collection("vendorProfiles").add({
      vendor: addingVendor, branchId, active: true, addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    // Fire-and-forget: starts warming this branch's catalog in the
    // background right away, so the first real price search against it
    // doesn't have to pay for a cold FTP ingest.
    fns.httpsCallable("prewarmVendorCatalog")({ vendor: addingVendor, branchId }).catch(() => {});
    setAddingVendor("");
    setBranchId("");
  }
  function toggleProfile(p) {
    db.collection("users").doc(uid).collection("vendorProfiles").doc(p.id).update({ active: !p.active });
  }
  function removeProfile(p) {
    db.collection("users").doc(uid).collection("vendorProfiles").doc(p.id).delete();
  }

  function saveAi() {
    setSavingAi(true);
    db.collection("users").doc(uid).update({ ai: aiDraft }).then(() => { setSavingAi(false); setToast("נשמר"); });
  }

  // ── Categories ──
  const categories = useCategories();
  const [editingCatId, setEditingCatId] = useState(null);
  const [editCatLabel, setEditCatLabel] = useState("");
  const [editCatEmoji, setEditCatEmoji] = useState("");
  const [newCatLabel, setNewCatLabel] = useState("");
  const [newCatEmoji, setNewCatEmoji] = useState("📦");
  const [confirmDeleteCat, setConfirmDeleteCat] = useState(null);

  function addCategory() {
    if (!newCatLabel.trim()) return;
    const id = "cat_" + Date.now();
    db.collection("categories").doc(id).set({
      label: newCatLabel.trim(), emoji: newCatEmoji.trim() || "📦", order: categories.length,
    }).then(() => setToast("קטגוריה נוספה"));
    setNewCatLabel("");
    setNewCatEmoji("📦");
  }
  function saveEditCategory(cat) {
    if (!editCatLabel.trim()) return;
    db.collection("categories").doc(cat.id).update({ label: editCatLabel.trim(), emoji: editCatEmoji.trim() || "📦" });
    setEditingCatId(null);
  }
  function deleteCategory(cat) {
    db.collection("categories").doc(cat.id).delete().then(() => setToast("קטגוריה נמחקה"));
  }
  function moveCategory(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= categories.length) return;
    const batch = db.batch();
    batch.update(db.collection("categories").doc(categories[idx].id), { order: j });
    batch.update(db.collection("categories").doc(categories[j].id), { order: idx });
    batch.commit();
  }

  // ── Store category-order profiles (aisle layout per chain) ──
  const [storeOrders, setStoreOrders] = useState(null);
  const [addingStoreVendor, setAddingStoreVendor] = useState("");
  const [editStoreOrder, setEditStoreOrder] = useState(null); // { vendor, order } | null

  useEffect(() => db.collection("vendorCategoryOrder")
    .onSnapshot(snap => setStoreOrders(snap.docs.map(d => ({ vendor: d.id, ...d.data() })))), []);

  function addStoreOrder() {
    if (!addingStoreVendor) return;
    if ((storeOrders || []).some(s => s.vendor === addingStoreVendor)) { setToast("כבר קיים סידור לרשת הזו"); return; }
    const order = categories.map(c => c.label);
    db.collection("vendorCategoryOrder").doc(addingStoreVendor).set({ categoryOrder: order })
      .then(() => setToast("סידור נוסף"));
    setAddingStoreVendor("");
  }
  function removeStoreOrder(vendor) {
    db.collection("vendorCategoryOrder").doc(vendor).delete();
  }
  function moveStoreOrderCat(idx, dir) {
    if (!editStoreOrder) return;
    const order = editStoreOrder.order.slice();
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    const tmp = order[idx]; order[idx] = order[j]; order[j] = tmp;
    setEditStoreOrder(Object.assign({}, editStoreOrder, { order }));
    db.collection("vendorCategoryOrder").doc(editStoreOrder.vendor).update({ categoryOrder: order });
  }

  function branchLabel(vendorId, id) {
    const b = branchCache[vendorId];
    const info = b && b !== "loading" ? b[id] : null;
    if (!info) return "סניף " + parseInt(id, 10);
    return info.name + (info.address ? " — " + info.address : "");
  }

  const addingBranches = addingVendor ? branchCache[addingVendor] : null;
  const activeCount = (profiles || []).filter(p => p.active).length;

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <button onClick={onBack} className="text-[#F3ECD9] text-xl px-1">›</button>
        <h1 className="text-xl" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>הגדרות</h1>
      </div>

      <div className="p-4 space-y-6">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>רשתות להשוואת מחירים</h2>
            {profiles && profiles.length > 0 && (
              <span className="text-xs text-[#8A7F66]">פעילים להשוואה: {activeCount} מתוך {profiles.length}</span>
            )}
          </div>
          <p className="text-xs text-[#8A7F66] mb-3">הוסיפו את הסניפים שאתם קונים בהם — מחירים אמיתיים יופיעו על הפריטים ברשימות.</p>

          <div className="flex flex-col gap-2 mb-3">
            {profiles === null && <div className="text-[#8A7F66] text-sm">טוען...</div>}
            {profiles && profiles.length === 0 && <div className="text-[#8A7F66] text-sm">לא נוספו סניפים עדיין</div>}
            {profiles && profiles.map(p => (
              <div key={p.id} className={"rounded-xl px-3 py-2.5 flex items-center gap-2 border " +
                (p.active ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-white border-[#E0D4B4]")}>
                <span className="flex-1 text-sm text-[#2B2418] text-right min-w-0">
                  <span className="font-semibold">{vendorLabel(p.vendor)}</span>
                  <span className="text-[#8A7F66]"> — {branchLabel(p.vendor, p.branchId)}</span>
                </span>
                <button onClick={() => toggleProfile(p)}
                  className={"text-xs border rounded-full px-2.5 py-1 flex-shrink-0 " +
                    (p.active ? "text-[#2E7D4F] border-[#B9D9B0] bg-white" : "text-[#A79A7C] border-[#DECBA1] bg-white")}>
                  {p.active ? "פעיל" : "כבוי"}
                </button>
                <button onClick={() => removeProfile(p)} className="text-[#C7B78E] text-sm px-1 flex-shrink-0">✕</button>
              </div>
            ))}
          </div>

          <div className="bg-white border border-[#E0D4B4] rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-[#8A7F66]">הוספת סניף להשוואה</div>
            <select value={addingVendor} onChange={e => pickVendor(e.target.value)}
              className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none">
              <option value="">בחירת רשת...</option>
              {VENDOR_LIST.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {addingVendor && (
              <BranchPicker branches={addingBranches} branchId={branchId} onPick={setBranchId} />
            )}
            <button onClick={addProfile} disabled={!addingVendor || !branchId}
              className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40">
              + הוספת סניף
            </button>
          </div>
        </div>

        <div>
          <h2 className="text-lg mb-2" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הגדרות AI (להוספה מרובה)</h2>
          <div className="bg-white border border-[#E0D4B4] rounded-xl p-3 space-y-2">
            <select value={aiDraft.provider || ""} onChange={e => setAiDraft(Object.assign({}, aiDraft, { provider: e.target.value }))}
              className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none">
              <option value="">ללא</option>
              <option value="gemini">Gemini (Google)</option>
              <option value="openai">ChatGPT (OpenAI)</option>
              <option value="anthropic">Claude (Anthropic)</option>
            </select>
            {aiDraft.provider === "gemini" && (
              <input value={aiDraft.geminiApiKey || ""} onChange={e => setAiDraft(Object.assign({}, aiDraft, { geminiApiKey: e.target.value }))}
                placeholder="Gemini API key" type="password" dir="ltr"
                className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none" />
            )}
            {aiDraft.provider === "openai" && (
              <input value={aiDraft.openaiApiKey || ""} onChange={e => setAiDraft(Object.assign({}, aiDraft, { openaiApiKey: e.target.value }))}
                placeholder="OpenAI API key" type="password" dir="ltr"
                className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none" />
            )}
            {aiDraft.provider === "anthropic" && (
              <input value={aiDraft.anthropicApiKey || ""} onChange={e => setAiDraft(Object.assign({}, aiDraft, { anthropicApiKey: e.target.value }))}
                placeholder="Anthropic API key" type="password" dir="ltr"
                className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none" />
            )}
            <button onClick={saveAi} disabled={savingAi}
              className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40">
              {savingAi ? "שומר..." : "שמירה"}
            </button>
            <p className="text-[11px] text-[#A79A7C]">המפתח נשמר בחשבון שלך בלבד ומשמש להוספה מהירה של פריטים מטקסט חופשי.</p>
          </div>
        </div>

        <div>
          <h2 className="text-lg mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>קטגוריות</h2>
          <p className="text-xs text-[#8A7F66] mb-3">סדר ברירת המחדל של הקטגוריות ברשימה</p>
          <div className="flex flex-col gap-2 mb-3">
            {categories.map((cat, idx) => (
              <div key={cat.id} className="bg-white border border-[#E0D4B4] rounded-xl px-3 py-2.5">
                {editingCatId === cat.id ? (
                  <div className="flex gap-2 items-center">
                    <input value={editCatEmoji} onChange={e => setEditCatEmoji(e.target.value)} maxLength={2}
                      className="w-12 border border-[#C7B78E] rounded-lg text-center text-xl py-1.5 outline-none" />
                    <input value={editCatLabel} onChange={e => setEditCatLabel(e.target.value)} autoFocus
                      onKeyDown={e => e.key === "Enter" && saveEditCategory(cat)}
                      className="flex-1 border border-[#C7B78E] rounded-lg px-3 py-1.5 text-right text-sm outline-none" />
                    <button onClick={() => saveEditCategory(cat)} className="text-[#2E7D4F] text-xl font-bold w-8 text-center">✓</button>
                    <button onClick={() => setEditingCatId(null)} className="text-[#A79A7C] text-xl w-8 text-center">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex gap-0.5">
                      <button onClick={() => moveCategory(idx, -1)} disabled={idx === 0}
                        className="w-7 h-7 flex items-center justify-center text-[#A79A7C] disabled:opacity-20 text-sm">↑</button>
                      <button onClick={() => moveCategory(idx, 1)} disabled={idx === categories.length - 1}
                        className="w-7 h-7 flex items-center justify-center text-[#A79A7C] disabled:opacity-20 text-sm">↓</button>
                    </div>
                    <span className="text-xl">{cat.emoji}</span>
                    <span className="flex-1 font-medium text-[#2B2418] text-sm text-right">{cat.label}</span>
                    <button onClick={() => { setEditingCatId(cat.id); setEditCatLabel(cat.label); setEditCatEmoji(cat.emoji); }}
                      className="w-7 h-7 flex items-center justify-center text-[#A79A7C] text-sm">✏️</button>
                    <button onClick={() => setConfirmDeleteCat(cat)}
                      className="w-7 h-7 flex items-center justify-center text-[#C7B78E] text-base">🗑️</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="bg-white border border-[#E0D4B4] rounded-xl p-3">
            <div className="text-xs font-semibold text-[#8A7F66] mb-2">קטגוריה חדשה</div>
            <div className="flex gap-2">
              <input value={newCatEmoji} onChange={e => setNewCatEmoji(e.target.value)} maxLength={2}
                className="w-12 border border-[#C7B78E] rounded-lg text-center text-xl py-2 outline-none" />
              <input value={newCatLabel} onChange={e => setNewCatLabel(e.target.value)}
                placeholder="שם הקטגוריה..." onKeyDown={e => e.key === "Enter" && addCategory()}
                className="flex-1 border border-[#C7B78E] rounded-lg px-3 py-2 text-right text-sm outline-none" />
            </div>
            <button onClick={addCategory} disabled={!newCatLabel.trim()}
              className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40 mt-2">
              + הוספת קטגוריה
            </button>
          </div>
        </div>

        <div>
          <h2 className="text-lg mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>סידור בחנות 🏪</h2>
          <p className="text-xs text-[#8A7F66] mb-3">סדר קטגוריות מותאם לכל רשת, לפי סדר המדפים בסניף</p>
          <div className="flex flex-col gap-2 mb-3">
            {storeOrders === null && <div className="text-[#8A7F66] text-sm">טוען...</div>}
            {storeOrders && storeOrders.length === 0 && <div className="text-[#8A7F66] text-sm">אין עדיין סידורים</div>}
            {storeOrders && storeOrders.map(s => (
              <div key={s.vendor} className="bg-white border border-[#E0D4B4] rounded-xl px-3 py-2.5 flex items-center gap-2">
                <button onClick={() => setEditStoreOrder({ vendor: s.vendor, order: s.categoryOrder || categories.map(c => c.label) })}
                  className="w-7 h-7 flex items-center justify-center text-[#A79A7C] text-sm">✏️</button>
                <span className="flex-1 font-medium text-[#2B2418] text-sm text-right">{vendorLabel(s.vendor)}</span>
                <button onClick={() => removeStoreOrder(s.vendor)} className="w-7 h-7 flex items-center justify-center text-[#C7B78E] text-base">🗑️</button>
              </div>
            ))}
          </div>
          <div className="bg-white border border-[#E0D4B4] rounded-xl p-3 space-y-2">
            <select value={addingStoreVendor} onChange={e => setAddingStoreVendor(e.target.value)}
              className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none">
              <option value="">בחירת רשת...</option>
              {VENDOR_LIST.filter(v => !(storeOrders || []).some(s => s.vendor === v.id)).map(v => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
            <button onClick={addStoreOrder} disabled={!addingStoreVendor}
              className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40">
              + הוספת סידור
            </button>
          </div>
        </div>
      </div>

      {editStoreOrder && (
        <Modal onClose={() => setEditStoreOrder(null)}>
          <h3 className="text-lg text-center mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>{vendorLabel(editStoreOrder.vendor)}</h3>
          <p className="text-xs text-[#8A7F66] text-center mb-4">לחצו על החצים לשינוי הסדר</p>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {editStoreOrder.order.map((label, idx) => {
              const cat = categories.find(c => c.label === label);
              return (
                <div key={label} className="flex items-center gap-2 bg-[#F3ECD9]/60 rounded-xl px-3 py-2">
                  <div className="flex gap-0.5">
                    <button onClick={() => moveStoreOrderCat(idx, -1)} disabled={idx === 0}
                      className="w-7 h-7 flex items-center justify-center text-[#A79A7C] disabled:opacity-20 text-sm">↑</button>
                    <button onClick={() => moveStoreOrderCat(idx, 1)} disabled={idx === editStoreOrder.order.length - 1}
                      className="w-7 h-7 flex items-center justify-center text-[#A79A7C] disabled:opacity-20 text-sm">↓</button>
                  </div>
                  <span className="text-lg">{cat ? cat.emoji : "📦"}</span>
                  <span className="flex-1 text-sm font-medium text-[#2B2418] text-right">{label}</span>
                  <span className="text-xs text-[#DECBA1]">{idx + 1}</span>
                </div>
              );
            })}
          </div>
          <button onClick={() => setEditStoreOrder(null)} className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-3 rounded-2xl font-semibold mt-4">סיום</button>
        </Modal>
      )}
      {confirmDeleteCat && (
        <ConfirmDialog message={`למחוק את הקטגוריה "${confirmDeleteCat.label}"?`}
          onConfirm={() => deleteCategory(confirmDeleteCat)} onClose={() => setConfirmDeleteCat(null)} />
      )}

      {toast && <Toast msg={toast} />}
    </div>
  );
}

// ── LIST SCREEN ───────────────────────────────────────────────────────────────
function ListScreen({ uid, listId, listName, onBack }) {
  const [list, setList] = useState({ name: listName, done: false });
  const [items, setItems] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDeleteList, setConfirmDeleteList] = useState(false);
  const [priceMap, setPriceMap] = useState({});
  const [promoMap, setPromoMap] = useState({});
  const [hasAi, setHasAi] = useState(false);
  const [toast, setToast] = useState(null);
  const [viewMode, setViewMode] = useState("list");

  const activeProfiles = useActiveVendorProfiles(uid);
  const categories = useCategories();

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => db.collection("lists").doc(listId).onSnapshot(snap => {
    if (snap.exists) setList({ id: snap.id, ...snap.data() });
  }), [listId]);

  useEffect(() => {
    return db.collection("lists").doc(listId).collection("items").orderBy("addedAt")
      .onSnapshot(snap => setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [listId]);

  useEffect(() => db.collection("users").doc(uid).onSnapshot(snap => {
    const data = snap.data() || {};
    setHasAi(!!(data.ai && data.ai.provider));
  }), [uid]);

  const barcodesByVendor = {};
  (items || []).forEach(it => {
    Object.entries(it.barcodes || {}).forEach(([v, bc]) => {
      if (!barcodesByVendor[v]) barcodesByVendor[v] = new Set();
      barcodesByVendor[v].add(bc);
    });
  });
  const barcodeKey = Object.keys(barcodesByVendor).sort()
    .map(v => v + ":" + Array.from(barcodesByVendor[v]).sort().join(","))
    .join("|");

  function fetchPrices(force) {
    if (!barcodeKey || activeProfiles.length === 0) { setPriceMap({}); setPromoMap({}); return; }
    const payload = {};
    Object.keys(barcodesByVendor).forEach(v => { payload[v] = Array.from(barcodesByVendor[v]); });
    fns.httpsCallable("getBasketPrices", { timeout: 180000 })({ barcodesByVendor: payload, force: !!force }).then(res => {
      setPriceMap(res.data.prices || {});
      setPromoMap(res.data.promoPrices || {});
      if (force) setToast("המחירים עודכנו");
    }).catch(() => { if (force) setToast("שגיאה בעדכון מחירים"); });
  }

  useEffect(() => { fetchPrices(false); }, [barcodeKey, activeProfiles.length]);

  function insertItem(payload, done) {
    db.collection("lists").doc(listId).collection("items").add(Object.assign({}, payload, {
      done: false,
      addedBy: uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    })).then(() => done());
  }

  function insertMany(rawItems) {
    const valid = rawItems.filter(r => (r.name || r.item || "").trim());
    if (valid.length === 0) return;
    const batch = db.batch();
    const now = Date.now();
    valid.forEach((raw, i) => {
      const name = (raw.name || raw.item || "").trim();
      const cat = categories.find(c => c.label === raw.category) || categories[categories.length - 1];
      const ref = db.collection("lists").doc(listId).collection("items").doc();
      batch.set(ref, {
        name,
        category: cat.label,
        categoryEmoji: cat.emoji,
        quantity: parseFloat(raw.quantity) || 1,
        unit: raw.unit || "יחידות",
        note: raw.note || "",
        done: false,
        addedBy: uid,
        addedAt: firebase.firestore.Timestamp.fromMillis(now + i),
      });
    });
    batch.commit().then(() => setToast(valid.length + " פריטים נוספו"));
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

  const doneCount = (items || []).filter(it => it.done).length;
  const groups = groupByCategory(items || [], categories);

  return (
    <div className="min-h-dvh bg-[#FBF4E7] flex flex-col">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <button onClick={onBack} className="text-[#F3ECD9] text-xl px-1">›</button>
        <h1 className="text-xl flex-1 min-w-0 truncate" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>{list.name}</h1>
        <span className="text-[12px] text-[#C9BE9E] flex-shrink-0">{items ? `${doneCount} מתוך ${items.length}` : ""}</span>
        {activeProfiles.length > 0 && (
          <button onClick={() => setViewMode(viewMode === "list" ? "table" : "list")}
            className="text-[#F3ECD9] text-base w-8 h-8 flex items-center justify-center bg-white/10 rounded-full flex-shrink-0"
            title={viewMode === "list" ? "תצוגת טבלה" : "תצוגת רשימה"}>
            {viewMode === "list" ? "📊" : "📋"}
          </button>
        )}
        <button onClick={() => setShowMenu(true)} className="text-[#F3ECD9] text-lg w-8 h-8 flex items-center justify-center bg-white/10 rounded-full flex-shrink-0">☰</button>
      </div>

      <div className="flex-1 px-3 pt-3 pb-28">
        {items === null && <div className="text-[#8A7F66] text-sm py-6 text-center">טוען...</div>}
        {items !== null && items.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">הרשימה ריקה</div>
        )}
        {items !== null && items.length > 0 && viewMode === "table" ? (
          <PriceComparisonTable items={items} activeProfiles={activeProfiles} priceMap={priceMap} promoMap={promoMap} onEditItem={setEditItem} />
        ) : (
          groups.map(group => (
            <div key={group.label} className="mb-5">
              <div className="text-xs font-semibold text-[#8A9A72] mb-1.5 flex items-center gap-1.5 uppercase tracking-wide px-1">
                <span>{group.emoji}</span><span>{group.label}</span>
              </div>
              <div>
                {group.items.map(item => (
                  <ItemRow key={item.id} item={item} activeProfiles={activeProfiles} priceMap={priceMap} promoMap={promoMap}
                    onToggle={toggleItem} onDelete={deleteItem} onEdit={setEditItem}
                    onUpdateNote={note => updateNote(item, note)} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 flex items-center gap-2">
        {hasAi && (
          <button onClick={() => setShowBulkAdd(true)}
            className="bg-white border border-[#DECBA1] text-[#5B5749] px-4 py-3 rounded-2xl shadow-md font-medium text-sm">
            ✍️ הוספה מרובה
          </button>
        )}
        <button
          onClick={() => setShowAdd(true)}
          className="bg-[#2E4A3B] text-[#FBF4E7] px-5 py-3 rounded-2xl shadow-xl font-semibold text-sm flex items-center gap-1.5"
        >
          <span className="text-base font-light">+</span> הוספת פריט
        </button>
      </div>

      {showAdd && (
        <ItemWizard mode="add" categories={categories} activeProfiles={activeProfiles} onInsert={insertItem} onClose={() => setShowAdd(false)} showToast={setToast} />
      )}
      {editItem && (
        <ItemWizard mode="edit" item={editItem} categories={categories} activeProfiles={activeProfiles} onSave={saveEdit} onClose={() => setEditItem(null)} showToast={setToast} />
      )}
      {showBulkAdd && (
        <BulkAddModal categories={categories} hasAi={hasAi} onInsertMany={insertMany} onClose={() => setShowBulkAdd(false)} />
      )}

      {showMenu && (
        <Modal onClose={() => setShowMenu(false)}>
          <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>פעולות</h3>
          <div className="space-y-1">
            <button onClick={() => { setShowMenu(false); setRenaming(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">✏️</span><span className="text-sm font-medium text-[#2B2418]">שינוי שם</span>
            </button>
            {activeProfiles.length > 0 && (
              <button onClick={() => { setShowMenu(false); fetchPrices(true); }}
                className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
                <span className="text-lg">🔄</span><span className="text-sm font-medium text-[#2B2418]">רענון מחירים</span>
              </button>
            )}
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
      {toast && <Toast msg={toast} />}
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

  if (screen.view === "settings") {
    return <SettingsScreen uid={user.uid} onBack={() => setScreen({ view: "home" })} />;
  }

  return (
    <Home
      uid={user.uid}
      onOpenList={(id, name) => setScreen({ view: "list", id, name })}
      onOpenSettings={() => setScreen({ view: "settings" })}
      onSignOut={signOut}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
