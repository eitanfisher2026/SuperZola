const { useState, useEffect, useRef } = React;

const VERSION = "v0.6.0";

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
function itemHasAnyBarcode(item) {
  return !!(item.barcodes && Object.keys(item.barcodes).length > 0);
}
function itemHasMixedVendorMatches(item, relevantVendorIds) {
  const barcodes = item.barcodes || {};
  const vendorIds = relevantVendorIds || Object.keys(barcodes);
  const uniq = {};
  let count = 0;
  vendorIds.forEach(v => {
    const raw = barcodes[v];
    if (!raw) return;
    const bc = String(raw).trim();
    if (!bc || uniq[bc]) return;
    uniq[bc] = true;
    count++;
  });
  return count > 1;
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

// ── VENDOR MATCH PANEL (search + confirm a product across active vendors) ────
function VendorMatchPanel({ draft, setDraft, activeProfiles, showToast,
  searchScope, setSearchScope, searchQuery, setSearchQuery,
  candidates, setCandidates, isResolving, setIsResolving,
  priceMap, setPriceMap, promoMap, setPromoMap }) {
  const [confirmingBarcode, setConfirmingBarcode] = useState(null);

  const selectScope = (vendorId) => {
    setSearchScope(vendorId);
    if (!searchQuery.trim()) setSearchQuery((vendorId && draft.matchedNames[vendorId]) || draft.name || "");
  };

  const runSearchWith = (vendorId, query) => {
    const q = (query || "").trim();
    if (!q) return;
    setIsResolving(true);
    const payload = { items: [q], force: true };
    if (vendorId) payload.vendors = [vendorId];
    fns.httpsCallable("resolveItemBarcodes")(payload).then(res => {
      setIsResolving(false);
      const r = (res.data.results || {})[q];
      setCandidates({ vendors: (r && r.missingVendors) || (vendorId ? [vendorId] : []), list: (r && r.candidates) || [] });
    }, () => { setIsResolving(false); showToast("שגיאה בחיפוש"); });
  };
  const runSearch = () => runSearchWith(searchScope, searchQuery);
  const findPriceForVendor = (vendorId) => {
    const q = (draft.name || "").trim();
    setSearchScope(vendorId);
    setSearchQuery(q);
    runSearchWith(vendorId, q);
  };

  const pickCandidate = (c) => {
    const searchedVendors = (candidates && candidates.vendors) || Object.keys(c.prices || {});
    const vendorsToConfirm = searchedVendors.filter(v => c.prices && c.prices[v] != null);
    if (vendorsToConfirm.length === 0) return;
    setConfirmingBarcode(c.barcode);
    setIsResolving(true);
    fns.httpsCallable("confirmItemBarcode")({ name: draft.name, barcode: c.barcode, matchedName: c.name, vendors: vendorsToConfirm }).then(() => {
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
      setConfirmingBarcode(null);
      setIsResolving(false);
    }, () => { showToast("שגיאה באישור התאמה"); setConfirmingBarcode(null); setIsResolving(false); });
  };

  const rows = (activeProfiles || []).map(p => {
    const bc = draft.barcodes[p.vendor] || null;
    const vendorPrices = priceMap[p.id];
    const fetched = !!(bc && vendorPrices && (bc in vendorPrices));
    const price = fetched ? vendorPrices[bc] : null;
    const promo = (bc && promoMap[p.id]) ? promoMap[p.id][bc] : null;
    const promoActive = !!(promo && (parseFloat(draft.quantity) || 1) >= (promo.minQty || 1));
    return { p, bc, fetched, price, promo, promoActive, effective: promoActive ? promo.price : price };
  });

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input value={searchQuery} placeholder="שם המוצר לחיפוש" autoFocus
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") runSearch(); }}
          className="flex-1 min-w-0 border border-[#C7B78E] bg-white rounded-xl px-3 py-2.5 text-sm outline-none" />
        <button onClick={runSearch} disabled={!searchQuery.trim() || isResolving}
          className="px-4 rounded-xl bg-[#2E4A3B] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0">
          {isResolving ? <Spinner /> : "חיפוש"}
        </button>
      </div>
      <button onClick={() => selectScope(null)}
        className={"text-xs px-3 py-1.5 rounded-full border font-medium " + (searchScope === null ? "bg-[#2E4A3B] text-white border-[#2E4A3B]" : "bg-white text-[#5B5749] border-[#DECBA1]")}>
        כל הרשתות
      </button>

      {candidates && (
        <div className="border-2 border-[#E3A939]/40 bg-[#FDF6E5] rounded-2xl p-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-semibold text-[#8A7F66]">תוצאות חיפוש</div>
            <button onClick={() => setCandidates(null)} className="text-[#A79A7C] text-lg leading-none w-6 h-6 flex items-center justify-center flex-shrink-0">✕</button>
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {candidates.list.length === 0 ? (
              <p className="text-center text-[#A79A7C] text-xs py-4">לא נמצאו התאמות</p>
            ) : candidates.list.map(c => {
              const searchedVendors = candidates.vendors || [];
              const isConfirming = confirmingBarcode === c.barcode;
              return (
                <button key={c.barcode} onClick={() => pickCandidate(c)} disabled={!!confirmingBarcode}
                  className="w-full text-right rounded-xl px-3 py-2.5 bg-white hover:bg-[#FBF4E7] border border-[#E5D8B5] disabled:opacity-50 relative">
                  {isConfirming && (
                    <div className="absolute inset-0 bg-white/70 rounded-xl flex items-center justify-center"><Spinner /></div>
                  )}
                  <div className="text-sm font-medium text-[#2B2418]">{c.name}</div>
                  <div className="text-xs text-[#A79A7C] mb-1">
                    {c.manufacturer ? "יצרן/מותג: " + c.manufacturer + " · " : ""}ברקוד: {c.barcode}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {searchedVendors.map(v => {
                      const price = c.prices ? c.prices[v] : null;
                      const promo = c.promoPrices ? c.promoPrices[v] : null;
                      const promoActive = !!(promo && price != null && promo.price < price);
                      return (
                        <span key={v} className="text-xs bg-white border border-[#E5D8B5] rounded-full px-2 py-0.5">
                          {vendorLabel(v)}: {promoActive ? "₪" + promo.price.toFixed(2) + "*" : (price != null ? "₪" + Number(price).toFixed(2) : "לא נמכר כאן")}
                        </span>
                      );
                    })}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {rows.map(row => {
          const others = rows.filter(r => r.p.id !== row.p.id).map(r => r.effective);
          const textClass = (!row.bc || !row.fetched || row.price == null) ? "text-[#A79A7C]" : cheapestTextClass(row.effective, others);
          const needsAction = !row.bc || (row.fetched && row.price == null);
          let statusText;
          if (needsAction) statusText = null;
          else if (!row.fetched) statusText = "בודק מחיר...";
          else if (row.promoActive) statusText = "₪" + row.promo.price.toFixed(2) + "* (₪" + row.price.toFixed(2) + ")";
          else statusText = "₪" + row.price.toFixed(2);
          const matchedName = draft.matchedNames[row.p.vendor];
          return (
            <button key={row.p.id} onClick={() => {
              if (needsAction) { findPriceForVendor(row.p.vendor); return; }
              selectScope(searchScope === row.p.vendor ? null : row.p.vendor);
            }}
              className={"w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 hover:bg-[#F0E9D4] text-right " + (searchScope === row.p.vendor ? "bg-[#FDF6E5] ring-1 ring-[#E3A939]/50" : "bg-[#F3ECD9]/60")}>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-[#5B5749]">{profileLabel(row.p, activeProfiles)}</div>
                {(matchedName || row.bc) && (
                  <div className="text-[10px] text-[#A79A7C] truncate flex items-center gap-1">
                    {matchedName && <span>{matchedName}</span>}
                    {row.bc && <span dir="ltr">{row.bc}</span>}
                  </div>
                )}
              </div>
              {needsAction || searchScope === row.p.vendor ? (
                <span className="text-xs flex-shrink-0 font-semibold text-[#2E4A3B] bg-[#E3A939]/25 px-2.5 py-1 rounded-full">🔍 מצא מחיר</span>
              ) : (
                <span className={"text-xs flex-shrink-0 font-semibold " + textClass}>{statusText}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── ITEM DIALOG (add / edit) ─────────────────────────────────────────────────
function ItemDialog({ mode, item, activeProfiles, onInsert, onSave, onClose, showToast }) {
  const isEdit = mode === "edit";
  const blankDraft = () => {
    const other = CATEGORIES.find(c => c.id === "other") || CATEGORIES[CATEGORIES.length - 1];
    return { name: "", category: other.label, categoryEmoji: other.emoji, quantity: 1, unit: "יחידות", note: "", price: "", barcodes: {}, matchedNames: {} };
  };
  const [draft, setDraft] = useState(() => {
    if (!isEdit || !item) return blankDraft();
    return Object.assign({}, blankDraft(), item, {
      price: typeof item.price === "number" ? String(item.price) : "",
      barcodes: Object.assign({}, item.barcodes || {}),
      matchedNames: Object.assign({}, item.matchedNames || {}),
    });
  });
  const [saving, setSaving] = useState(false);
  const [savingQuit, setSavingQuit] = useState(false);
  const pricingEnabled = (activeProfiles || []).length > 0;
  const [tab, setTab] = useState("details");
  const [searchScope, setSearchScope] = useState(null);
  const [searchQuery, setSearchQuery] = useState(isEdit && item ? (item.name || "") : "");
  const [candidates, setCandidates] = useState(null);
  const [isResolving, setIsResolving] = useState(false);
  const [priceMap, setPriceMap] = useState({});
  const [promoMap, setPromoMap] = useState({});

  useEffect(() => {
    if (!isEdit || !item || !item.barcodes || Object.keys(item.barcodes).length === 0) return;
    if (!activeProfiles || activeProfiles.length === 0) return;
    const payload = {};
    activeProfiles.forEach(p => {
      const bc = item.barcodes[p.vendor];
      if (bc) { payload[p.vendor] = payload[p.vendor] || []; if (payload[p.vendor].indexOf(bc) === -1) payload[p.vendor].push(bc); }
    });
    if (Object.keys(payload).length === 0) return;
    fns.httpsCallable("getBasketPrices")({ barcodesByVendor: payload }).then(res => {
      setPriceMap(res.data.prices || {});
      setPromoMap(res.data.promoPrices || {});
    }).catch(() => {});
    // eslint-disable-next-line
  }, []);

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
      barcodes: d.barcodes || {},
      matchedNames: d.matchedNames || {},
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
      setTab("details");
      setSearchScope(null);
      setSearchQuery("");
      setCandidates(null);
      setPriceMap({});
      setPromoMap({});
    });
  };

  const showVendorsTab = pricingEnabled && tab === "vendors";
  const mixedMatch = pricingEnabled && itemHasMixedVendorMatches(draft, activeProfiles.map(p => p.vendor));

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

      {pricingEnabled && (
        <div className="flex bg-[#F0E9D4] rounded-xl p-1 mb-4">
          {[["details", "פרטי פריט"], ["vendors", isEdit ? "רשתות" : "בדיקת מחירים"]].map(([key, label]) => (
            <button key={key} onClick={() => {
              if (key === "vendors" && !searchQuery.trim() && draft.name.trim()) setSearchQuery(draft.name);
              setTab(key);
            }}
              className={"flex-1 py-2 rounded-lg text-sm font-medium transition " + (tab === key ? "bg-white shadow text-[#2E4A3B]" : "text-[#8A7F66]")}>
              {label}
            </button>
          ))}
        </div>
      )}

      <div style={{ minHeight: 320 }}>
        {!showVendorsTab && (
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
        )}

        {showVendorsTab && (
          <div className="space-y-2">
            <VendorMatchPanel draft={draft} setDraft={setDraft} activeProfiles={activeProfiles} showToast={showToast || (() => {})}
              searchScope={searchScope} setSearchScope={setSearchScope} searchQuery={searchQuery} setSearchQuery={setSearchQuery}
              candidates={candidates} setCandidates={setCandidates} isResolving={isResolving} setIsResolving={setIsResolving}
              priceMap={priceMap} setPriceMap={setPriceMap} promoMap={promoMap} setPromoMap={setPromoMap} />
            {mixedMatch && (
              <div className="text-[11px] text-[#8A5A15] bg-[#FDF6E5] border border-[#E3A939]/40 rounded-xl px-3 py-2">
                ⚠️ הרשתות מותאמות לברקודים שונים — ייתכן שאלו מוצרים שונים
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
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

// ── BULK ADD (AI) ─────────────────────────────────────────────────────────────
function BulkAddModal({ hasAi, onInsertMany, onClose }) {
  const [text, setText] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");

  function process() {
    const t = text.trim();
    if (!t) return;
    setProcessing(true);
    setError("");
    fns.httpsCallable("parseItems")({ text: t, categories: CATEGORIES.map(c => ({ label: c.label })) }).then(res => {
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

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function SettingsScreen({ uid, onBack }) {
  const [profiles, setProfiles] = useState(null);
  const [addingVendor, setAddingVendor] = useState("");
  const [branches, setBranches] = useState(null);
  const [branchId, setBranchId] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);
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

  function pickVendor(vendorId) {
    setAddingVendor(vendorId);
    setBranchId("");
    setBranches(null);
    if (!vendorId) return;
    setLoadingBranches(true);
    fns.httpsCallable("getVendorBranches")({ vendor: vendorId }).then(res => {
      setLoadingBranches(false);
      setBranches(res.data.branches || {});
    }).catch(() => { setLoadingBranches(false); setBranches({}); setToast("שגיאה בטעינת סניפים"); });
  }

  function addProfile() {
    if (!addingVendor || !branchId) return;
    const already = (profiles || []).some(p => p.vendor === addingVendor && String(p.branchId) === String(branchId));
    if (already) { setToast("הסניף כבר ברשימה שלך"); return; }
    db.collection("users").doc(uid).collection("vendorProfiles").add({
      vendor: addingVendor, branchId, active: true, addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setAddingVendor("");
    setBranchId("");
    setBranches(null);
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

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <button onClick={onBack} className="text-[#F3ECD9] text-xl px-1">›</button>
        <h1 className="text-xl" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>הגדרות</h1>
      </div>

      <div className="p-4 space-y-6">
        <div>
          <h2 className="text-lg mb-2" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>רשתות להשוואת מחירים</h2>
          <p className="text-xs text-[#8A7F66] mb-3">הוסיפו את הסניפים שאתם קונים בהם — מחירים אמיתיים יופיעו על הפריטים ברשימות.</p>

          <div className="flex flex-col gap-2 mb-3">
            {profiles === null && <div className="text-[#8A7F66] text-sm">טוען...</div>}
            {profiles && profiles.length === 0 && <div className="text-[#8A7F66] text-sm">לא נוספו סניפים עדיין</div>}
            {profiles && profiles.map(p => (
              <div key={p.id} className="bg-white border border-[#E0D4B4] rounded-xl px-3 py-2.5 flex items-center gap-2">
                <button onClick={() => toggleProfile(p)}
                  className={"w-9 h-5 rounded-full relative flex-shrink-0 " + (p.active ? "bg-[#2E4A3B]" : "bg-[#E0D4B4]")}>
                  <span className={"absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all " + (p.active ? "right-0.5" : "right-4")} />
                </button>
                <span className="flex-1 text-sm text-[#2B2418]">{vendorLabel(p.vendor)} · סניף {p.branchId}</span>
                <button onClick={() => removeProfile(p)} className="text-[#C7B78E] text-sm px-1">✕</button>
              </div>
            ))}
          </div>

          <div className="bg-white border border-[#E0D4B4] rounded-xl p-3 space-y-2">
            <select value={addingVendor} onChange={e => pickVendor(e.target.value)}
              className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none">
              <option value="">בחירת רשת...</option>
              {VENDOR_LIST.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {addingVendor && (
              loadingBranches ? (
                <div className="text-xs text-[#8A7F66] py-1">טוען סניפים...</div>
              ) : branches && Object.keys(branches).length > 0 ? (
                <select value={branchId} onChange={e => setBranchId(e.target.value)}
                  className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none">
                  <option value="">בחירת סניף...</option>
                  {Object.entries(branches).map(([id, b]) => (
                    <option key={id} value={id}>{b.name}{b.city ? " · " + b.city : ""}</option>
                  ))}
                </select>
              ) : branches ? (
                <div className="text-xs text-[#8A7F66] py-1">לא נמצאו סניפים</div>
              ) : null
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
      </div>

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

  const activeProfiles = useActiveVendorProfiles(uid);

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
    fns.httpsCallable("getBasketPrices")({ barcodesByVendor: payload, force: !!force }).then(res => {
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
      const cat = CATEGORIES.find(c => c.label === raw.category) || CATEGORIES[CATEGORIES.length - 1];
      const ref = db.collection("lists").doc(listId).collection("items").doc();
      batch.set(ref, {
        name,
        category: cat.label,
        categoryEmoji: cat.emoji,
        quantity: parseFloat(raw.quantity) || 1,
        unit: raw.unit || "יחידות",
        note: raw.note || "",
        price: null,
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

      <div className="flex-1 px-3 pt-3 pb-28">
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
                <ItemRow key={item.id} item={item} activeProfiles={activeProfiles} priceMap={priceMap} promoMap={promoMap}
                  onToggle={toggleItem} onDelete={deleteItem} onEdit={setEditItem}
                  onUpdateNote={note => updateNote(item, note)} />
              ))}
            </div>
          </div>
        ))}
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

      <div className="bg-[#26361F] px-4 pt-3 pb-6 flex items-center justify-between">
        <span className="text-[#F3ECD9] text-[15px]">סה"כ</span>
        <span className="text-[#F3ECD9] text-xl font-bold tabular-nums">{formatPrice(total)}</span>
      </div>

      {showAdd && (
        <ItemDialog mode="add" activeProfiles={activeProfiles} onInsert={insertItem} onClose={() => setShowAdd(false)} showToast={setToast} />
      )}
      {editItem && (
        <ItemDialog mode="edit" item={editItem} activeProfiles={activeProfiles} onSave={saveEdit} onClose={() => setEditItem(null)} showToast={setToast} />
      )}
      {showBulkAdd && (
        <BulkAddModal hasAi={hasAi} onInsertMany={insertMany} onClose={() => setShowBulkAdd(false)} />
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
