const { useState, useEffect, useRef } = React;

const VERSION = "v1.84";

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
// App Check — attaches a verification token to every Firestore/Functions
// request so a script hitting the API directly (not through this real page)
// can be told apart from genuine app traffic. Currently in monitor-only
// mode (nothing is rejected yet) while real usage is confirmed clean before
// any enforcement is turned on.
try {
  firebase.appCheck().activate(
    new firebase.appCheck.ReCaptchaEnterpriseProvider('6LcsnKYtAAAAAGaGX3PZJg8lPc2vKWrw675onAjz'),
    true
  );
} catch (e) { /* never block app boot over App Check failing to init */ }
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
// Lets an admin preview the app as a regular user sees it, without actually
// changing their role in Firestore (so it's purely a client-side UI
// simulation — Firestore rules still enforce the real role server-side
// regardless of this flag). Per-device via localStorage, not per-account,
// since it's just a personal testing toggle.
function isViewingAsUser() {
  try { return localStorage.getItem("sz_viewAsUser") === "1"; } catch (e) { return false; }
}
function setViewingAsUser(v) {
  try { if (v) localStorage.setItem("sz_viewAsUser", "1"); else localStorage.removeItem("sz_viewAsUser"); } catch (e) {}
}
function effectiveRole(realRole) {
  return isViewingAsUser() ? "user" : realRole;
}
function formatRelativeUpdatedAt(ms, neverText) {
  if (!ms) return neverText || "מעולם לא רוענן";
  const diffDays = Math.floor((Date.now() - ms) / 86400000);
  if (diffDays <= 0) return "היום";
  if (diffDays === 1) return "אתמול";
  if (diffDays < 7) return `לפני ${diffDays} ימים`;
  return new Date(ms).toLocaleDateString("he-IL");
}
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(m) {
  return m < 1000 ? Math.round(m) + " מ׳" : (m / 1000).toFixed(1) + ' ק"מ';
}
// Shared with NearbyBranchPicker's own address search — free, no API key,
// no billing risk. Returns null (never throws) so callers can just show a
// "not found" message either way.
function geocodeAddress(query) {
  const q = (query || "").trim();
  if (!q) return Promise.resolve(null);
  return fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=il&q=" + encodeURIComponent(q))
    .then(r => r.json())
    .then(results => (results && results.length > 0) ? { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) } : null)
    .catch(() => null);
}
// Seeded into Firestore (categories collection) the first time it's empty —
// from then on this is only the emergency fallback if that read ever fails.
const DEFAULT_CATEGORIES = [
  { id: "dairyEggs",   label: "מוצרי חלב וביצים",                                                      emoji: "🥛", order: 0 },
  { id: "meatFish",    label: "בשר, עוף ודגים (כולל קפואים)",                                          emoji: "🥩", order: 1 },
  { id: "produce",     label: "פירות וירקות (טריים)",                                                   emoji: "🥦", order: 2 },
  { id: "bakery",      label: "מוצרי מאפה ולחם",                                                        emoji: "🍞", order: 3 },
  { id: "dryGoods",    label: "מזון יבש ושימורים (קטניות, אורז, פסטה, שימורים, תבלינים, שמנים, קמח וחומרי אפייה)", emoji: "🥫", order: 4 },
  { id: "snacks",      label: "חטיפים וממתקים (כולל אגוזים ופירות יבשים)",                              emoji: "🍫", order: 5 },
  { id: "frozen",      label: "קפואים (ירקות, בצק ומאכלים מוכנים קפואים)",                              emoji: "🧊", order: 6 },
  { id: "beverages",   label: "משקאות (קלים, מים, קפה ותה, אלכוהול)",                                   emoji: "🥤", order: 7 },
  { id: "cleaning",    label: "חומרי ניקוי ותחזוקת בית",                                                emoji: "🧹", order: 8 },
  { id: "personalCare",label: "טיפוח אישי והיגיינה (כולל מוצרי תינוקות)",                               emoji: "🧼", order: 9 },
  { id: "paper",       label: "מוצרי נייר וחד־פעמי",                                                    emoji: "🧻", order: 10 },
  { id: "other",       label: "שונות (ציוד/אוכל לחיות מחמד, סוללות ומוצרי בית)",                         emoji: "🛍️", order: 11 },
];
const UNITS = ["יחידות", "ק\"ג", "גרם", "ליטר", "מ\"ל", "קופסה", "חבילה", "צרור"];

// One shared AI provider for the whole app, configured once by an admin
// (AdminOptionsScreen) — every user gets AI features (bulk add, auto-category)
// through it, nobody brings their own key.
const AI_PROVIDERS = {
  anthropic: { name: "Claude", label: "Anthropic", defaultModel: "claude-haiku-4-5-20251001", keyHint: "sk-ant-...", free: false },
  openai:    { name: "ChatGPT", label: "OpenAI",   defaultModel: "gpt-4o-mini",               keyHint: "sk-...",     free: false },
  gemini:    { name: "Gemini",  label: "Google",   defaultModel: "gemini-flash-lite-latest",   keyHint: "AIza...",    free: true  },
};
const AI_KEY_LINKS = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
};
// Shown before the admin presses "refresh list" to pull the real, current
// catalog from the provider — kept short since it goes stale over time.
const FALLBACK_MODELS = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — מהיר וזול" },
    { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6 — חזק יותר" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o Mini — מהיר וזול" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
  ],
  gemini: [
    { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite (latest) — הכי זול" },
    { id: "gemini-flash-latest",      label: "Gemini Flash (latest)" },
  ],
};
function aiModelLabel(m, cheapestId) {
  const price = m.price ? ` — $${m.price.in}/$${m.price.out} למיליון` : "";
  const cheap = m.id === cheapestId ? " · 💰 הכי זול" : "";
  return (m.label || m.id) + price + cheap;
}
// Always include the currently-selected model, even if it fell out of the
// live/fallback list, so the <select> never silently blanks it.
function aiModelOptions(models, currentId) {
  if (currentId && !models.some(m => m.id === currentId)) return [{ id: currentId, label: currentId }].concat(models);
  return models;
}

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

// Vendors with a known online-delivery branch, admin-managed (Settings).
// { [vendorId]: { branchId, label, deliveryFee, minimumOrder, active } }
function useOnlineVendors() {
  const [onlineVendors, setOnlineVendors] = useState({});
  useEffect(() => {
    return db.collection("onlineVendors").onSnapshot(snap => {
      const map = {};
      snap.docs.forEach(d => { map[d.id] = d.data(); });
      setOnlineVendors(map);
    });
  }, []);
  return onlineVendors;
}
// Creates the "premade list" of online vendor profiles — every configured
// onlineVendors entry within delivery radius of the user's home address
// that doesn't already have a profile. Called from both the Settings
// online-vendors section and from opening an online list directly, so
// whichever the user reaches first is enough to populate it; only ever
// adds a missing profile, never removes one, so a vendor the user turned
// off stays off. Also warms each new branch's catalog, same as adding a
// physical branch by hand.
// There's no reliable per-vendor coverage-area data to filter on (no real
// depot coordinates, and asking an admin to hand-maintain a covered-cities
// list per vendor isn't realistic to keep accurate) — so every active
// onlineVendors entry gets provisioned for every user, and the actual
// "does this vendor deliver to me" question is left to the user, with a
// disclaimer shown alongside the list (Settings) pointing at that.
function provisionOnlineVendorProfiles(uid, onlineVendors, existingProfiles, showToast) {
  if (existingProfiles === null) return;
  const existingVendors = new Set(existingProfiles.filter(p => p.mode === "online").map(p => p.vendor));
  Object.entries(onlineVendors).forEach(([vendor, cfg]) => {
    if (existingVendors.has(vendor) || cfg.active === false) return;
    db.collection("users").doc(uid).collection("vendorProfiles").add({
      vendor, branchId: cfg.branchId, active: true, mode: "online",
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    // The very first time anyone activates a given online branch, its
    // catalog isn't cached yet and this real fetch can take up to ~100s —
    // after that it's already warm for everyone else. Without this, prices
    // for the new vendor would just silently not show up during that wait.
    if (showToast) showToast(`מוסיפים את ${vendorLabel(vendor)} — טוען קטלוג, זה עשוי לקחת עד דקה...`);
    fns.httpsCallable("prewarmVendorCatalog")({ vendor, branchId: cfg.branchId }).then(() => {
      if (showToast) showToast(`הקטלוג של ${vendorLabel(vendor)} מוכן`);
    }).catch(() => {});
  });
}

function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
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
  Object.values(map).forEach(g => g.items.sort((a, b) => itemDisplayName(a).localeCompare(itemDisplayName(b), "he")));
  return Object.values(map).sort((a, b) => categoryOrder(a.label, categories) - categoryOrder(b.label, categories));
}
// The "שונות" category's full label spells out examples in parentheses
// (useful when picking it from a dropdown) — but repeating that on every
// list's group header is just clutter, and it's also the one category
// whose stored text varies across items added before a category rename,
// so trimming it to the plain word here keeps every such group heading
// looking the same regardless of which exact wording that item has saved.
function categoryHeaderLabel(label) {
  return label.indexOf("שונות") === 0 ? "שונות" : label;
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
// Hand-off point into a vendor's own site for the "מעבר להזמנה" flow. No
// vendor exposes an add-to-cart-via-URL or address-prefill mechanism
// (confirmed by hand against the real sites) — a plain link can't build a
// cart, so this only opens the vendor's own search/home page once; the
// user copies each item name in from SuperZola and pastes it in there.
// Login, cart, address and payment all stay on the vendor's own site and
// never touch SuperZola. A single shared page per vendor (rather than a
// per-item deep link) also sidesteps opening-many-tabs reliability issues
// on mobile, especially inside an installed PWA.
const VENDOR_ORDER_URL = {
  shufersal: "https://www.shufersal.co.il/online/he/search",
  ramiLevy: "https://www.rami-levy.co.il/he/online/search",
  carrefour: "https://www.carrefour.co.il/",
};
// Clipboard API needs a secure context, which a plain string copy from an
// older in-app browser or WebView sometimes lacks — this falls back to the
// classic hidden-textarea + execCommand trick so "העתקה" still works there.
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      resolve();
    } catch (e) { reject(e); }
  });
}
function itemVendorBarcode(item, vendorId) {
  return (item.barcodes && item.barcodes[vendorId]) || null;
}
function itemVendorMatchedName(item, vendorId) {
  return (item.matchedNames && item.matchedNames[vendorId]) || null;
}
// True when two currently-relevant vendors are matched to genuinely
// different barcodes — i.e. the price comparison is silently comparing two
// different physical products (different pack size, brand, etc.) under one
// shared name, not the same product at different vendors. Only counts
// vendors in relevantVendorIds so a stale barcode from a vendor no longer
// active can't trigger a false warning.
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
// The name to show for an item: if every vendor that's been matched agrees
// on the product name, show that (more specific than whatever was typed).
// The moment they disagree, showing any one vendor's name would misrepresent
// the others, so fall back to the originally typed name instead.
function itemDisplayName(item) {
  const names = item.matchedNames || {};
  const uniq = {};
  const list = [];
  Object.keys(names).forEach(v => {
    const n = names[v];
    if (!n || uniq[n]) return;
    uniq[n] = true;
    list.push(n);
  });
  if (list.length === 1) return list[0];
  return item.name;
}
function profileLabel(profile, allProfiles) {
  let label = vendorLabel(profile.vendor);
  // A list's own profiles are always one mode or the other, never mixed —
  // so tagging "(אונליין)" on every vendor in an all-online list is just
  // noise repeated on every row. Only worth the tag when the profiles
  // passed in actually mix both modes (kept correct rather than just
  // dropped, in case that ever happens).
  const mixedModes = (allProfiles || []).some(p => (p.mode === "online") !== (profile.mode === "online"));
  if (profile.mode === "online") return mixedModes ? label + " (אונליין)" : label;
  const sameChainCount = allProfiles.filter(p => p.vendor === profile.vendor && p.mode !== "online").length;
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
// Whether "mine" counts as the cheapest of the row. A shared minimum among
// SOME vendors still wins (every vendor at that minimum is "the cheapest"),
// it's only suppressed when literally every vendor in the row — mine
// included — carries the exact same price, since there's nothing to call
// out as a deal at that point.
function isCheapestPrice(mine, others) {
  if (mine == null) return false;
  const known = others.filter(o => o != null);
  if (known.length === 0) return true;
  const min = Math.min(mine, ...known);
  const allSame = known.every(o => o === mine);
  return mine === min && !allSame;
}
function cheapestTextClass(mine, others) {
  if (mine == null) return "text-[#A79A7C]";
  return isCheapestPrice(mine, others) ? "text-[#2E7D4F]" : "text-[#5B5749]";
}
// Background+text pair for a price chip/badge (as opposed to a table cell,
// which only needs cheapestTextClass).
function cheapestBadgeClass(mine, others) {
  if (mine == null) return "bg-[#F7F2E4] text-[#C7B78E]";
  return isCheapestPrice(mine, others) ? "bg-[#DDEEDA] text-[#256A3F] font-bold" : "bg-[#EFE4C6] text-[#5B5749]";
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
// Same query as useActiveVendorProfiles, but also reports whether the
// first snapshot has actually arrived — an empty array is the initial
// state too, so anything that treats "zero" as meaningful (e.g. a
// first-time-setup banner) needs to know not to trust it before the real
// data has had a chance to load, or it flashes for every existing user.
function useActiveVendorProfilesState(uid) {
  const [state, setState] = useState({ profiles: [], loaded: false });
  useEffect(() => {
    if (!uid) return;
    return db.collection("users").doc(uid).collection("vendorProfiles")
      .where("active", "==", true)
      .onSnapshot(snap => setState({ profiles: snap.docs.map(d => ({ id: d.id, ...d.data() })), loaded: true }));
  }, [uid]);
  return state;
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
// Same spirit as Spinner, but for light backgrounds (Spinner's white ring
// disappears on cream/mustard surfaces).
function Spinner2() {
  return <span className="inline-block w-3.5 h-3.5 border-2 border-[#8A7F66]/30 border-t-[#8A7F66] rounded-full animate-spin" />;
}

// Drawn explicitly rather than using a "‹"/"›" text glyph — those get
// silently flipped by the browser's own bidi mirroring inside an RTL page,
// which is exactly backwards for a "back" affordance in a Hebrew reading
// direction (back should point right, not left). An SVG path is never
// auto-mirrored, so this always renders pointing right regardless of dir.
function BackButton({ onClick }) {
  return (
    <button onClick={onClick} className="text-[#F3ECD9] w-9 h-9 -mr-1 flex items-center justify-center rounded-full bg-white/10 flex-shrink-0">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

function Toast({ msg }) {
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-[#2B2418] text-[#FBF4E7] text-sm px-5 py-2.5 rounded-2xl shadow-lg z-50 max-w-[85vw] text-center">
      {msg}
    </div>
  );
}

// Bottom sheet used for every dialog in the app — drag the handle down (or
// tap the scrim) to dismiss, matching the native "sheet" feel instead of a
// centered popup box.
function Modal({ onClose, children, disableClose, footer, closeLabel }) {
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
        <div className={"relative flex-shrink-0 px-6 pt-4" + (closeLabel ? " pb-2" : "")}>
          <div
            ref={handleRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className={"w-10 h-1.5 bg-[#DECBA1] rounded-full mx-auto mb-3 " + (disableClose ? "" : "cursor-grab active:cursor-grabbing touch-none")}
          />
          {/* Shown even when disableClose suppresses swipe/backdrop-dismiss
              (the add-item wizard) — those are only disabled to prevent
              *accidental* loss while filling a form, not to remove the
              ability to close it at all. */}
          {closeLabel ? (
            <button onClick={onClose} className="absolute top-2 left-4 flex items-center gap-1 bg-[#2E4A3B] text-[#FBF4E7] text-xs font-bold px-3 py-2 rounded-full hover:bg-[#243D30]">
              <span className="text-base leading-none">×</span> {closeLabel}
            </button>
          ) : (
            <button onClick={onClose} className="absolute top-3 left-4 text-[#8A7F66] hover:text-[#2B2418] text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
          )}
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
      <h1 className="text-3xl" style={{ fontFamily: "'Suez One', serif", color: "#2E4A3B" }}>סופר זולה</h1>
      <button
        className="bg-[#2E4A3B] text-[#FBF4E7] px-7 py-3.5 rounded-2xl font-bold text-[15px] shadow-sm"
        onClick={signIn}
      >
        התחברות עם Google
      </button>
      <a href="/privacy.html" className="text-xs text-[#A79A7C] underline">מדיניות פרטיות</a>
    </div>
  );
}

// ── PRICE COMPARISON TABLE ────────────────────────────────────────────────────
// One row per item, one column per active vendor branch — lets you compare
// prices at a glance instead of reading them off each item's own chips.
function PriceComparisonTable({ items, activeProfiles, priceMap, promoMap, onEditItem }) {
  const totals = {};
  activeProfiles.forEach(p => { totals[p.id] = { sum: 0, count: 0 }; });
  items.forEach(item => {
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
          {items.map(item => {
            const priced = itemProfilePrices(item, activeProfiles, priceMap, promoMap);
            const byId = {};
            priced.forEach(e => { byId[e.profile.id] = e; });
            const qty = item.quantity || 1;
            return (
              <tr key={item.id} className="cursor-pointer active:bg-[#FBF4E7]" onClick={() => onEditItem(item)}>
                <td className="sticky right-0 bg-white z-10 px-3 py-2 border-b border-[#F0E9D4] text-right text-[#B8462F] underline decoration-[#E7A796] underline-offset-2">
                  {itemHasMixedVendorMatches(item, activeProfiles.map(p => p.vendor)) && (
                    <span className="text-[#E3A939] font-bold no-underline" title="הרשתות מותאמות למוצרים שונים">! </span>
                  )}
                  {itemDisplayName(item)}{qty !== 1 && <span className="text-[#A79A7C] no-underline"> ({qty})</span>}
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
                  const isCheapest = fetched && bc && isCheapestPrice(effectivePrice, others);
                  const cellClass = !bc || !fetched ? "text-[#DECBA1]" : isCheapest ? "text-[#2E7D4F] font-bold" : "text-[#5B5749]";
                  return (
                    <td key={p.id} className={"text-center px-3 py-2 border-b border-[#F0E9D4] " + cellClass}>
                      {!bc ? "—" : !fetched ? "…" : price != null ? (
                        <div className="leading-tight">
                          {promoActive ? (
                            <div>
                              <div>₪{(promo.price * qty).toFixed(2)}*</div>
                              <div className="text-[10px] text-[#A79A7C] font-normal">(₪{(price * qty).toFixed(2)})</div>
                            </div>
                          ) : (
                            <div>
                              <div>₪{(price * qty).toFixed(2)}</div>
                              {promo && <div className="text-[9px] text-[#B8462F]">🏷️ {promoTagPhrase(promo)}</div>}
                            </div>
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
function ItemRow({ item, activeProfiles, priceMap, promoMap, onDelete, onEdit, onUpdateNote }) {
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
        <div className="flex-1 min-w-0" onClick={() => onEdit(item)}>
          <span className="text-[15px] cursor-pointer text-[#B8462F] underline decoration-[#E7A796] underline-offset-2">
            {itemHasMixedVendorMatches(item, (activeProfiles || []).map(p => p.vendor)) && (
              <span className="text-[#E3A939] font-bold no-underline" title="הרשתות מותאמות למוצרים שונים">! </span>
            )}
            {itemDisplayName(item)}
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
                const promoActive = !!(e.promo && e.promo.active);
                const effective = promoActive ? e.promo.price : e.price;
                const others = pricedEntries.filter(o => o.profile.id !== e.profile.id)
                  .map(o => (o.promo && o.promo.active) ? o.promo.price : o.price);
                return (
                  <span key={e.profile.id} className={"text-[11px] font-semibold px-1.5 py-0.5 rounded leading-tight " + cheapestBadgeClass(effective, others)}>
                    <span className="flex flex-col items-start">
                      <span>
                        {profileLabel(e.profile, activeProfiles)}: {promoActive ? "₪" + e.promo.price.toFixed(2) + "*" : (e.price != null ? "₪" + e.price.toFixed(2) : "לא נמכר כאן")}
                      </span>
                      {/* A promo that exists but isn't active yet (quantity
                          hasn't reached minQty) still surfaces as a hint —
                          buying one more may unlock the price shown here. */}
                      {e.promo && !promoActive && (
                        <span className="text-[10px] text-[#B8462F] font-normal">🏷️ {promoTagPhrase(e.promo)}</span>
                      )}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {qty ? (
          <span className="text-xs font-medium text-[#8A7F66] bg-[#EFE4C6] px-2 py-0.5 rounded-full flex-shrink-0">{qty}</span>
        ) : null}
        <button onClick={() => onDelete(item)} className="text-[#B8462F] text-[13px] px-1 flex-shrink-0">✕</button>
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
function PriceMatchStep({ draft, setDraft, activeProfiles, showToast, priceMap, setPriceMap, promoMap, setPromoMap, onQueryChange, categories }) {
  const [searchQuery, setSearchQuery] = useState(draft.name || "");
  const [candidates, setCandidates] = useState(null);
  const [isResolving, setIsResolving] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  // null = search targets every active vendor (gap-fill / initial search).
  // A vendor id = the search box is scoped to just that one vendor, so its
  // word can be edited and re-searched without touching anyone else's
  // match — different chains don't always share a barcode for "the same"
  // product, so one search word doesn't always fit all of them.
  const [searchScope, setSearchScope] = useState(null);
  // Replacing a wrong match is deliberately non-destructive: opening it
  // just reveals an editable search box (nothing auto-runs, nothing is
  // cleared) — the old match only actually gets dropped once a new pick is
  // confirmed, and cancelling leaves everything exactly as it was.
  const [replacing, setReplacing] = useState(false);
  const searchTakingLong = useDelayedFlag(isResolving, 4000);

  const matchedVendorIds = Object.keys(draft.barcodes || {});
  const hasAnyMatch = matchedVendorIds.length > 0;
  const activeVendorIds = (activeProfiles || []).map(p => p.vendor);
  const mixedMatches = itemHasMixedVendorMatches(draft, activeVendorIds);
  const scopeLabel = searchScope ? vendorLabel(searchScope) : null;

  const runSearch = (vendorId, queryOverride) => {
    const q = (queryOverride != null ? queryOverride : searchQuery || draft.name || "").trim();
    if (!q) return;
    setIsResolving(true);
    // Scoped to this exact profile's id, not just the vendor name — a
    // vendor can have more than one active profile (e.g. a physical branch
    // for in-store lists and a separate online branch for online lists),
    // and searching by vendor name alone lets the backend pick whichever
    // one it likes, silently pricing/matching against the wrong branch.
    const scopedProfiles = vendorId ? (activeProfiles || []).filter(p => p.vendor === vendorId) : (activeProfiles || []);
    const payload = { items: [q], force: true, profileIds: scopedProfiles.map(p => p.id) };
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

  function startReplace() {
    setReplacing(true);
    setSearchScope(null);
    setCandidates(null);
    setSearchQuery(draft.name || "");
  }
  function cancelReplace() {
    setReplacing(false);
    setCandidates(null);
  }

  // Tapping a vendor row: an unmatched one searches right away (one tap,
  // using the item's name as a best guess); an already-matched one just
  // narrows the search box to that vendor so its word can be edited before
  // searching — tapping the same vendor again clears the scope back to
  // "all vendors". Either way this cancels any pending whole-item replace,
  // since scoping to one vendor is a narrower, distinct action.
  function selectVendor(vendorId, alreadyMatched) {
    setReplacing(false);
    setCandidates(null);
    if (!alreadyMatched) {
      const q = draft.name || "";
      setSearchScope(vendorId);
      setSearchQuery(q);
      runSearch(vendorId, q);
      return;
    }
    const nextScope = searchScope === vendorId ? null : vendorId;
    setSearchScope(nextScope);
    if (!searchQuery.trim()) {
      setSearchQuery((nextScope && itemVendorMatchedName(draft, nextScope)) || draft.name || "");
    }
  }

  function vendorsCoveredBy(c) {
    const searchedVendors = (candidates && candidates.vendors) || Object.keys(c.prices || {});
    return searchedVendors.filter(v => c.prices && c.prices[v] != null);
  }

  // Applies one candidate's match right away — used both for the common
  // "tap the row, done" single pick (which also closes the results) and
  // for a checkbox tap in a multi-vendor search (which commits into the
  // draft immediately but leaves the results open so another vendor's
  // match can be picked right after). There's no separate "confirm
  // selection" step: every check is already saved into the item.
  const applyCandidate = (c, opts) => {
    const keepOpen = !!(opts && opts.keepOpen);
    const vendorsToConfirm = vendorsCoveredBy(c);
    if (vendorsToConfirm.length === 0) return;
    // Mid-replace, the old match is only actually dropped right here, at
    // the moment a new one is confirmed — never when "🔄 החלפה" was tapped.
    // Consumed on this very first commit (not just on close) so a second
    // checkbox tap right after doesn't wipe the one just picked.
    setDraft(prev => {
      const nb = Object.assign({}, replacing ? {} : (prev.barcodes || {}));
      const nn = Object.assign({}, replacing ? {} : (prev.matchedNames || {}));
      vendorsToConfirm.forEach(v => { nb[v] = c.barcode; nn[v] = c.name; });
      return Object.assign({}, prev, { barcodes: nb, matchedNames: nn });
    });
    setPriceMap(prev => {
      const next = Object.assign({}, replacing ? {} : prev);
      (activeProfiles || []).forEach(p => {
        if (vendorsToConfirm.indexOf(p.vendor) === -1) return;
        next[p.id] = Object.assign({}, next[p.id]);
        next[p.id][c.barcode] = c.prices[p.vendor];
      });
      return next;
    });
    setPromoMap(prev => {
      const next = Object.assign({}, replacing ? {} : prev);
      (activeProfiles || []).forEach(p => {
        if (vendorsToConfirm.indexOf(p.vendor) === -1) return;
        const promoInfo = c.promoPrices && c.promoPrices[p.vendor];
        if (!promoInfo) return;
        next[p.id] = Object.assign({}, next[p.id]);
        next[p.id][c.barcode] = promoInfo;
      });
      return next;
    });
    setReplacing(false);
    if (!keepOpen) { setCandidates(null); setSearchScope(null); }
    // A matched barcode may already carry a known category from the catalog
    // backfill — more reliable than the free-text guess made from the typed
    // name before any barcode existed, so it wins when present.
    fns.httpsCallable("confirmItemBarcode")({ name: draft.name, barcode: c.barcode, matchedName: c.name, vendors: vendorsToConfirm }).then(res => {
      const label = res.data && res.data.category;
      const cat = label && categories && categories.find(cc => cc.label === label);
      if (cat) setDraft(prev => Object.assign({}, prev, { category: cat.label, categoryEmoji: cat.emoji }));
    }).catch(() => {});
  };
  const pickCandidate = (c) => applyCandidate(c, { keepOpen: false });

  // Unchecking only ever removes barcodes this exact candidate put there —
  // it never touches a vendor some other candidate has since claimed.
  function removeCandidate(c) {
    const vendorsToConfirm = vendorsCoveredBy(c);
    setDraft(prev => {
      const nb = Object.assign({}, prev.barcodes || {});
      const nn = Object.assign({}, prev.matchedNames || {});
      vendorsToConfirm.forEach(v => { if (nb[v] === c.barcode) { delete nb[v]; delete nn[v]; } });
      return Object.assign({}, prev, { barcodes: nb, matchedNames: nn });
    });
  }

  function toggleCommit(c, isChecked) {
    if (isChecked) removeCandidate(c);
    else applyCandidate(c, { keepOpen: true });
  }

  const vendorEffectivePrices = {};
  (activeProfiles || []).forEach(p => {
    const bc = draft.barcodes[p.vendor];
    const vendorPrices = priceMap[p.id];
    const fetched = !!(bc && vendorPrices && (bc in vendorPrices));
    const price = fetched ? vendorPrices[bc] : null;
    let promo = (bc && promoMap[p.id]) ? promoMap[p.id][bc] : null;
    if (promo && price != null && promo.price >= price) promo = null;
    const promoActive = !!(promo && (parseFloat(draft.quantity) || 1) >= (promo.minQty || 1));
    vendorEffectivePrices[p.id] = promoActive ? promo.price : price;
  });

  return (
    <div>
      {hasAnyMatch && (
        <div className="bg-[#EEF5EC] border border-[#B9D9B0] rounded-xl px-3 py-2.5 mb-2 flex items-start justify-between gap-2">
          <div className="text-sm font-medium text-[#2B2418] truncate min-w-0">{itemDisplayName(draft)}</div>
          {!replacing && (
            <button onClick={startReplace} className="text-xs text-[#B8462F] font-bold flex-shrink-0 flex items-center gap-1">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>
              החלפה
            </button>
          )}
        </div>
      )}
      {mixedMatches && (
        <div className="text-[11px] text-[#8A5A15] bg-[#FBF0D9] border border-[#E9D8A6] rounded-xl px-3 py-2 mb-3">
          ⚠️ הרשתות מותאמות לברקודים שונים — ייתכן שאלו מוצרים שונים (למשל גודל אריזה שונה), לא בהכרח אותו פריט
        </div>
      )}

      <div className="mb-1.5">
        <div className="flex gap-2">
          <input value={searchQuery} onChange={e => { setSearchQuery(e.target.value); if (onQueryChange) onQueryChange(e.target.value); }}
            onKeyDown={e => { if (e.key === "Enter") runSearch(searchScope); }} autoFocus={replacing || !!searchScope}
            className="flex-1 min-w-0 border border-[#C7B78E] bg-white rounded-xl px-3 py-2.5 text-sm outline-none" />
          <button onClick={() => runSearch(searchScope)} disabled={!searchQuery.trim() || isResolving}
            className="px-4 rounded-xl bg-[#2E4A3B] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0">
            {isResolving ? <Spinner /> : "חיפוש"}
          </button>
        </div>
        {(replacing || searchScope) && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs text-[#8A7F66]">
              {replacing ? "מחפש בכל הרשתות" : `מחפש עבור ${scopeLabel} בלבד`}
            </span>
            <button onClick={replacing ? cancelReplace : () => { setSearchScope(null); setCandidates(null); }}
              className="text-xs text-[#8A7F66] underline">ביטול</button>
          </div>
        )}
      </div>
      {hasSearched && !isResolving && candidates && (
        <React.Fragment>
          <p className="text-xs text-[#A79A7C] mb-1">נמצאו {candidates.list.length} תוצאות עבור "{searchQuery}"</p>
          {candidates.list.length > 0 && (candidates.vendors || []).length > 1 && (
            <p className="text-[11px] text-[#8A7F66] mb-2">סמנו התאמה מכל רשת בנפרד — הכל יתמזג לפריט אחד; רשת שכבר נבחרה תיחסם מבחירות אחרות.</p>
          )}
        </React.Fragment>
      )}

      {isResolving && (
        <div className="py-2">
          <div className="sz-progress-track"><div className="sz-progress-bar" /></div>
          <p className="text-xs text-[#A79A7C] text-center mt-2">
            {searchTakingLong ? "מעדכנים מחירים לרשת — רגע..." : "מחפש..."}
          </p>
        </div>
      )}

      {candidates && !isResolving && (() => {
        const searchedVendors = candidates.vendors || [];
        const allowMultiSelect = searchedVendors.length > 1;
        const qty = parseFloat(draft.quantity) || 1;
        return (
          <div className="space-y-2 mb-3">
            {candidates.list.length === 0 ? (
              <p className="text-center text-[#A79A7C] text-sm py-6">{`לא נמצאו התאמות ל"${searchQuery || draft.name}"`}</p>
            ) : candidates.list.map(c => {
              const vendorsForC = vendorsCoveredBy(c);
              // Checked = this exact candidate is what's currently matched
              // for all the vendors it covers — derived straight from the
              // item's own draft, so there's nothing separate to "confirm";
              // checking a box already saved it.
              const isChecked = vendorsForC.length > 0 && vendorsForC.every(v => draft.barcodes && draft.barcodes[v] === c.barcode);
              const blocked = !isChecked && vendorsForC.some(v => draft.barcodes && draft.barcodes[v] && draft.barcodes[v] !== c.barcode);
              return (
                <div key={c.barcode} onClick={() => !blocked && pickCandidate(c)}
                  className={"w-full text-right rounded-xl px-3 py-3 border cursor-pointer " +
                    (isChecked ? "bg-[#EEF5EC] border-[#B9D9B0]" : blocked ? "bg-[#F7F2E4] border-[#E5D8B5] opacity-45 cursor-default" : "bg-white border-[#E5D8B5] hover:bg-[#FBF4E7]")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#2B2418]">{c.name}</div>
                      <div className="text-[11px] text-[#A79A7C] mt-0.5">
                        ברקוד {c.barcode}{c.unit ? ` · ${c.unit}` : ""}
                      </div>
                    </div>
                    {allowMultiSelect && vendorsForC.length > 0 ? (
                      <button type="button"
                        onClick={e => { e.stopPropagation(); if (!blocked) toggleCommit(c, isChecked); }}
                        disabled={blocked}
                        title={blocked ? "כבר הותאם ברשת אחרת — לחצו על השורה כדי להחליף" : isChecked ? "הסרת ההתאמה" : "בחירה (אפשר לבחור כמה)"}
                        className={"w-5 h-5 rounded-[5px] border-2 flex-shrink-0 flex items-center justify-center text-[11px] font-bold leading-none disabled:cursor-not-allowed " +
                          (isChecked ? "bg-[#2E4A3B] border-[#2E4A3B] text-white" : "border-[#DECBA1] text-transparent")}>
                        ✓
                      </button>
                    ) : (
                      <span className="w-5 h-5 rounded-[5px] border-2 border-[#DECBA1] flex-shrink-0" />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {searchedVendors.map(v => {
                      const price = c.prices ? c.prices[v] : null;
                      let promo = c.promoPrices ? c.promoPrices[v] : null;
                      if (promo && price != null && promo.price >= price) promo = null;
                      const promoActive = !!(promo && qty >= (promo.minQty || 1));
                      const effective = promoActive ? promo.price : price;
                      const others = searchedVendors.filter(o => o !== v).map(o => {
                        const op = c.prices ? c.prices[o] : null;
                        let opromo = c.promoPrices ? c.promoPrices[o] : null;
                        if (opromo && op != null && opromo.price >= op) opromo = null;
                        const oActive = !!(opromo && qty >= (opromo.minQty || 1));
                        return oActive ? opromo.price : op;
                      }).filter(x => x != null);
                      return (
                        <span key={v} className={"text-[11px] rounded px-2 py-0.5 " + cheapestBadgeClass(effective, others)}>
                          <span className="flex flex-col items-start">
                            <span>{vendorLabel(v)}: {promoActive ? "₪" + promo.price.toFixed(2) + "*" : (price != null ? "₪" + price.toFixed(2) : "לא נמכר כאן")}</span>
                            {promo && !promoActive && (
                              <span className="text-[10px] text-[#B8462F] font-normal">🏷️ {promoTagPhrase(promo)}</span>
                            )}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* One row per active vendor, always up to date — matched vendors show
          their own matched product name/barcode plus real price (cheapest
          highlighted); unmatched ones are a one-tap gap-fill search.
          Tapping any row scopes the search box above to that vendor.
          Hidden while search results are open so the two lists don't
          compete for attention. */}
      {hasAnyMatch && !candidates && (
        <div className="space-y-1.5">
          {(activeProfiles || []).map(p => {
            const bc = draft.barcodes[p.vendor];
            const matchedName = itemVendorMatchedName(draft, p.vendor);
            const vendorPrices = priceMap[p.id];
            const fetched = !!(bc && vendorPrices && (bc in vendorPrices));
            const price = fetched ? vendorPrices[bc] : null;
            let promo = (bc && promoMap[p.id]) ? promoMap[p.id][bc] : null;
            if (promo && price != null && promo.price >= price) promo = null;
            const promoActive = !!(promo && (parseFloat(draft.quantity) || 1) >= (promo.minQty || 1));
            const otherEffective = (activeProfiles || []).filter(o => o.id !== p.id).map(o => vendorEffectivePrices[o.id]);
            const isCheapest = isCheapestPrice(vendorEffectivePrices[p.id], otherEffective);
            const isScoped = searchScope === p.vendor;
            if (!bc) {
              return (
                <button key={p.id} onClick={() => selectVendor(p.vendor, false)} disabled={isResolving}
                  className={"w-full flex items-center justify-between rounded-xl px-3 py-2.5 disabled:opacity-50 " + (isScoped ? "bg-[#FBEAE5] ring-1 ring-[#E7A796]" : "bg-[#FBEAE5]")}>
                  <span className="text-sm text-[#B8462F]">{profileLabel(p, activeProfiles)}</span>
                  <span className="text-xs font-bold text-[#B8462F] underline">חפש שוב</span>
                </button>
              );
            }
            return (
              <button key={p.id} onClick={() => selectVendor(p.vendor, true)}
                className={"w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-right " + (isScoped ? "bg-[#F3ECD9] ring-1 ring-[#C7B78E]" : isCheapest ? "bg-[#DDEEDA] border border-[#B9D9B0]" : "bg-[#F3ECD9]/60")}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[#5B5749]">{profileLabel(p, activeProfiles)}</div>
                  {(matchedName || bc) && (
                    <div className="text-[10px] text-[#A79A7C] truncate flex items-center gap-1">
                      {matchedName && <span className="text-[#8A7F66]">{matchedName}</span>}
                      <span dir="ltr">{bc}</span>
                    </div>
                  )}
                </div>
                <span className="flex-shrink-0 flex flex-col items-end">
                  <span className={"text-sm font-bold " + (isCheapest ? "text-[#256A3F]" : "text-[#2E4A3B]")}>
                    {!fetched ? "בודק..." : price == null ? "לא נמכר כאן" : (promoActive ? "₪" + promo.price.toFixed(2) + "*" : "₪" + price.toFixed(2))}
                  </span>
                  {promo && !promoActive && (
                    <span className="text-[10px] text-[#B8462F] font-normal">🏷️ {promoTagPhrase(promo)}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ItemWizard({ uid, mode, item, categories, activeProfiles, onInsert, onSave, onClose, showToast }) {
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

  // New items only — there's no category field shown at all on add, so the
  // category is decided here, quietly, in the background. Editing an
  // existing item still shows the field and lets it be changed by hand,
  // which is also the escape hatch if this ever guesses wrong.
  useEffect(() => {
    if (isEdit) return;
    const name = draft.name.trim();
    if (name.length < 2) return;
    const t = setTimeout(() => {
      fns.httpsCallable("categorizeItemName")({ name, categories: categories.map(c => ({ label: c.label })) }).then(res => {
        const label = res.data && res.data.category;
        const cat = label && categories.find(c => c.label === label);
        if (cat) set({ category: cat.label, categoryEmoji: cat.emoji });
      }).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [draft.name, isEdit]);

  const set = (patch) => setDraft(prev => Object.assign({}, prev, patch));

  const toPayload = (d) => ({
    name: d.name.trim(), category: d.category, categoryEmoji: d.categoryEmoji,
    quantity: parseFloat(d.quantity) || 1, unit: d.unit, note: d.note.trim(),
    barcodes: d.barcodes || {}, matchedNames: d.matchedNames || {},
  });

  function finish() {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    if (isEdit) {
      // Fixing your own item's category is itself the signal that
      // something's off with that product's shared tag — logged
      // automatically here rather than asking anyone to "report" it. Only
      // meaningful for a matched item (there's a real barcode to attach
      // the correction to); an editor reviews these in Settings later.
      if (item && item.category !== draft.category) {
        const barcodes = [...new Set(Object.values(draft.barcodes || {}))];
        barcodes.forEach(barcode => {
          fns.httpsCallable("submitCategoryCorrection")({
            barcode, itemName: draft.name.trim(),
            oldCategory: item.category || null, newCategory: draft.category,
          }).catch(() => {});
        });
      }
      onSave(toPayload(draft));
      return;
    }
    onInsert(toPayload(draft), () => {
      // Stays open instead of closing — matches the category-browse add
      // flow, where adding one item is expected to be followed by adding
      // more, not a trip back to the list after every single item.
      showToast(`${draft.name.trim()} נוסף לרשימה`);
      setDraft(blankDraft());
      setStep(1);
      setShowNote(false);
      setPriceMap({});
      setPromoMap({});
      setSaving(false);
    });
  }

  const matchedVendorIds = Object.keys(draft.barcodes || {});
  let cheapest = null;
  itemProfilePrices(draft, activeProfiles, priceMap, promoMap).forEach(e => {
    const eff = (e.promo && e.promo.active) ? e.promo.price : e.price;
    if (eff != null && (cheapest === null || eff < cheapest.price)) cheapest = { profile: e.profile, price: eff };
  });

  return (
    <Modal onClose={onClose} disableClose={!isEdit} closeLabel={!isEdit ? "סיום וחזרה לרשימה" : undefined} footer={
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
          {isEdit && (
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
          )}
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
          priceMap={priceMap} setPriceMap={setPriceMap} promoMap={promoMap} setPromoMap={setPromoMap} categories={categories} />
      )}
    </Modal>
  );
}

// ── LIST CARD (home row) ─────────────────────────────────────────────────────
// List actions (rename, duplicate, delete) live inside the list itself now
// (its own ☰ menu) — this is just a tappable row, no per-card menu.
function ListCard({ list, onOpen }) {
  return (
    <div
      onClick={onOpen}
      className="bg-white border border-[#E0D4B4] rounded-2xl px-4 py-4 flex items-center gap-2 shadow-sm cursor-pointer"
    >
      {list.mode === "online" && <span className="text-base flex-shrink-0" title="קנייה אונליין">🛒</span>}
      <span className="text-[16px] font-medium text-right flex-1 min-w-0 truncate text-[#2B2418]">
        {list.name}
      </span>
      <span className="text-[#DECBA1] text-lg flex-shrink-0">‹</span>
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function Home({ uid, displayName, email, onOpenList, onOpenVendors, onOpenAdminOptions, onOpenHelp, onSignOut }) {
  const [lists, setLists] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showCheckPrice, setShowCheckPrice] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [toast, setToast] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isInstalled = window.matchMedia("(display-mode: standalone)").matches || !!window.navigator.standalone;
  const [canInstall, setCanInstall] = useState(!isInstalled);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  // Deliberately the REAL admin status, never overridden by the simulation
  // below — otherwise the toggle that turns the simulation off would hide
  // itself the moment it's turned on.
  const [viewAsUser, setViewAsUser] = useState(isViewingAsUser());
  const simulatedIsAdmin = isAdmin && !viewAsUser;
  const categories = useCategories();
  const { profiles: activeProfiles, loaded: profilesLoaded } = useActiveVendorProfilesState(uid);
  // Online vendors are admin-configured and the same for everyone — a user
  // never "sets those up," so an online profile auto-provisioned just from
  // opening an online list shouldn't count as having completed setup. Only
  // a real in-store branch, which the user actually chose to add, does.
  const isNewUser = profilesLoaded && activeProfiles.filter(p => (p.mode || "instore") === "instore").length === 0;

  useEffect(() => db.collection("users").doc(uid).onSnapshot(snap => {
    setIsAdmin((snap.data() || {}).role === "admin");
  }), [uid]);

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => {
    return db.collection("lists").where("ownerId", "==", uid)
      .onSnapshot(snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        setLists(rows);
      });
  }, [uid]);

  useEffect(() => {
    const close = () => setShowUserMenu(false);
    if (showUserMenu) { window.addEventListener("click", close); return () => window.removeEventListener("click", close); }
  }, [showUserMenu]);

  useEffect(() => {
    function onReady() { setCanInstall(true); }
    function onDone() { setCanInstall(false); }
    window.addEventListener("pwa_install_ready", onReady);
    window.addEventListener("pwa_installed", onDone);
    return () => {
      window.removeEventListener("pwa_install_ready", onReady);
      window.removeEventListener("pwa_installed", onDone);
    };
  }, []);

  function installApp() {
    if (window.__installPrompt) {
      window.__installPrompt.prompt();
      window.__installPrompt.userChoice.then(r => {
        if (r.outcome === "accepted") { setCanInstall(false); window.__installPrompt = null; }
      });
    } else {
      setShowInstallGuide(true);
    }
  }

  function shareApp() {
    const url = "https://superzola.web.app";
    if (navigator.share) {
      navigator.share({ title: "סופר זולה", text: "נסו את סופר זולה — השוואת מחירים חכמה לרשימות קניות 🛒", url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => setToast("הקישור הועתק! 🔗"), () => setToast(url));
    }
  }

  // Tapping "+" creates an auto-named list immediately and jumps straight
  // into it — no naming step up front. Renaming later (from the list's own
  // menu) is one tap, and this way starting a list never blocks on typing.
  async function quickCreate(mode) {
    if (creating) return;
    setCreating(true);
    const prefix = mode === "online" ? "רשימת קנייה אונליין #" : "רשימת קניות #";
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
      mode: mode === "online" ? "online" : "instore",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    setCreating(false);
    onOpenList(ref.id, name, mode === "online");
  }

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <AppIcon size={30} />
        <div className="text-[17px]" style={{ fontFamily: "'Suez One', serif", color: "#2E4A3B" }}>סופר זולה</div>
        <div className="flex-1" />
        <div className="relative">
          <button onClick={e => { e.stopPropagation(); setShowUserMenu(v => !v); }}
            className="relative w-8 h-8 rounded-full overflow-hidden border border-[#DECBA1] bg-[#F3ECD9] text-[#5B5749] text-sm font-semibold flex items-center justify-center flex-shrink-0">
            ⚙️
            {isNewUser && (
              <span className="absolute top-0 left-0 w-2 h-2 rounded-full bg-[#E3A939]" />
            )}
          </button>
          {showUserMenu && (
            // Every top-level destination lives in this one menu — most-used
            // first — instead of being split between this and a separate
            // info button, so there's exactly one place to look.
            <div onClick={e => e.stopPropagation()}
              className="absolute left-0 top-10 bg-white rounded-xl shadow-xl border border-[#E5D8B5] z-20 min-w-40 overflow-hidden">
              <button onClick={() => { setShowUserMenu(false); onOpenVendors(); }}
                className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2">
                <span>🏪</span><span>רשתות להשוואת מחירים</span>
              </button>
              <button onClick={() => { setShowUserMenu(false); onOpenHelp(); }}
                className="relative w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                <span>ⓘ</span><span>עזרה</span>
                {isNewUser && <span className="absolute top-2.5 right-3 w-2 h-2 rounded-full bg-[#E3A939]" />}
              </button>
              <button onClick={() => { setShowUserMenu(false); setShowFeedback(true); }}
                className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                <span>💬</span><span>{simulatedIsAdmin ? "ניהול משובים" : "שליחת משוב"}</span>
              </button>
              {canInstall && (
                <button onClick={() => { setShowUserMenu(false); installApp(); }}
                  className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                  <span>📲</span><span>התקנת אפליקציה</span>
                </button>
              )}
              <button onClick={() => { setShowUserMenu(false); shareApp(); }}
                className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                <span>🔗</span><span>שיתוף אפליקציה</span>
              </button>
              <a href="/privacy.html" onClick={() => setShowUserMenu(false)}
                className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                <span>🔒</span><span>מדיניות פרטיות</span>
              </a>
              {simulatedIsAdmin && (
                <button onClick={() => { setShowUserMenu(false); onOpenAdminOptions(); }}
                  className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                  <span>🛠️</span><span>אפשרויות מנהל</span>
                </button>
              )}
              {isAdmin && (
                <button onClick={() => { const next = !viewAsUser; setViewingAsUser(next); setViewAsUser(next); setShowUserMenu(false); }}
                  className="w-full text-right px-4 py-3 text-sm text-[#2B2418] hover:bg-[#FBF4E7] flex items-center gap-2 border-t border-[#E5D8B5]">
                  <span>👁️</span><span>{viewAsUser ? "חזרה לתצוגת מנהל" : "תצוגה כמשתמש רגיל"}</span>
                </button>
              )}
              <button onClick={() => { setShowUserMenu(false); onSignOut(); }}
                className="w-full text-right px-4 py-3 text-sm text-[#B8462F] hover:bg-[#FBEAE5] flex items-center gap-2 border-t border-[#E5D8B5]">
                <span>🚪</span><span>התנתקות</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {viewAsUser && (
        <div className="mx-4 mb-3 bg-[#E3A939]/20 border border-[#E3A939] rounded-xl px-3 py-2 flex items-center justify-between gap-2">
          <span className="text-xs text-[#8A5A15]">👁️ מציג את האפליקציה כמשתמש רגיל</span>
          <button onClick={() => { setViewingAsUser(false); setViewAsUser(false); }}
            className="text-xs font-bold text-[#2E4A3B] underline flex-shrink-0">חזרה למנהל</button>
        </div>
      )}

      <div className="px-4 pb-4">
        <h1 className="text-2xl" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הרשימות שלי</h1>
      </div>

      {isNewUser && (
        <div className="px-4 pb-4">
          <div className="bg-[#EEF5EC] border border-[#B9D9B0] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">👋</span>
              <h2 className="text-[15px] font-bold text-[#2E4A3B]">בואו נתחיל!</h2>
            </div>
            <p className="text-[13px] text-[#3F5A38] leading-snug mb-3">
              כדי שהאפליקציה תשווה מחירים, קודם צריך להוסיף את הסניפים שבהם אתם קונים — זה לוקח דקה, וזה השלב היחיד שחוזר על עצמו.
            </p>
            <div className="flex gap-2">
              <button onClick={onOpenVendors}
                className="flex-1 bg-[#2E4A3B] text-white rounded-xl py-2.5 text-sm font-semibold">
                ➕ הוספת סניפים
              </button>
              <button onClick={onOpenHelp}
                className="flex-1 bg-white border border-[#B9D9B0] text-[#2E4A3B] rounded-xl py-2.5 text-sm font-semibold">
                📖 מדריך שימוש
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 flex flex-col gap-2">
        {lists === null && <div className="text-[#8A7F66] text-sm py-6 text-center">טוען רשימות...</div>}
        {lists !== null && lists.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">אין עדיין רשימות. צרו את הראשונה!</div>
        )}
        {(lists || []).map(list => (
          <ListCard key={list.id} list={list} onOpen={() => onOpenList(list.id, list.name)} />
        ))}
      </div>

      <div className="px-4 mt-4 flex gap-2">
        <button
          onClick={() => quickCreate("instore")}
          disabled={creating}
          className="flex-1 border-2 border-dashed border-[#C7B78E] rounded-2xl py-3 text-[#A0906B] text-[15px] disabled:opacity-50"
        >
          {creating ? "יוצר..." : "+ קניה בסניף"}
        </button>
        <button
          onClick={() => quickCreate("online")}
          disabled={creating}
          className="flex-1 border-2 border-dashed border-[#C7B78E] rounded-2xl py-3 text-[#A0906B] text-[15px] disabled:opacity-50"
        >
          {creating ? "יוצר..." : "+ קנייה אונליין"}
        </button>
      </div>
      <div className="px-4 mt-2">
        <button
          onClick={() => setShowCheckPrice(true)}
          className="w-full border border-[#DECBA1] bg-white rounded-2xl px-4 py-3 text-[#5B5749] text-[15px] font-medium flex items-center justify-center gap-1.5"
        >
          🔍 חיפוש והוספת פריט
        </button>
      </div>

      <div className="text-center py-8 text-[11px] text-[#C7B78E]">
        סופר זולה {VERSION} · © {new Date().getFullYear()} כל הזכויות שמורות
      </div>

      {showCheckPrice && (
        <FindItemModal uid={uid} categories={categories} onClose={() => setShowCheckPrice(false)} showToast={setToast} />
      )}
      {showFeedback && (
        <FeedbackDialog uid={uid} displayName={displayName} email={email} onClose={() => setShowFeedback(false)} />
      )}
      {/* Fallback for browsers that never fired (or don't support) the
          native install prompt — iOS Safari gets exact steps since it has
          no install prompt at all, every other browser gets a generic
          pointer so the option isn't a dead end. */}
      {showInstallGuide && (
        <Modal onClose={() => setShowInstallGuide(false)}>
          <h3 className="text-lg text-center mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הוסיפו למסך הבית 📲</h3>
          <p className="text-xs text-[#8A7F66] text-center mb-4">{isIOS ? "בצעו את הצעדים הבאים בספארי" : "בצעו את הצעדים הבאים בדפדפן"}</p>
          <div className="space-y-2 mb-5">
            {(isIOS
              ? [["לחצו על כפתור השיתוף", "הסמל ↑ בתחתית המסך"], ["גללו ובחרו", '"הוסף למסך הבית"'], ["לחצו \"הוסף\"", "האפליקציה תופיע במסך הבית"]]
              : [["פתחו את תפריט הדפדפן", "שלוש הנקודות ⋮ למעלה, או תפריט ההגדרות"], ["חפשו", '"התקן אפליקציה" או "הוסף למסך הבית"'], ["אשרו את ההתקנה", "האפליקציה תופיע במסך הבית"]]
            ).map((step, i) => (
              <div key={i} className="flex items-center gap-3 bg-[#F7F2E4] rounded-xl px-3 py-2.5">
                <span className="text-lg w-6 text-center flex-shrink-0 font-bold text-[#2E4A3B]">{i + 1}</span>
                <div>
                  <p className="text-sm font-medium text-[#2B2418]">{step[0]}</p>
                  <p className="text-[11px] text-[#A79A7C]">{step[1]}</p>
                </div>
              </div>
            ))}
          </div>
          <button onClick={() => setShowInstallGuide(false)} className="w-full bg-[#2E4A3B] text-white py-3 rounded-2xl font-semibold text-sm">הבנתי</button>
        </Modal>
      )}
      {toast && <Toast msg={toast} />}
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

  // Once the branch list finishes loading, show it right away rather than
  // making the user tap the (now-enabled) input a second time to see it.
  useEffect(() => {
    if (!loading && branches && Object.keys(branches).length > 0) setOpen(true);
    // eslint-disable-next-line
  }, [loading]);

  const q = query.trim().toLowerCase();
  const entries = (branches && !loading)
    ? Object.entries(branches)
        .filter(([id, b]) => {
          if (!q) return true;
          const hay = ((b.name || "") + " " + (b.address || "") + " " + (b.city || "") + " " + id).toLowerCase();
          return hay.indexOf(q) !== -1;
        })
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "he"))
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
      </div>
      {loading && (
        <div className="mt-2"><div className="sz-progress-track"><div className="sz-progress-bar" /></div></div>
      )}
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

// Finds branches of the already-selected vendor within a radius of either
// the browser's geolocation or a geocoded address — a separate mode from
// BranchPicker's text search, not a replacement (some chains' feeds don't
// carry coordinates at all, so text search always has to keep working).
// Address geocoding goes through Nominatim (OpenStreetMap) — free, no API
// key, no billing risk; browser-side requests identify themselves via the
// page's own referrer, which is what its usage policy asks for.
function NearbyBranchPicker({ vendorId, branches, branchId, onPick, onBranchesUpdated }) {
  const [origin, setOrigin] = useState(null); // { lat, lng } | null
  const [addressQuery, setAddressQuery] = useState("");
  const [geocoding, setGeocoding] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [radius, setRadius] = useState(2000);
  const [warmingUp, setWarmingUp] = useState(false);
  const [warmupProgress, setWarmupProgress] = useState(null); // { done, total } | null
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const loading = branches === "loading";

  // Branch coordinates aren't in the vendor's own feed at all (see the
  // comment below) — this walks the chain's branches through free
  // OpenStreetMap geocoding a batch at a time (its usage policy caps
  // requests at ~1/second, so hundreds of branches can take minutes).
  // Resumable: whatever's already geocoded is cached server-side, so
  // closing and reopening this picker later just continues where it
  // left off instead of starting over.
  async function warmUpCoordinates() {
    setWarmingUp(true);
    setErrorMsg("");
    let keepGoing = true;
    while (keepGoing && mountedRef.current) {
      let res;
      try {
        res = await fns.httpsCallable("geocodeVendorBranchesBatch", { timeout: 60000 })({ vendor: vendorId });
      } catch (e) {
        if (mountedRef.current) { setErrorMsg("שגיאה באיתור מיקומי הסניפים"); setWarmingUp(false); }
        return;
      }
      if (!mountedRef.current) return;
      const { processed, remaining, total, branches: updated } = res.data;
      setWarmupProgress({ done: total - remaining, total });
      if (onBranchesUpdated) onBranchesUpdated(updated);
      keepGoing = remaining > 0 && processed > 0;
    }
    if (mountedRef.current) setWarmingUp(false);
  }

  function searchAddress() {
    const q = addressQuery.trim();
    if (!q) return;
    setGeocoding(true);
    setErrorMsg("");
    geocodeAddress(q).then(coords => {
      setGeocoding(false);
      if (!coords) { setErrorMsg("הכתובת לא נמצאה"); return; }
      setOrigin(coords);
    });
  }

  const allEntries = (branches && !loading) ? Object.entries(branches) : [];
  const withCoords = allEntries.filter(([, b]) => b.lat != null && b.lng != null);
  const needsWarmup = allEntries.length > 0 && withCoords.length < allEntries.length;
  const results = origin
    ? withCoords
        .map(([id, b]) => ({ id, b, dist: haversineMeters(origin.lat, origin.lng, b.lat, b.lng) }))
        .filter(r => r.dist <= radius)
        .sort((a, b) => a.dist - b.dist)
    : [];

  return (
    <div className="space-y-2">
      {!loading && needsWarmup && (
        <div className="bg-[#FBF0D9] border border-[#E9D8A6] rounded-lg px-3 py-2.5">
          <p className="text-xs text-[#8A5A15] mb-2">
            מיקומי הסניפים של הרשת הזו עדיין לא אותרו — פעולה חד־פעמית, אחריה החיפוש יעבוד מיד לכולם.
          </p>
          <button type="button" onClick={warmUpCoordinates} disabled={warmingUp}
            className="w-full bg-[#8A5A15] text-white rounded-lg py-2 text-xs font-bold disabled:opacity-50">
            {warmingUp
              ? `מאתר מיקומים... ${warmupProgress ? warmupProgress.done + "/" + warmupProgress.total : ""}`
              : "📍 איתור מיקומי סניפים"}
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <input value={addressQuery} onChange={e => setAddressQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") searchAddress(); }}
          placeholder="הקלידו כתובת..." autoFocus
          className="flex-1 min-w-0 border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none text-sm" />
        <button type="button" onClick={searchAddress} disabled={!addressQuery.trim() || geocoding}
          className="px-4 rounded-lg bg-[#2E4A3B] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0">
          {geocoding ? <Spinner /> : "חיפוש"}
        </button>
      </div>
      {errorMsg && <p className="text-xs text-[#B8462F]">{errorMsg}</p>}
      {origin && (
        <div>
          <span className="text-xs text-[#8A7F66] block mb-1">רדיוס חיפוש</span>
          <div className="flex flex-wrap gap-1.5">
            {[500, 1000, 2000, 5000, 10000].map(r => (
              <button key={r} type="button" onClick={() => setRadius(r)}
                className={"text-xs px-3 py-1.5 rounded-full font-medium border " +
                  (radius === r ? "bg-[#2E4A3B] text-white border-[#2E4A3B]" : "bg-white text-[#5B5749] border-[#DECBA1]")}>
                {r < 1000 ? r + " מ׳" : (r / 1000) + ' ק"מ'}
              </button>
            ))}
          </div>
        </div>
      )}
      {loading && <div className="py-2"><div className="sz-progress-track"><div className="sz-progress-bar" /></div></div>}
      {origin && !loading && withCoords.length === 0 && !needsWarmup && (
        <p className="text-xs text-[#A79A7C] text-center py-3">לא הצלחנו לאתר מיקום לאף סניף ברשת הזו — נסו חיפוש טקסט</p>
      )}
      {origin && !loading && withCoords.length > 0 && (
        <div className="max-h-56 overflow-y-auto space-y-1">
          {results.length === 0 ? (
            <p className="text-xs text-[#A79A7C] text-center py-3">אין סניפים ברדיוס שנבחר — נסו להגדיל אותו</p>
          ) : results.map(r => (
            <button key={r.id} type="button" onClick={() => onPick(r.id)}
              className={"w-full text-right rounded-lg px-3 py-2 text-sm border " + (branchId === r.id ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-[#F7F2E4] border-transparent")}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#2B2418]">{r.b.name}</span>
                <span className="text-[11px] text-[#8A7F66] flex-shrink-0">{formatDistance(r.dist)}</span>
              </div>
              <div className="text-[11px] text-[#A79A7C]">{r.b.address}{r.b.city ? ", " + r.b.city : ""}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Vendors whose feed can't currently be reached from our server. Victory
// and מחסני השוק (laibcatalog.co.il) time out — a plain request to the same
// URL succeeds instantly from a normal network, pointing at the feed
// blocking cloud-server traffic. חצי חינם is more clear-cut: its site sits
// behind a Cloudflare bot challenge ("Just a moment...") that only a real
// browser running JavaScript can pass — no request header can get through
// that. Shown in the vendor picker (not hidden) so it's clear these exist
// and aren't just missing, but disabled until that's resolved.
const UNSUPPORTED_VENDORS = new Set(["victory", "mahsaniAshuk", "haziHinam"]);

// Self-contained "pick a vendor, then a branch, then add it" flow — used
// both in Settings and from a list's own vendor screen, so adding a branch
// never requires a separate trip to Settings first.
function AddBranchWidget({ uid, existingProfiles, showToast, onAdded }) {
  const [branchCache, setBranchCache] = useState({});
  const [addingVendor, setAddingVendor] = useState("");
  const [branchId, setBranchId] = useState("");
  const [pickerMode, setPickerMode] = useState("text");

  function loadBranches(vendorId) {
    setBranchCache(prev => Object.assign({}, prev, { [vendorId]: "loading" }));
    fns.httpsCallable("getVendorBranches")({ vendor: vendorId }).then(res => {
      setBranchCache(prev => Object.assign({}, prev, { [vendorId]: res.data.branches || {} }));
    }).catch(() => {
      setBranchCache(prev => Object.assign({}, prev, { [vendorId]: {} }));
      showToast("שגיאה בטעינת סניפים");
    });
  }
  function pickVendor(vendorId) {
    setAddingVendor(vendorId);
    setBranchId("");
    setPickerMode("text");
    if (vendorId && !branchCache[vendorId]) loadBranches(vendorId);
  }
  function addProfile() {
    if (!addingVendor || !branchId) return;
    const already = (existingProfiles || []).some(p => p.vendor === addingVendor && String(p.branchId) === String(branchId));
    if (already) { showToast("הסניף כבר ברשימה שלך"); return; }
    db.collection("users").doc(uid).collection("vendorProfiles").add({
      vendor: addingVendor, branchId, active: true, mode: "instore", addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    fns.httpsCallable("prewarmVendorCatalog")({ vendor: addingVendor, branchId }).catch(() => {});
    setAddingVendor("");
    setBranchId("");
    if (onAdded) onAdded();
  }

  const addingBranches = addingVendor ? branchCache[addingVendor] : null;

  return (
    <div className="bg-white border border-[#E0D4B4] rounded-xl p-3 space-y-2">
      <div className="text-xs font-semibold text-[#8A7F66]">הוספת סניף להשוואה</div>
      <select value={addingVendor} onChange={e => pickVendor(e.target.value)}
        className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none">
        <option value="">בחירת רשת...</option>
        {VENDOR_LIST.map(v => (
          <option key={v.id} value={v.id} disabled={UNSUPPORTED_VENDORS.has(v.id)}>
            {v.label}{UNSUPPORTED_VENDORS.has(v.id) ? " (לא זמין כרגע)" : ""}
          </option>
        ))}
      </select>
      {addingVendor && (
        <React.Fragment>
          <div className="flex bg-[#F7F2E4] rounded-full p-0.5 w-fit">
            <button type="button" onClick={() => setPickerMode("text")}
              className={"text-xs px-3 py-1.5 rounded-full font-medium " + (pickerMode === "text" ? "bg-white text-[#2E4A3B] shadow-sm" : "text-[#8A7F66]")}>
              חיפוש טקסט
            </button>
            <button type="button" onClick={() => setPickerMode("nearby")}
              className={"text-xs px-3 py-1.5 rounded-full font-medium " + (pickerMode === "nearby" ? "bg-white text-[#2E4A3B] shadow-sm" : "text-[#8A7F66]")}>
              📍 סניפים קרובים
            </button>
          </div>
          {pickerMode === "text" ? (
            <BranchPicker branches={addingBranches} branchId={branchId} onPick={setBranchId} />
          ) : (
            <NearbyBranchPicker vendorId={addingVendor} branches={addingBranches} branchId={branchId} onPick={setBranchId}
              onBranchesUpdated={updated => setBranchCache(prev => Object.assign({}, prev, { [addingVendor]: updated }))} />
          )}
        </React.Fragment>
      )}
      <button onClick={addProfile} disabled={!addingVendor || !branchId}
        className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40">
        + הוספת סניף
      </button>
    </div>
  );
}

// ── VENDORS (branches to compare, online vendors) ─────────────────────────────
function VendorsScreen({ uid, onBack }) {
  const [profiles, setProfiles] = useState(null);
  const [branchCache, setBranchCache] = useState({});
  const [role, setRole] = useState(null);
  const [catalogTimestamps, setCatalogTimestamps] = useState({});
  const [confirmRefresh, setConfirmRefresh] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [toast, setToast] = useState(null);
  const onlineVendors = useOnlineVendors();
  const isEditorOrAdmin = role === "editor" || role === "admin";

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => db.collection("users").doc(uid).collection("vendorProfiles")
    .onSnapshot(snap => setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })))), [uid]);

  useEffect(() => db.collection("users").doc(uid).onSnapshot(snap => {
    const data = snap.data() || {};
    setRole(effectiveRole(data.role || null));
  }), [uid]);

  useEffect(() => {
    provisionOnlineVendorProfiles(uid, onlineVendors, profiles, setToast);
    // eslint-disable-next-line
  }, [profiles, JSON.stringify(onlineVendors)]);

  function loadCatalogTimestamps() {
    fns.httpsCallable("getActiveCatalogTimestamps")({}).then(res => {
      const map = {};
      (res.data.timestamps || []).forEach(t => { map[t.id] = t.updatedAt; });
      setCatalogTimestamps(map);
    }).catch(() => {});
  }
  useEffect(() => {
    if (profiles && profiles.length > 0) loadCatalogTimestamps();
    // eslint-disable-next-line
  }, [profiles && profiles.length]);

  function refreshCatalog(p) {
    setRefreshingId(p.id);
    fns.httpsCallable("prewarmVendorCatalog", { timeout: 120000 })({ vendor: p.vendor, branchId: p.branchId, force: true }).then(res => {
      setRefreshingId(null);
      setCatalogTimestamps(prev => Object.assign({}, prev, { [p.id]: res.data.updatedAt || Date.now() }));
      setToast("הקטלוג עודכן");
    }, () => { setRefreshingId(null); setToast("שגיאה ברענון הקטלוג"); });
  }

  function loadBranches(vendorId) {
    setBranchCache(prev => Object.assign({}, prev, { [vendorId]: "loading" }));
    fns.httpsCallable("getVendorBranches")({ vendor: vendorId }).then(res => {
      setBranchCache(prev => Object.assign({}, prev, { [vendorId]: res.data.branches || {} }));
    }).catch(() => {
      setBranchCache(prev => Object.assign({}, prev, { [vendorId]: {} }));
      setToast("שגיאה בטעינת סניפים");
    });
  }
  useEffect(() => {
    (profiles || []).forEach(p => {
      if (!branchCache[p.vendor]) loadBranches(p.vendor);
    });
    // eslint-disable-next-line
  }, [profiles]);

  function toggleProfile(p) {
    db.collection("users").doc(uid).collection("vendorProfiles").doc(p.id).update({ active: !p.active });
  }
  function removeProfile(p) {
    db.collection("users").doc(uid).collection("vendorProfiles").doc(p.id).delete();
  }
  function branchLabel(vendorId, id) {
    const b = branchCache[vendorId];
    const info = b && b !== "loading" ? b[id] : null;
    if (!info) return "סניף " + parseInt(id, 10);
    return info.name + (info.address ? " — " + info.address : "");
  }

  const instoreProfiles = (profiles || []).filter(p => (p.mode || "instore") === "instore");
  const onlineProfiles = (profiles || []).filter(p => p.mode === "online");
  const activeCount = instoreProfiles.filter(p => p.active).length;

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <BackButton onClick={onBack} />
        <h1 className="text-xl" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>רשתות להשוואת מחירים</h1>
      </div>

      <div className="p-4 space-y-6">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>סניפים פיזיים</h2>
            {profiles && instoreProfiles.length > 0 && (
              <span className="text-xs text-[#8A7F66]">פעילים להשוואה: {activeCount} מתוך {instoreProfiles.length}</span>
            )}
          </div>
          <p className="text-xs text-[#8A7F66] mb-3">הוסיפו את הסניפים שאתם קונים בהם — מחירים אמיתיים יופיעו על הפריטים ברשימות.</p>

          <div className="flex flex-col gap-2 mb-3">
            {profiles === null && <div className="text-[#8A7F66] text-sm">טוען...</div>}
            {profiles && instoreProfiles.length === 0 && <div className="text-[#8A7F66] text-sm">לא נוספו סניפים עדיין</div>}
            {profiles && instoreProfiles.map(p => (
              <div key={p.id} className={"rounded-xl px-3 py-2.5 border " +
                (p.active ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-white border-[#E0D4B4]")}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-[#2B2418] text-right min-w-0">
                    <span className="font-semibold">{vendorLabel(p.vendor)}</span>
                    <span className="text-[#8A7F66]"> — {branchLabel(p.vendor, p.branchId)}</span>
                  </span>
                  <button onClick={() => toggleProfile(p)}
                    className={"text-xs border rounded-full px-2.5 py-1 flex-shrink-0 " +
                      (p.active ? "text-[#2E7D4F] border-[#B9D9B0] bg-white" : "text-[#A79A7C] border-[#DECBA1] bg-white")}>
                    {p.active ? "פעיל" : "כבוי"}
                  </button>
                  <button onClick={() => removeProfile(p)} className="text-[#B8462F] text-sm px-1 flex-shrink-0">✕</button>
                </div>
                <div className="flex items-center justify-between gap-2 mt-1.5">
                  <span className="text-[11px] text-[#A79A7C]">עודכן לאחרונה: {formatRelativeUpdatedAt(catalogTimestamps[p.id])}</span>
                  {isEditorOrAdmin && (
                    <button onClick={() => setConfirmRefresh(p)} disabled={refreshingId === p.id}
                      className="text-[11px] font-bold text-[#2E4A3B] underline disabled:opacity-40 flex-shrink-0">
                      {refreshingId === p.id ? "מרענן..." : "🔄 רענון קטלוג"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <AddBranchWidget uid={uid} existingProfiles={profiles} showToast={setToast} />
        </div>

        <div>
          <h2 className="text-lg mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>רשתות לקנייה אונליין</h2>
          <p className="text-xs text-[#8A7F66] mb-3">רשימת כל הרשתות עם אפשרות קנייה אונליין — אפשר לכבות כל רשת שלא רוצים.</p>
          <div className="bg-[#FBF0D9] border border-[#E9D8A6] rounded-xl px-3 py-2.5 mb-3">
            <p className="text-xs text-[#8A5A15]">
              הזמינות בפועל תלויה בעיר המשלוח שלכם — הרשימה כאן לא בודקת את זה. מומלץ לוודא באתר הרשת לפני ההזמנה.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {onlineProfiles.length === 0 && (
              <div className="text-[#8A7F66] text-sm">אין עדיין רשתות לקנייה אונליין</div>
            )}
            {onlineProfiles.map(p => (
              <div key={p.id} className={"rounded-xl px-3 py-2.5 flex items-center gap-2 border " +
                (p.active ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-white border-[#E0D4B4]")}>
                <span className="flex-1 text-sm text-[#2B2418] text-right min-w-0 font-semibold">{vendorLabel(p.vendor)} (אונליין)</span>
                <button onClick={() => toggleProfile(p)}
                  className={"text-xs border rounded-full px-2.5 py-1 flex-shrink-0 " +
                    (p.active ? "text-[#2E7D4F] border-[#B9D9B0] bg-white" : "text-[#A79A7C] border-[#DECBA1] bg-white")}>
                  {p.active ? "פעיל" : "כבוי"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirmRefresh && (
        <ConfirmDialog
          message={`לרענן את קטלוג ${vendorLabel(confirmRefresh.vendor)} — ${branchLabel(confirmRefresh.vendor, confirmRefresh.branchId)}? זו פנייה חיה לרשת ועשויה לקחת עד דקה.`}
          confirmLabel="רענון" onConfirm={() => refreshCatalog(confirmRefresh)} onClose={() => setConfirmRefresh(null)} />
      )}

      {toast && <Toast msg={toast} />}
    </div>
  );
}

// ── ADMIN OPTIONS (AI config, categories, corrections, store order, online vendor delivery config, users) ──
function AdminOptionsScreen({ uid, onBack }) {
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiProvider, setAiProvider] = useState("anthropic");
  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [aiModel, setAiModel] = useState(AI_PROVIDERS.anthropic.defaultModel);
  const [liveModels, setLiveModels] = useState({}); // { [provider]: { models, cheapestId } }
  const [liveModelsLoading, setLiveModelsLoading] = useState(false);
  const [liveModelsErr, setLiveModelsErr] = useState("");
  const [savingAi, setSavingAi] = useState(false);
  const [toast, setToast] = useState(null);
  const [role, setRole] = useState(null);
  const [runningVendor, setRunningVendor] = useState(null); // vendor id currently being categorized, or null
  const [runProgress, setRunProgress] = useState({ done: 0, total: null });
  const [runningAll, setRunningAll] = useState(false);
  const [categorizationRuns, setCategorizationRuns] = useState({}); // { [vendor]: {lastRunAt, itemsProcessed} }
  const [showCategorizeSection, setShowCategorizeSection] = useState(false);
  // A ref, not state — the backfill loops read this on every iteration to
  // decide whether to keep going, and a ref is never stale inside a
  // long-running async function the way a captured state value could be.
  const stopRequestedRef = useRef(false);
  // Mirrors the ref purely so the stop button can show it registered the
  // click right away — the current in-flight call still has to finish
  // (it can't be interrupted mid-request), but the button shouldn't look
  // like nothing happened while that's in progress.
  const [stopRequested, setStopRequested] = useState(false);
  const isEditorOrAdmin = role === "editor" || role === "admin";
  const [allUsers, setAllUsers] = useState(null);
  const [userStats, setUserStats] = useState({}); // { [uid]: { costThisMonth, callsToday } }
  const [newOnlineVendorDraft, setNewOnlineVendorDraft] = useState({ vendor: "", branchId: "", deliveryFee: "", minimumOrder: "" });
  const [savingOnlineVendor, setSavingOnlineVendor] = useState(false);
  const [confirmDeleteOnlineVendor, setConfirmDeleteOnlineVendor] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const onlineVendors = useOnlineVendors();

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => {
    if (!isEditorOrAdmin) return;
    return db.collection("categoryCorrections").onSnapshot(snap => {
      setCorrections(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [isEditorOrAdmin]);

  useEffect(() => {
    if (!isEditorOrAdmin) return;
    return db.collection("categorizationRuns").onSnapshot(snap => {
      const map = {};
      snap.docs.forEach(d => { map[d.id] = d.data(); });
      setCategorizationRuns(map);
    });
  }, [isEditorOrAdmin]);

  // One review row per barcode, not per correction — several users fixing
  // the same product collapses into one row with a count, and the
  // most-common new category becomes the suggestion (stronger signal than
  // any single person's opinion).
  const correctionGroups = (corrections || []).reduce((groups, c) => {
    let g = groups.find(x => x.barcode === c.barcode);
    if (!g) { g = { barcode: c.barcode, itemName: c.itemName, oldCategory: c.oldCategory, entries: [] }; groups.push(g); }
    g.itemName = c.itemName;
    g.entries.push(c);
    return groups;
  }, []).map(g => {
    const counts = {};
    g.entries.forEach(e => { counts[e.newCategory] = (counts[e.newCategory] || 0) + 1; });
    const suggested = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return Object.assign({}, g, { count: g.entries.length, suggestedCategory: suggested ? suggested[0] : null });
  }).sort((a, b) => b.count - a.count);

  function applyCorrection(group) {
    if (!group.suggestedCategory) return;
    db.collection("productCategories").doc(group.barcode).set({
      category: group.suggestedCategory, categorizedAt: Date.now(),
    }, { merge: true }).then(() => {
      const batch = db.batch();
      group.entries.forEach(e => batch.delete(db.collection("categoryCorrections").doc(e.id)));
      return batch.commit();
    }).then(() => setToast("הקטגוריה עודכנה בקטלוג המשותף"), () => setToast("שגיאה בעדכון"));
  }
  function dismissCorrection(group) {
    const batch = db.batch();
    group.entries.forEach(e => batch.delete(db.collection("categoryCorrections").doc(e.id)));
    batch.commit().then(() => setToast("סומן כטופל"));
  }

  useEffect(() => {
    if (role !== "admin") return;
    return db.collection("users").onSnapshot(snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (b.lastLoginAt?.toMillis?.() || 0) - (a.lastLoginAt?.toMillis?.() || 0));
      setAllUsers(rows);
    });
  }, [role]);

  // Per-user AI cost (this month) and call volume (today) — the safety-net
  // view for keeping sign-up open to anyone without flying blind on who's
  // actually costing money, and the basis for deciding a future paid tier.
  useEffect(() => {
    if (role !== "admin") return;
    const thisMonth = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([
      fns.httpsCallable("getCosts")({ scope: "all" }),
      fns.httpsCallable("getUsageStats")({}),
    ]).then(([costsRes, usageRes]) => {
      const stats = {};
      (costsRes.data.users || []).forEach(u => {
        const monthEntry = u.months.find(m => m.month === thisMonth);
        const costThisMonth = monthEntry ? Object.keys(monthEntry).filter(k => k !== "month").reduce((s, k) => s + (monthEntry[k] || 0), 0) : 0;
        stats[u.uid] = Object.assign({}, stats[u.uid], { costThisMonth });
      });
      (usageRes.data.users || []).forEach(u => {
        const dayEntry = u.days.find(d => d.day === today);
        const callsToday = dayEntry ? Object.keys(dayEntry).filter(k => k !== "day").reduce((s, k) => s + (dayEntry[k] || 0), 0) : 0;
        stats[u.uid] = Object.assign({}, stats[u.uid], { callsToday });
      });
      setUserStats(stats);
    }).catch(() => {});
  }, [role]);

  function changeUserRole(userId, newRole) {
    db.collection("users").doc(userId).update({ role: newRole }).then(() => setToast("התפקיד עודכן"), () => setToast("שגיאה בעדכון תפקיד"));
  }

  function startEditOnlineVendor(vendor, cfg) {
    setNewOnlineVendorDraft({
      vendor, branchId: cfg.branchId || "",
      deliveryFee: cfg.deliveryFee ?? "", minimumOrder: cfg.minimumOrder ?? "",
      active: cfg.active !== false,
    });
  }
  function resetOnlineVendorDraft() {
    setNewOnlineVendorDraft({ vendor: "", branchId: "", deliveryFee: "", minimumOrder: "" });
  }
  function saveOnlineVendor() {
    const d = newOnlineVendorDraft;
    if (!d.vendor || !d.branchId) { setToast("נדרשים רשת ומספר סניף"); return; }
    setSavingOnlineVendor(true);
    db.collection("onlineVendors").doc(d.vendor).set({
      branchId: d.branchId, label: vendorLabel(d.vendor),
      deliveryFee: parseFloat(d.deliveryFee) || 0, minimumOrder: parseFloat(d.minimumOrder) || 0,
      active: d.active !== false,
    }).then(() => {
      setSavingOnlineVendor(false);
      setToast("נשמר");
      resetOnlineVendorDraft();
    }, () => { setSavingOnlineVendor(false); setToast("שגיאה בשמירה"); });
  }
  function deleteOnlineVendor(vendor) {
    db.collection("onlineVendors").doc(vendor).delete().then(() => setToast("הרשת הוסרה"));
  }

  useEffect(() => db.collection("users").doc(uid).collection("vendorProfiles")
    .onSnapshot(snap => setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })))), [uid]);

  useEffect(() => db.collection("users").doc(uid).onSnapshot(snap => {
    const data = snap.data() || {};
    setRole(effectiveRole(data.role || null));
  }), [uid]);

  // Only reachable for an admin (see the Firestore rule) — a non-admin
  // simply gets an empty snapshot back, never an error, since they never
  // render this section anyway.
  useEffect(() => db.collection("appConfig").doc("ai").onSnapshot(snap => {
    const data = snap.data();
    if (!data) return;
    setAiProvider(data.provider || "anthropic");
    setOpenaiKey(data.openaiApiKey || "");
    setGeminiKey(data.geminiApiKey || "");
    setAnthropicKey(data.anthropicApiKey || "");
    const p = data.provider || "anthropic";
    setAiModel((p === "openai" ? data.openaiModel : p === "gemini" ? data.geminiModel : data.anthropicModel) || AI_PROVIDERS[p].defaultModel);
  }, () => {}), [uid]);

  // Calls the batch backfill repeatedly (same "keep calling until done"
  // shape as branch geocoding) until nothing's left uncategorized for this
  // vendor, or until stopRequestedRef is set — the server picks any one
  // already-cached branch on its own, so this only ever needs a vendor id,
  // never a specific branch. Doesn't reset the stop flag itself, since
  // runCatalogBackfillAll calls this once per vendor in sequence and a
  // stop mid-way through vendor 3 must not get silently cleared when
  // vendor 4's run starts — only the two entry points below reset it.
  async function runCatalogBackfill(vendor, silent) {
    setRunningVendor(vendor);
    setRunProgress({ done: 0, total: null });
    let totalTodo = null;
    let done = 0;
    let remaining = 1;
    let noCatalog = false;
    while (remaining > 0) {
      // Checked only between calls, not during one — a bigger batch cuts
      // down on repeated full-catalog rescans, but also makes "stop" wait
      // longer to take effect, since a call already in flight can't be
      // interrupted mid-way. 250 is a middle ground: still far fewer
      // round trips than the original 150, but each one finishes in well
      // under a minute so stopping still feels reasonably responsive.
      if (stopRequestedRef.current) break;
      let res;
      try {
        res = await fns.httpsCallable("categorizeCatalogBatch", { timeout: 300000 })({ vendor, limit: 250 });
      } catch (e) {
        setToast((e && e.message) || "שגיאה בסיווג הקטלוג");
        break;
      }
      const data = res.data;
      if (data.noCatalog) { noCatalog = true; break; }
      if (totalTodo === null) totalTodo = data.totalInCatalog - data.alreadyCached;
      done += data.processedNow;
      remaining = data.remaining;
      setRunProgress({ done, total: totalTodo });
      if (data.processedNow === 0) break;
    }
    setRunningVendor(null);
    if (noCatalog) {
      if (!silent) setToast(`אין עדיין קטלוג שמור עבור ${vendorLabel(vendor)} — צריך שמישהו יעקוב אחרי סניף שלה קודם`);
    } else {
      if (done > 0) {
        await db.collection("categorizationRuns").doc(vendor).set({
          lastRunAt: firebase.firestore.FieldValue.serverTimestamp(), lastRunBy: uid, itemsProcessed: done,
        }, { merge: true });
      }
      if (!silent) {
        setToast(stopRequestedRef.current ? `נעצר — סווגו ${done} פריטים` : (done > 0 ? `סווגו ${done} פריטים` : "אין פריטים חדשים לסווג"));
      }
    }
    return { done, noCatalog };
  }

  function startSingleVendorRun(vendor) {
    stopRequestedRef.current = false;
    setStopRequested(false);
    runCatalogBackfill(vendor, false);
  }
  function stopBackfill() {
    stopRequestedRef.current = true;
    setStopRequested(true);
  }

  async function runCatalogBackfillAll() {
    stopRequestedRef.current = false;
    setStopRequested(false);
    setRunningAll(true);
    let totalDone = 0;
    for (const v of VENDOR_LIST) {
      if (stopRequestedRef.current) break;
      const { done } = await runCatalogBackfill(v.id, true);
      totalDone += done;
    }
    setRunningAll(false);
    setToast(stopRequestedRef.current
      ? `נעצר — סווגו ${totalDone} פריטים בסך הכול`
      : `הושלם לכל הרשתות — סווגו ${totalDone} פריטים בסך הכול`);
  }

  const currentAiProviderKey = () => (aiProvider === "openai" ? openaiKey : aiProvider === "gemini" ? geminiKey : anthropicKey);
  function switchAiProvider(p) {
    setAiProvider(p);
    setAiModel(AI_PROVIDERS[p].defaultModel);
    setLiveModelsErr("");
  }
  function refreshAiModels() {
    const key = currentAiProviderKey();
    if (!key.trim() || liveModelsLoading) return;
    setLiveModelsLoading(true);
    setLiveModelsErr("");
    fns.httpsCallable("listProviderModels")({ provider: aiProvider, apiKey: key.trim() }).then(res => {
      setLiveModels(prev => Object.assign({}, prev, { [aiProvider]: res.data }));
      setLiveModelsLoading(false);
    }).catch(e => {
      setLiveModelsErr(e.message);
      setLiveModelsLoading(false);
    });
  }
  function saveAi() {
    if (!currentAiProviderKey().trim()) { setToast(`נדרש מפתח ${AI_PROVIDERS[aiProvider].name} — הזן מפתח או בחר ספק אחר`); return; }
    setSavingAi(true);
    const model = aiModel.trim() || AI_PROVIDERS[aiProvider].defaultModel;
    const config = {
      provider: aiProvider,
      openaiApiKey: openaiKey.trim(), openaiModel: aiProvider === "openai" ? model : AI_PROVIDERS.openai.defaultModel,
      geminiApiKey: geminiKey.trim(), geminiModel: aiProvider === "gemini" ? model : AI_PROVIDERS.gemini.defaultModel,
      anthropicApiKey: anthropicKey.trim(), anthropicModel: aiProvider === "anthropic" ? model : AI_PROVIDERS.anthropic.defaultModel,
    };
    db.collection("appConfig").doc("ai").set(config)
      .then(() => { setSavingAi(false); setToast("נשמר — זמין לכל המשתמשים"); }, () => { setSavingAi(false); setToast("שגיאה בשמירה"); });
  }

  // ── Categories ──
  const categories = useCategories();
  const [editingCatId, setEditingCatId] = useState(null);
  const [editCatLabel, setEditCatLabel] = useState("");
  const [editCatEmoji, setEditCatEmoji] = useState("");
  const [newCatLabel, setNewCatLabel] = useState("");
  const [newCatEmoji, setNewCatEmoji] = useState("📦");
  const [confirmDeleteCat, setConfirmDeleteCat] = useState(null);
  const [expandedCatId, setExpandedCatId] = useState(null);
  const [newSubcatLabel, setNewSubcatLabel] = useState("");

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
  function addSubcategory(cat) {
    const label = newSubcatLabel.trim();
    if (!label) return;
    const sub = { id: "sub_" + Date.now(), label };
    db.collection("categories").doc(cat.id).update({
      subcategories: (cat.subcategories || []).concat(sub),
    }).then(() => setNewSubcatLabel(""));
  }
  function removeSubcategory(cat, subId) {
    db.collection("categories").doc(cat.id).update({
      subcategories: (cat.subcategories || []).filter(s => s.id !== subId),
    });
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

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <BackButton onClick={onBack} />
        <h1 className="text-xl" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>אפשרויות מנהל</h1>
      </div>

      <div className="p-4 space-y-6">
        {isEditorOrAdmin && (
            <div className="mb-3">
              <button onClick={() => setShowCategorizeSection(v => !v)}
                className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showCategorizeSection ? "bg-white border-[#E9D8A6]" : "bg-[#FBF0D9] border-transparent")}>
                <span className="text-xs font-semibold text-[#8A5A15]">🏷️ סיווג קטלוג לקטגוריות (לכל 15 הרשתות)</span>
                <span className="text-[#8A7F66] text-xs flex-shrink-0">{showCategorizeSection ? "▲ הסתר" : "▼ הצג"}</span>
              </button>
              {showCategorizeSection && (
                <div className="mt-2 bg-[#FBF0D9] border border-[#E9D8A6] rounded-xl p-3">
                  <p className="text-[11px] text-[#8A7F66] mb-2">
                    פעם אחת לכל רשת מספיקה, לא לכל סניף בנפרד — התיוג משותף לכל מי שמוכר אותו ברקוד. רשימה מלאה, לא רק הרשתות שאתם עצמכם עוקבים אחריהן.
                  </p>
                  {(runningVendor || runningAll) ? (
                    <button onClick={stopBackfill} disabled={stopRequested}
                      className="w-full bg-[#B8462F] text-white text-xs font-bold py-2.5 rounded-lg mb-2 disabled:opacity-60">
                      {stopRequested ? "עוצר... (מסיים את הקבוצה הנוכחית)" : "⏹ עצירה"}
                    </button>
                  ) : (
                    <button onClick={runCatalogBackfillAll}
                      className="w-full bg-[#8A5A15] text-white text-xs font-bold py-2.5 rounded-lg mb-2">
                      ▶ הרץ לכל הרשתות
                    </button>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {VENDOR_LIST.map(v => {
                      const run = categorizationRuns[v.id];
                      const isRunning = runningVendor === v.id;
                      return (
                        <div key={v.id} className="flex items-center justify-between gap-2 bg-white rounded-lg px-2.5 py-2">
                          <div className="min-w-0">
                            <div className="text-sm text-[#2B2418]">{v.label}</div>
                            <div className="text-[10px] text-[#A79A7C]">
                              {run && run.lastRunAt ? `הורץ לאחרונה: ${formatRelativeUpdatedAt(run.lastRunAt.toMillis?.())}` : "מעולם לא הורץ"}
                            </div>
                          </div>
                          <button onClick={() => startSingleVendorRun(v.id)} disabled={!!runningVendor || runningAll}
                            className="text-[11px] font-bold text-[#8A5A15] underline disabled:opacity-40 flex-shrink-0">
                            {isRunning ? `מסווג... ${runProgress.done}${runProgress.total != null ? "/" + runProgress.total : ""}` : "🏷️ הרצה"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

        {isEditorOrAdmin && (
          <div className="pt-2 border-t-2 border-[#C7B78E] flex items-center gap-2">
            <span className="text-[11px] font-bold text-[#8A5A15] uppercase tracking-wide">🛠️ ניהול מערכת</span>
            <span className="text-[10px] text-[#A79A7C]">(עורכים ומנהלים)</span>
          </div>
        )}

        {role === "admin" && (
        <div>
          <button onClick={() => setShowAiSettings(v => !v)}
            className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showAiSettings ? "bg-white border-[#C7B78E]" : "bg-[#F7F2E4] border-transparent")}>
            <div className="flex items-center gap-3">
              <span className="text-lg w-7 text-center">🤖</span>
              <div className="text-right">
                <div className="text-sm font-semibold text-[#2B2418]">הגדרות AI (למנהל)</div>
                <div className="text-xs text-[#A79A7C]">{AI_PROVIDERS[aiProvider].name} · משותף לכל המשתמשים</div>
              </div>
            </div>
            <span className="text-[#A79A7C] text-xs flex-shrink-0">{showAiSettings ? "▲ הסתר" : "▼ הצג"}</span>
          </button>
          {showAiSettings && (
            <div className="mt-2 bg-white border border-[#E0D4B4] rounded-2xl p-4">
              <p className="text-xs text-[#8A7F66] mb-2 text-right">ספק AI</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {Object.entries(AI_PROVIDERS).map(([id, p]) => {
                  const hasKey = !!(id === "openai" ? openaiKey : id === "gemini" ? geminiKey : anthropicKey);
                  const active = aiProvider === id;
                  return (
                    <button key={id} onClick={() => switchAiProvider(id)}
                      className={"py-2 rounded-xl text-sm font-medium border transition flex flex-col items-center gap-0.5 " + (active ? "bg-[#2E4A3B] text-white border-[#2E4A3B]" : "bg-white text-[#5B5749] border-[#DECBA1]")}>
                      <span className="font-semibold">{p.name} {hasKey ? "✓" : ""}</span>
                      <span className={"text-xs " + (active ? "text-[#C9BE9E]" : "text-[#A79A7C]")}>{p.label}{p.free ? " · חינם" : ""}</span>
                    </button>
                  );
                })}
              </div>

              {[["anthropic", "Anthropic API Key", anthropicKey, setAnthropicKey],
                ["openai", "OpenAI API Key", openaiKey, setOpenaiKey],
                ["gemini", "Google AI Studio API Key", geminiKey, setGeminiKey]]
                .filter(row => row[0] === aiProvider)
                .map(([id, label, val, setter]) => (
                  <div key={id} className="mb-3">
                    <div className="flex items-center justify-between mb-1">
                      <a href={AI_KEY_LINKS[id]} target="_blank" rel="noopener noreferrer"
                        className="text-xs font-semibold text-[#2E4A3B] bg-[#EEF5EC] border border-[#B9D9B0] rounded-lg px-2 py-1 whitespace-nowrap">
                        🔑 קבל מפתח API ↗
                      </a>
                      <p className="text-xs text-[#8A7F66] text-right">{label}</p>
                    </div>
                    <input value={val} onChange={e => setter(e.target.value)} placeholder={AI_PROVIDERS[id].keyHint} type="password" dir="ltr"
                      className="w-full border border-[#C7B78E] rounded-xl px-4 py-3 text-left outline-none text-sm" />
                  </div>
                ))}

              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <button onClick={refreshAiModels} disabled={!currentAiProviderKey().trim() || liveModelsLoading}
                    className="text-xs font-semibold text-[#2E4A3B] bg-[#EEF5EC] border border-[#B9D9B0] rounded-lg px-2 py-1 whitespace-nowrap disabled:opacity-40">
                    {liveModelsLoading ? "בודק..." : "🔄 רענן רשימה"}
                  </button>
                  <p className="text-xs text-[#8A7F66] text-right">מודל</p>
                </div>
                <select value={aiModel} onChange={e => setAiModel(e.target.value)} dir="ltr"
                  className="w-full border border-[#C7B78E] rounded-xl px-4 py-3 text-left outline-none text-sm font-mono bg-white">
                  {aiModelOptions((liveModels[aiProvider] && liveModels[aiProvider].models) || FALLBACK_MODELS[aiProvider], aiModel).map(m => (
                    <option key={m.id} value={m.id}>{aiModelLabel(m, liveModels[aiProvider] && liveModels[aiProvider].cheapestId)}</option>
                  ))}
                </select>
                {liveModelsErr ? (
                  <p className="text-xs text-[#B8462F] mt-1 text-right">{liveModelsErr}</p>
                ) : liveModels[aiProvider] ? (
                  <p className="text-xs text-[#A79A7C] mt-1 text-right">נמצאו {liveModels[aiProvider].models.length} מודלים בחשבון.</p>
                ) : (
                  <p className="text-xs text-[#A79A7C] mt-1 text-right">רשימת ברירת מחדל — לחצו "רענן רשימה" למודלים העדכניים מהחשבון.</p>
                )}
              </div>

              <button onClick={saveAi} disabled={savingAi}
                className="w-full bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40">
                {savingAi ? "שומר..." : "שמירה"}
              </button>
              <p className="text-[11px] text-[#A79A7C] mt-2">מפתח אחד, מוגדר פעם אחת, משמש את כל המשתמשים — לסיווג קטגוריה אוטומטי לפריט חדש.</p>
            </div>
          )}
        </div>
        )}

        {isEditorOrAdmin && (
        <React.Fragment>
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
                    <button onClick={() => { setExpandedCatId(expandedCatId === cat.id ? null : cat.id); setNewSubcatLabel(""); }}
                      className="text-[10px] text-[#8A7F66] flex-shrink-0 underline">
                      תתי-קטגוריה ({(cat.subcategories || []).length}) {expandedCatId === cat.id ? "▲" : "▼"}
                    </button>
                    <button onClick={() => { setEditingCatId(cat.id); setEditCatLabel(cat.label); setEditCatEmoji(cat.emoji); }}
                      className="w-7 h-7 flex items-center justify-center text-[#A79A7C] text-sm">✏️</button>
                    <button onClick={() => setConfirmDeleteCat(cat)}
                      className="w-7 h-7 flex items-center justify-center text-[#C7B78E] text-base">🗑️</button>
                  </div>
                )}
                {expandedCatId === cat.id && (
                  <div className="mt-2.5 pt-2.5 border-t border-[#F0E9D4]">
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {(cat.subcategories || []).length === 0 && (
                        <span className="text-xs text-[#A79A7C]">אין עדיין תתי-קטגוריה</span>
                      )}
                      {(cat.subcategories || []).map(sub => (
                        <span key={sub.id} className="flex items-center gap-1 bg-[#F3ECD9] rounded-full px-2.5 py-1 text-xs text-[#2B2418]">
                          {sub.label}
                          <button onClick={() => removeSubcategory(cat, sub.id)} className="text-[#B8462F] font-bold">✕</button>
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input value={newSubcatLabel} onChange={e => setNewSubcatLabel(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && addSubcategory(cat)}
                        placeholder="תת-קטגוריה חדשה..."
                        className="flex-1 border border-[#C7B78E] rounded-lg px-3 py-1.5 text-right text-xs outline-none bg-white" />
                      <button onClick={() => addSubcategory(cat)} disabled={!newSubcatLabel.trim()}
                        className="px-3 bg-[#2E4A3B] text-white text-xs font-semibold rounded-lg disabled:opacity-40">
                        + הוספה
                      </button>
                    </div>
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
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>תיקוני קטגוריה</h2>
            {correctionGroups.length > 0 && (
              <span className="text-xs text-[#8A7F66]">{correctionGroups.length} ממתינים</span>
            )}
          </div>
          <p className="text-xs text-[#8A7F66] mb-3">כשמישהו משנה קטגוריה לפריט מותאם, זה מופיע כאן — אפשר לעדכן בקטלוג המשותף כדי שזה יתוקן לכולם, או להתעלם.</p>
          <div className="flex flex-col gap-2">
            {corrections === null && <div className="text-[#8A7F66] text-sm">טוען...</div>}
            {corrections !== null && correctionGroups.length === 0 && (
              <div className="text-[#8A7F66] text-sm">אין תיקונים ממתינים</div>
            )}
            {correctionGroups.map(g => (
              <div key={g.barcode} className="bg-white border border-[#E0D4B4] rounded-xl px-3 py-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium text-[#2B2418] text-sm truncate">{g.itemName}</span>
                  {g.count > 1 && <span className="text-[10px] text-[#8A7F66] bg-[#F3ECD9] rounded-full px-2 py-0.5 flex-shrink-0">{g.count} דיווחים</span>}
                </div>
                <div className="text-[11px] text-[#A79A7C] mb-2">
                  {g.oldCategory ? categoryHeaderLabel(g.oldCategory) : "—"} ← {categoryHeaderLabel(g.suggestedCategory)}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => applyCorrection(g)} className="flex-1 bg-[#2E4A3B] text-white text-xs font-semibold py-2 rounded-lg">
                    ✓ עדכון בקטלוג המשותף
                  </button>
                  <button onClick={() => dismissCorrection(g)} className="px-3 text-xs text-[#8A7F66] underline">
                    התעלמות
                  </button>
                </div>
              </div>
            ))}
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
        </React.Fragment>
        )}

        {isEditorOrAdmin && (
          <div>
            <h2 className="text-lg mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>ניהול רשתות אונליין</h2>
            <p className="text-xs text-[#8A7F66] mb-3">
              רשתות עם סניף אונליין ידוע (נמצא בקובץ המחירים הרגיל שלהן), ופרטי המשלוח שלהן.
            </p>
            <div className="flex flex-col gap-2 mb-3">
              {Object.keys(onlineVendors).length === 0 && (
                <div className="text-[#8A7F66] text-sm">לא הוגדרו עדיין רשתות אונליין</div>
              )}
              {Object.entries(onlineVendors).map(([vendor, cfg]) => (
                <div key={vendor} className={"rounded-xl px-3 py-2.5 border " + (cfg.active !== false ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-white border-[#E0D4B4]")}>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-[#2B2418] text-right min-w-0 font-semibold">{vendorLabel(vendor)}</span>
                    <button onClick={() => startEditOnlineVendor(vendor, cfg)} className="w-7 h-7 flex items-center justify-center text-[#A79A7C] text-sm flex-shrink-0">✏️</button>
                    <button onClick={() => setConfirmDeleteOnlineVendor(vendor)} className="w-7 h-7 flex items-center justify-center text-[#B8462F] text-base flex-shrink-0">🗑️</button>
                  </div>
                  <div className="text-[11px] text-[#A79A7C] mt-1">
                    סניף {cfg.branchId} · משלוח ₪{cfg.deliveryFee} · מינימום ₪{cfg.minimumOrder}
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-white border border-[#E0D4B4] rounded-xl p-3 space-y-2">
              <div className="text-xs font-semibold text-[#8A7F66]">{newOnlineVendorDraft.vendor ? `עריכת ${vendorLabel(newOnlineVendorDraft.vendor)}` : "רשת אונליין חדשה"}</div>
              <select value={newOnlineVendorDraft.vendor} disabled={!!onlineVendors[newOnlineVendorDraft.vendor]}
                onChange={e => setNewOnlineVendorDraft(prev => Object.assign({}, prev, { vendor: e.target.value }))}
                className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none disabled:bg-[#F7F2E4]">
                <option value="">בחירת רשת...</option>
                {VENDOR_LIST.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
              <input value={newOnlineVendorDraft.branchId} onChange={e => setNewOnlineVendorDraft(prev => Object.assign({}, prev, { branchId: e.target.value }))}
                placeholder="מספר הסניף האונליין (מקובץ המחירים)"
                className="w-full border border-[#C7B78E] rounded-lg px-3 py-2.5 text-right bg-white outline-none text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-[#8A7F66] block mb-1">משלוח (₪)</label>
                  <input type="number" value={newOnlineVendorDraft.deliveryFee} onChange={e => setNewOnlineVendorDraft(prev => Object.assign({}, prev, { deliveryFee: e.target.value }))}
                    className="w-full border border-[#C7B78E] rounded-lg px-2 py-2 text-center bg-white outline-none text-sm" />
                </div>
                <div>
                  <label className="text-[11px] text-[#8A7F66] block mb-1">מינימום (₪)</label>
                  <input type="number" value={newOnlineVendorDraft.minimumOrder} onChange={e => setNewOnlineVendorDraft(prev => Object.assign({}, prev, { minimumOrder: e.target.value }))}
                    className="w-full border border-[#C7B78E] rounded-lg px-2 py-2 text-center bg-white outline-none text-sm" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={saveOnlineVendor} disabled={savingOnlineVendor}
                  className="flex-1 bg-[#2E4A3B] text-[#FBF4E7] py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40">
                  {savingOnlineVendor ? <Spinner /> : "שמירה"}
                </button>
                {newOnlineVendorDraft.vendor && (
                  <button onClick={resetOnlineVendorDraft} className="px-4 rounded-lg border border-[#DECBA1] text-[#8A7F66] text-sm">ביטול</button>
                )}
              </div>
            </div>
          </div>
        )}

        {role === "admin" && (
          <div>
            <h2 className="text-lg mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>ניהול משתמשים</h2>
            <p className="text-xs text-[#8A7F66] mb-3">כל המשתמשים הרשומים, התפקיד שלהם וזמן ההתחברות האחרון</p>
            <div className="flex flex-col gap-2">
              {allUsers === null && <div className="text-[#8A7F66] text-sm">טוען...</div>}
              {allUsers && allUsers.map(u => (
                <div key={u.id} className="bg-white border border-[#E0D4B4] rounded-xl px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#2B2418] truncate">{u.displayName || u.email || u.id}</div>
                      {u.displayName && u.email && <div className="text-[11px] text-[#A79A7C] truncate">{u.email}</div>}
                    </div>
                    <select value={u.role || "user"} disabled={u.id === uid}
                      onChange={e => changeUserRole(u.id, e.target.value)}
                      className="text-xs border border-[#C7B78E] rounded-lg px-2 py-1.5 bg-white outline-none disabled:opacity-50 flex-shrink-0">
                      <option value="user">משתמש</option>
                      <option value="editor">עורך</option>
                      <option value="admin">מנהל</option>
                    </select>
                  </div>
                  <div className="text-[11px] text-[#A79A7C] mt-1">
                    התחברות אחרונה: {formatRelativeUpdatedAt(u.lastLoginAt?.toMillis?.(), "מעולם לא התחבר")}
                  </div>
                  {(userStats[u.id]?.costThisMonth > 0 || userStats[u.id]?.callsToday > 0) && (
                    <div className="text-[11px] text-[#8A5A15] mt-0.5">
                      עלות AI החודש: ${(userStats[u.id]?.costThisMonth || 0).toFixed(4)} · קריאות היום: {userStats[u.id]?.callsToday || 0}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
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
      {confirmDeleteOnlineVendor && (
        <ConfirmDialog message={`להסיר את ${vendorLabel(confirmDeleteOnlineVendor)} מרשתות הקנייה האונליין?`}
          onConfirm={() => deleteOnlineVendor(confirmDeleteOnlineVendor)} onClose={() => setConfirmDeleteOnlineVendor(null)} />
      )}

      {toast && <Toast msg={toast} />}
    </div>
  );
}

// ── BROWSE BY CATEGORY (add item without knowing its exact name) ───────────
// category -> (subcategory, if any are defined) -> matching items from the
// active vendors, straight from the shared productCategories/subcategory
// backfill. A plain chevron drawn as SVG for "back" — see BackButton's own
// comment: a "‹" text glyph gets silently flipped by RTL bidi mirroring.
function BrowseChevron() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function CategoryBrowseModal({ categories, activeProfiles, onInsert, onClose, showToast }) {
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedSub, setSelectedSub] = useState(null); // {id,label} | "ALL" | null
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [addedBarcodes, setAddedBarcodes] = useState({});
  // One item being assembled across vendors — same model as the name-search
  // step: checking a result claims it for every vendor it's sold at: once a
  // vendor is claimed, any other result also sold there is blocked, but a
  // vendor not yet covered stays open for a different result (a different
  // barcode at another vendor for "the same" product).
  const [draftItem, setDraftItem] = useState({ name: null, unit: null, barcodes: {}, matchedNames: {} });
  const [resultsQuery, setResultsQuery] = useState("");
  const [subStageQuery, setSubStageQuery] = useState("");

  const subs = (selectedCat && selectedCat.subcategories) || [];
  const stage = !selectedCat ? "categories" : (selectedSub === null && subs.length > 0) ? "subcategories" : "results";

  // Debounced so every keystroke doesn't fire its own call — the search
  // scans the whole category/subcategory server-side (not just whatever's
  // already loaded), since limiting a text search to the first 200 loaded
  // barcodes silently missed real matches sitting past that cutoff in a
  // large category (found via a real report — "עוף טוב" existed but wasn't
  // in that initial batch, so filtering it client-side found nothing even
  // though it's a completely real product).
  const searchDebounceRef = useRef(null);
  useEffect(() => () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); }, []);

  function load(cat, subLabel, nameFilter) {
    setLoading(true);
    setItems(null);
    const profileIds = (activeProfiles || []).map(p => p.id);
    fns.httpsCallable("browseCategoryItems", { timeout: 30000 })({ category: cat.label, subcategory: subLabel, profileIds, nameFilter: nameFilter || undefined }).then(res => {
      setItems(res.data.items || []);
      setTruncated(!!res.data.truncated);
      setLoading(false);
    }, () => { setLoading(false); setItems([]); showToast("שגיאה בטעינה"); });
  }
  function pickCategory(cat) {
    setSelectedCat(cat);
    setSelectedSub(null);
    setItems(null);
    setSubStageQuery("");
    setResultsQuery("");
    if ((cat.subcategories || []).length === 0) load(cat, null);
  }
  function pickSub(sub) {
    setSelectedSub(sub);
    setResultsQuery("");
    load(selectedCat, sub === "ALL" ? null : sub.label);
  }
  // Not sure which subcategory a product falls under (e.g. "מילקי" — dairy?
  // yogurt?) — searching here loads the whole category (same as "כל
  // הקטגוריה") pre-filtered by what was typed, so it reads as one search
  // instead of two separate steps.
  function searchWholeCategory() {
    const q = subStageQuery.trim();
    if (!q) return;
    setSelectedSub("ALL");
    setResultsQuery(q);
    load(selectedCat, null, q);
  }
  function onResultsQueryChange(v) {
    setResultsQuery(v);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      load(selectedCat, selectedSub === "ALL" ? null : (selectedSub && selectedSub.label), v.trim());
    }, 450);
  }
  function back() {
    if (stage === "results") {
      if (subs.length > 0) { setSelectedSub(null); setItems(null); } else { setSelectedCat(null); }
      return;
    }
    if (stage === "subcategories") { setSelectedCat(null); return; }
    onClose();
  }
  // One checkbox per item, not per vendor — same as the name-search flow,
  // where checking a candidate picks it for every vendor that carries it at
  // once, rather than choosing vendors individually.
  function vendorsCoveredByResult(it) {
    return Object.keys(it.prices || {}).filter(v => it.prices[v] != null);
  }
  function toggleItem(it) {
    const vendorsForIt = vendorsCoveredByResult(it);
    if (vendorsForIt.length === 0) return;
    const isChecked = vendorsForIt.every(v => draftItem.barcodes[v] === it.barcode);
    setDraftItem(prev => {
      const nb = Object.assign({}, prev.barcodes);
      const nn = Object.assign({}, prev.matchedNames);
      if (isChecked) {
        vendorsForIt.forEach(v => { if (nb[v] === it.barcode) { delete nb[v]; delete nn[v]; } });
      } else {
        vendorsForIt.forEach(v => { nb[v] = it.barcode; nn[v] = it.name; });
      }
      const hasAny = Object.keys(nb).length > 0;
      return { name: hasAny ? (prev.name || it.name) : null, unit: hasAny ? (prev.unit || it.unit) : null, barcodes: nb, matchedNames: nn };
    });
  }
  const draftVendorCount = Object.keys(draftItem.barcodes).length;
  function commitDraftItem() {
    const payload = {
      name: draftItem.name, category: selectedCat.label, categoryEmoji: selectedCat.emoji,
      quantity: 1, unit: draftItem.unit || "יחידות", note: "", barcodes: draftItem.barcodes, matchedNames: draftItem.matchedNames,
    };
    // Everything here — the "added" toast, marking these barcodes as
    // committed, the category-confirmation calls — waits for the caller's
    // done() rather than firing immediately: when this is opened from Home
    // with no list chosen yet (FindItemModal), the actual write is deferred
    // until the user picks a destination, so saying "added" any earlier
    // would lie if they back out of that picker instead of completing it.
    const committed = draftItem;
    onInsert(payload, () => {
      const uniqueBarcodes = [...new Set(Object.values(committed.barcodes))];
      uniqueBarcodes.forEach(bc => {
        const vendorsForBc = Object.keys(committed.barcodes).filter(v => committed.barcodes[v] === bc);
        const matchedName = committed.matchedNames[vendorsForBc[0]] || committed.name;
        fns.httpsCallable("confirmItemBarcode")({ name: matchedName, barcode: bc, matchedName, vendors: vendorsForBc }).catch(() => {});
      });
      setAddedBarcodes(prev => {
        const next = Object.assign({}, prev);
        uniqueBarcodes.forEach(bc => { next[bc] = true; });
        return next;
      });
      showToast(`${committed.name} נוסף לרשימה`);
      setDraftItem({ name: null, unit: null, barcodes: {}, matchedNames: {} });
    });
  }

  const title = stage === "categories" ? "עיון לפי קטגוריה"
    : stage === "subcategories" ? `${selectedCat.emoji} ${selectedCat.label}`
    : `${selectedCat.emoji} ${selectedCat.label}` + (selectedSub && selectedSub !== "ALL" ? ` · ${selectedSub.label}` : "");

  return (
    <Modal onClose={onClose} closeLabel="סיום וחזרה לרשימה" footer={draftVendorCount > 0 && (
      <button onClick={commitDraftItem} className="w-full bg-[#2E4A3B] text-white py-3 rounded-xl font-semibold text-sm">
        הוספה לרשימה ({draftVendorCount}/{(activeProfiles || []).length} רשתות)
      </button>
    )}>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={back} className="text-[#8A7F66] w-8 h-8 -mr-1 flex items-center justify-center flex-shrink-0">
          <BrowseChevron />
        </button>
        <h3 className="flex-1 text-base font-medium text-[#2B2418] truncate">{title}</h3>
      </div>

      {stage === "categories" && (
        <div className="grid grid-cols-2 gap-2">
          {categories.map(cat => (
            <button key={cat.id} onClick={() => pickCategory(cat)}
              className="flex items-center gap-2 bg-white border border-[#E0D4B4] rounded-xl px-3 py-3 text-right hover:bg-[#FBF4E7]">
              <span className="text-xl">{cat.emoji}</span>
              <span className="text-sm text-[#2B2418] leading-tight">{categoryHeaderLabel(cat.label)}</span>
            </button>
          ))}
        </div>
      )}

      {stage === "subcategories" && (
        <div>
          <div className="flex gap-2 mb-3">
            <input value={subStageQuery} onChange={e => setSubStageQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") searchWholeCategory(); }}
              placeholder="לא בטוחים באיזו תת-קטגוריה? חפשו שם..."
              className="flex-1 min-w-0 border border-[#C7B78E] bg-white rounded-xl px-3 py-2 text-sm outline-none" />
            <button onClick={searchWholeCategory} disabled={!subStageQuery.trim()}
              className="px-4 rounded-xl bg-[#2E4A3B] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0">חיפוש</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => pickSub("ALL")}
              className="bg-[#F3ECD9] rounded-full px-3 py-1.5 text-sm text-[#2B2418] hover:bg-[#EADFC0]">כל הקטגוריה</button>
            {subs.map(sub => (
              <button key={sub.id} onClick={() => pickSub(sub)}
                className="bg-[#F3ECD9] rounded-full px-3 py-1.5 text-sm text-[#2B2418] hover:bg-[#EADFC0]">{sub.label}</button>
            ))}
          </div>
        </div>
      )}

      {stage === "results" && (
        <div className="space-y-2">
          <input value={resultsQuery} onChange={e => onResultsQueryChange(e.target.value)} placeholder="חיפוש לפי שם..."
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-3 py-2 text-sm outline-none" />
          <p className="text-[11px] text-[#8A7F66]">סמנו התאמה מכל רשת בנפרד — הכל יתמזג לפריט אחד; רשת שכבר נבחרה תיחסם מבחירות אחרות.</p>
          {loading ? (
            <div className="py-8 px-4"><div className="sz-progress-track"><div className="sz-progress-bar" /></div></div>
          ) : (
          <React.Fragment>
            {truncated && (
              <p className="text-[11px] text-[#8A5A15] bg-[#FBF0D9] border border-[#E9D8A6] rounded-lg px-2.5 py-1.5">
                מוצגות עד 200 תוצאות — לרשימה מלאה יותר נסו לבחור תת-קטגוריה
              </p>
            )}
            <div className="space-y-2 max-h-[52vh] overflow-y-auto">
            {items.length === 0 ? (
              resultsQuery.trim() ? (
                <p className="text-center text-[#A79A7C] text-sm py-6">{`אין תוצאות ל"${resultsQuery}"`}</p>
              ) : (
                <p className="text-center text-[#A79A7C] text-sm py-6">עדיין אין פריטים מסווגים בקטגוריה הזו מהרשתות הפעילות שלכם</p>
              )
            ) : items.map(it => {
              const vendorIds = (activeProfiles || []).map(p => p.vendor);
              const added = !!addedBarcodes[it.barcode];
              const vendorsForIt = vendorsCoveredByResult(it);
              const isChecked = vendorsForIt.length > 0 && vendorsForIt.every(v => draftItem.barcodes[v] === it.barcode);
              const blocked = !added && !isChecked && vendorsForIt.some(v => draftItem.barcodes[v] && draftItem.barcodes[v] !== it.barcode);
              return (
                <div key={it.barcode} onClick={() => !added && !blocked && toggleItem(it)}
                  className={"rounded-xl px-3 py-2.5 border " +
                    (added ? "bg-white border-[#B9D9B0] opacity-60" : blocked ? "bg-[#F7F2E4] border-[#E5D8B5] opacity-45 cursor-default" : isChecked ? "bg-[#EEF5EC] border-[#B9D9B0] cursor-pointer" : "bg-white border-[#E5D8B5] cursor-pointer")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#2B2418]">{it.name}</div>
                      <div className="text-[11px] text-[#A79A7C] mt-0.5">
                        ברקוד {it.barcode}{it.unit ? ` · ${it.unit}` : ""}
                      </div>
                    </div>
                    {added ? (
                      <span className="text-xs font-bold text-[#2E7D4F] flex-shrink-0">✓ נוסף</span>
                    ) : blocked ? (
                      <span className="text-[10px] text-[#A79A7C] flex-shrink-0">כבר נבחר</span>
                    ) : (
                      <span className={"w-5 h-5 rounded-[5px] border-2 flex-shrink-0 flex items-center justify-center text-[11px] font-bold leading-none " +
                        (isChecked ? "bg-[#2E4A3B] border-[#2E4A3B] text-white" : "border-[#DECBA1] text-transparent")}>✓</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {vendorIds.map(v => {
                      const price = it.prices ? it.prices[v] : null;
                      const others = vendorIds.filter(o => o !== v).map(o => (it.prices ? it.prices[o] : null)).filter(x => x != null);
                      return (
                        <span key={v} className={"text-[11px] rounded px-2 py-0.5 " + cheapestBadgeClass(price, others)}>
                          {vendorLabel(v)}: {price != null ? "₪" + price.toFixed(2) : "לא נמכר כאן"}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            </div>
          </React.Fragment>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── FIND ITEM (search by name/category, no list open yet) ────────────────────
// The same "add item" mechanism used inside an open list — ItemWizard and
// CategoryBrowseModal are reused here completely unchanged. Searching only
// needs a mode (regular/online, to know which vendors to match against),
// never a list — a list is only asked for at the moment of actually adding
// something, exactly once per sitting (picked lazily, then reused for
// every further add), so "just checking a price" never has to detour
// through picking a list at all. This replaces the old standalone
// "בדיקת מחיר": searching and seeing prices without committing still
// works, it's simply not tapping the final add button, rather than being
// a separate mode. A barcode-photo search mode is planned as a third
// option alongside "לפי שם"/"עיון לפי קטגוריה" below — not built yet,
// flagged here so it isn't lost: Eitan asked to remember it for a later
// version (2026-09-05).
function FindItemModal({ uid, categories, onClose, showToast }) {
  const allActiveProfiles = useActiveVendorProfiles(uid);
  // Which vendors count depends on whether this search is for a regular
  // (in-store) or online buy — remembered per account rather than asked
  // every time, since most people mostly shop one way and rarely switch.
  const [mode, setMode] = useState("instore");
  const [modeLoaded, setModeLoaded] = useState(false);
  const [method, setMethod] = useState(null); // null | "byName" | "byCategory"
  const [destList, setDestList] = useState(null); // { id, name } | null — resolved once, then reused for the rest of this sitting
  const [pendingInsert, setPendingInsert] = useState(null); // { payload, done } while the list-picker overlay is open
  const [myLists, setMyLists] = useState(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [savingNewList, setSavingNewList] = useState(false);
  const [allProfiles, setAllProfiles] = useState(null); // active + inactive — needed by provisionOnlineVendorProfiles
  const onlineVendors = useOnlineVendors();

  useEffect(() => {
    db.collection("users").doc(uid).get().then(snap => {
      if ((snap.data() || {}).checkPriceMode === "online") setMode("online");
      setModeLoaded(true);
    }, () => setModeLoaded(true));
    // eslint-disable-next-line
  }, [uid]);

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setDestList(null); // a list picked under the old mode may not even be the right kind
    setMyLists(null);
    db.collection("users").doc(uid).update({ checkPriceMode: next }).catch(() => {});
  }

  useEffect(() => db.collection("users").doc(uid).collection("vendorProfiles")
    .onSnapshot(snap => setAllProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })))), [uid]);

  // Picking (or creating) an online list here is the only way to reach one
  // without ever opening ListScreen, which is normally what auto-
  // provisions its "premade" online vendor list on first open — do the
  // same thing here so items can actually price-match right away instead
  // of showing zero active vendors until the list happens to be opened.
  useEffect(() => {
    if (mode !== "online") return;
    provisionOnlineVendorProfiles(uid, onlineVendors, allProfiles, showToast);
    // eslint-disable-next-line
  }, [mode, allProfiles, JSON.stringify(onlineVendors)]);

  function openListPicker() {
    if (myLists === null) {
      db.collection("lists").where("ownerId", "==", uid).get().then(snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => (l.mode || "instore") === mode);
        rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        setMyLists(rows);
      });
    }
  }

  function writeToList(listId, payload, done) {
    db.collection("lists").doc(listId).collection("items").add(Object.assign({}, payload, {
      addedBy: uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    })).then(() => done());
  }

  // The shared onInsert passed to ItemWizard/CategoryBrowseModal: already
  // knows a list from an earlier add this sitting → write straight through;
  // otherwise stash the pending write and surface the list-picker overlay.
  function handleInsert(payload, done) {
    if (destList) { writeToList(destList.id, payload, done); return; }
    setPendingInsert({ payload, done });
    openListPicker();
  }

  function useListForPending(listId, listName) {
    setDestList({ id: listId, name: listName });
    setCreatingNew(false);
    const p = pendingInsert;
    setPendingInsert(null);
    if (p) writeToList(listId, p.payload, p.done);
  }

  function createListAndUse() {
    const name = newListName.trim();
    if (!name || savingNewList) return;
    setSavingNewList(true);
    db.collection("lists").add({ name, ownerId: uid, mode, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).then(ref => {
      setSavingNewList(false);
      useListForPending(ref.id, name);
    }, () => { setSavingNewList(false); showToast("שגיאה ביצירת הרשימה"); });
  }

  const activeProfiles = allActiveProfiles.filter(p => (p.mode || "instore") === mode);

  const listPickerOverlay = pendingInsert && (
    <Modal onClose={() => setPendingInsert(null)}>
      <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הוספה לאיזו רשימה?</h3>
      {creatingNew ? (
        <div className="space-y-3">
          <input autoFocus value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="שם הרשימה החדשה"
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none" />
          <button onClick={createListAndUse} disabled={!newListName.trim() || savingNewList}
            className="w-full py-3 rounded-2xl bg-[#2E4A3B] text-white font-semibold text-sm disabled:opacity-40">
            {savingNewList ? <Spinner /> : "צור והוסף"}
          </button>
          <button onClick={() => setCreatingNew(false)} className="w-full text-xs text-[#8A7F66] underline">ביטול</button>
        </div>
      ) : (
        <div className="space-y-2">
          <button onClick={() => setCreatingNew(true)}
            className="w-full text-right rounded-xl px-3 py-2.5 bg-[#EEF5EC] border border-[#B9D9B0] text-sm font-medium text-[#2E4A3B]">
            + רשימה חדשה
          </button>
          {myLists === null ? (
            <div className="flex justify-center py-6"><Spinner2 /></div>
          ) : myLists.length === 0 ? (
            <p className="text-center text-[#A79A7C] text-sm py-4">אין לך רשימות מסוג זה עדיין</p>
          ) : myLists.map(l => (
            <button key={l.id} onClick={() => useListForPending(l.id, l.name)}
              className="w-full text-right rounded-xl px-3 py-2.5 bg-[#F7F2E4] text-sm">
              {l.name}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );

  if (method === "byName") {
    return <React.Fragment>
      <ItemWizard uid={uid} mode="add" categories={categories} activeProfiles={activeProfiles}
        onInsert={handleInsert} onClose={() => setMethod(null)} showToast={showToast} />
      {listPickerOverlay}
    </React.Fragment>;
  }
  if (method === "byCategory") {
    return <React.Fragment>
      <CategoryBrowseModal categories={categories} activeProfiles={activeProfiles}
        onInsert={handleInsert} onClose={() => setMethod(null)} showToast={showToast} />
      {listPickerOverlay}
    </React.Fragment>;
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg text-center mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>חיפוש והוספת פריט</h3>
      <p className="text-xs text-[#8A7F66] text-center mb-4">
        {destList ? <React.Fragment>מוסיפים ל"{destList.name}" · <button onClick={() => setDestList(null)} className="underline font-semibold">שינוי</button></React.Fragment>
          : "רשימת היעד תיבחר כשתלחצו להוסיף"}
      </p>
      <div className="flex bg-[#F3ECD9] rounded-full p-0.5 mb-4">
        <button onClick={() => switchMode("instore")}
          className={"flex-1 text-xs px-3 py-1.5 rounded-full font-bold transition " + (mode === "instore" ? "bg-[#2E4A3B] text-[#FBF4E7]" : "text-[#8A7F66]")}>
          רגיל
        </button>
        <button onClick={() => switchMode("online")}
          className={"flex-1 text-xs px-3 py-1.5 rounded-full font-bold transition " + (mode === "online" ? "bg-[#2E4A3B] text-[#FBF4E7]" : "text-[#8A7F66]")}>
          אונליין
        </button>
      </div>
      {!modeLoaded ? (
        <div className="flex justify-center py-6"><Spinner2 /></div>
      ) : (
        <div className="space-y-2">
          <button onClick={() => setMethod("byName")}
            className="w-full text-right flex items-center gap-3 px-4 py-3.5 rounded-xl border border-[#E0D4B4] bg-white hover:bg-[#FBF4E7]">
            <span className="text-xl">🔎</span>
            <span>
              <div className="text-sm font-semibold text-[#2B2418]">לפי שם</div>
              <div className="text-[11px] text-[#8A7F66]">מקלידים שם ובוחרים התאמה</div>
            </span>
          </button>
          <button onClick={() => setMethod("byCategory")}
            className="w-full text-right flex items-center gap-3 px-4 py-3.5 rounded-xl border border-[#E0D4B4] bg-white hover:bg-[#FBF4E7]">
            <span className="text-xl">📂</span>
            <span>
              <div className="text-sm font-semibold text-[#2B2418]">עיון לפי קטגוריה</div>
              <div className="text-[11px] text-[#8A7F66]">כשלא בטוחים בשם המדויק</div>
            </span>
          </button>
        </div>
      )}
    </Modal>
  );
}

// ── VENDOR VISIBILITY ─────────────────────────────────────────────────────────
// Per-list display filter: hiding a vendor here only affects what THIS list
// shows — matching/pricing keeps running for it in the background so
// un-hiding it later doesn't need a fresh search.
function VendorVisibilityModal({ uid, listMode, activeProfiles, hiddenVendorIds, onToggle, onClose, showToast }) {
  const [catalogTimestamps, setCatalogTimestamps] = useState({}); // { profileId: updatedAt|null }

  useEffect(() => {
    fns.httpsCallable("getActiveCatalogTimestamps")({}).then(res => {
      const map = {};
      (res.data.timestamps || []).forEach(t => { map[t.id] = t.updatedAt; });
      setCatalogTimestamps(map);
    }).catch(() => {});
  }, []);

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg text-center mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>רשתות מוצגות</h3>
      <p className="text-xs text-[#8A7F66] text-center mb-4">בחרו אילו רשתות להציג ברשימה הזו</p>
      <div className="space-y-1.5">
        {(activeProfiles || []).length === 0 && (
          <p className="text-center text-[#A79A7C] text-sm py-4">אין רשתות פעילות</p>
        )}
        {(activeProfiles || []).map(p => {
          const isVisible = hiddenVendorIds.indexOf(p.id) === -1;
          return (
            <div key={p.id} className="rounded-xl px-3 py-2.5 bg-[#F7F2E4]">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#2B2418]">{profileLabel(p, activeProfiles)}</span>
                <button onClick={() => onToggle(p.id)}
                  className={"text-xs font-bold rounded-full px-3 py-1 " + (isVisible ? "text-[#256A3F] bg-[#DDEEDA]" : "text-[#8A7F66] bg-[#EFE4C6]")}>
                  {isVisible ? "מוצג" : "מוסתר"}
                </button>
              </div>
              <div className="text-[11px] text-[#A79A7C] mt-1">עודכן לאחרונה: {formatRelativeUpdatedAt(catalogTimestamps[p.id])}</div>
            </div>
          );
        })}
      </div>
      {listMode !== "online" && (
        <div className="mt-4 pt-4 border-t border-[#E5D8B5]">
          <AddBranchWidget uid={uid} existingProfiles={activeProfiles} showToast={showToast} />
        </div>
      )}
      <button onClick={onClose} className="w-full mt-4 py-3 rounded-2xl bg-[#2E4A3B] text-white font-semibold text-sm">סגירה</button>
    </Modal>
  );
}

// ── COPY ITEMS TO ANOTHER LIST ────────────────────────────────────────────────
function CopyItemsModal({ uid, sourceListId, sourceMode, items, categories, onClose, showToast }) {
  const [step, setStep] = useState("pick");
  const [selectedIds, setSelectedIds] = useState({});
  const [myLists, setMyLists] = useState(null);
  const [newListMode, setNewListMode] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [busy, setBusy] = useState(false);

  const groups = groupByCategory(items, categories);
  const selectedCount = Object.keys(selectedIds).filter(id => selectedIds[id]).length;

  function toggleSelect(id) {
    setSelectedIds(prev => Object.assign({}, prev, { [id]: !prev[id] }));
  }

  function goToDest() {
    if (selectedCount === 0) return;
    setStep("dest");
    if (myLists === null) {
      db.collection("lists").where("ownerId", "==", uid).get().then(snap => {
        // A physical-branch list and an online list never share vendor
        // profiles, so an item copied across modes would arrive unmatched —
        // only offer destinations of the same mode as the list it's coming from.
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(l => l.id !== sourceListId && (l.mode || "instore") === sourceMode);
        rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        setMyLists(rows);
      });
    }
  }

  function copyToList(destId) {
    if (busy) return;
    setBusy(true);
    const batch = db.batch();
    const now = Date.now();
    let i = 0;
    items.filter(it => selectedIds[it.id]).forEach(it => {
      const copy = Object.assign({}, it);
      delete copy.id;
      copy.addedBy = uid;
      copy.addedAt = firebase.firestore.Timestamp.fromMillis(now + (i++));
      const ref = db.collection("lists").doc(destId).collection("items").doc();
      batch.set(ref, copy);
    });
    batch.commit().then(() => {
      setBusy(false);
      showToast(selectedCount + " פריטים הועתקו");
      onClose();
    }, () => { setBusy(false); showToast("שגיאה בהעתקה"); });
  }

  function createListAndCopy() {
    const name = newListName.trim();
    if (!name || busy) return;
    setBusy(true);
    db.collection("lists").add({ name, ownerId: uid, mode: sourceMode, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).then(ref => {
      copyToList(ref.id);
    }, () => { setBusy(false); showToast("שגיאה ביצירת הרשימה"); });
  }

  return (
    <Modal onClose={onClose}>
      {step === "pick" ? (
        <React.Fragment>
          <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>בחר פריטים להעתקה</h3>
          <div className="space-y-4 max-h-[50vh] overflow-y-auto">
            {groups.map(group => (
              <div key={group.label}>
                <div className="text-xs font-semibold text-[#8A9A72] mb-1 flex items-center gap-1.5">
                  <span>{group.emoji}</span><span>{categoryHeaderLabel(group.label)}</span>
                </div>
                <div className="space-y-1">
                  {group.items.map(item => {
                    const checked = !!selectedIds[item.id];
                    return (
                      <button key={item.id} onClick={() => toggleSelect(item.id)}
                        className={"w-full text-right flex items-center justify-between gap-2 rounded-xl px-3 py-2 border " + (checked ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-[#F7F2E4] border-transparent")}>
                        <span className="text-sm text-[#2B2418] truncate">{itemDisplayName(item)}</span>
                        <span className={"w-5 h-5 rounded-full border flex-shrink-0 flex items-center justify-center text-xs " + (checked ? "bg-[#2E4A3B] border-[#2E4A3B] text-white" : "border-[#DECBA1] text-transparent")}>✓</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {items.length === 0 && <p className="text-center text-[#A79A7C] text-sm py-6">הרשימה ריקה</p>}
          </div>
          <button onClick={goToDest} disabled={selectedCount === 0}
            className="w-full mt-4 py-3 rounded-2xl bg-[#2E4A3B] text-white font-semibold text-sm disabled:opacity-40">
            המשך ({selectedCount})
          </button>
        </React.Fragment>
      ) : (
        <React.Fragment>
          <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>העתק {selectedCount} פריטים אל</h3>
          {newListMode ? (
            <div className="space-y-3">
              <input autoFocus value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="שם הרשימה החדשה"
                className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none" />
              <button onClick={createListAndCopy} disabled={!newListName.trim() || busy}
                className="w-full py-3 rounded-2xl bg-[#2E4A3B] text-white font-semibold text-sm disabled:opacity-40">
                {busy ? <Spinner /> : "צור והעתק"}
              </button>
              <button onClick={() => setNewListMode(false)} className="w-full text-xs text-[#8A7F66] underline">ביטול</button>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={() => setNewListMode(true)}
                className="w-full text-right rounded-xl px-3 py-2.5 bg-[#EEF5EC] border border-[#B9D9B0] text-sm font-medium text-[#2E4A3B]">
                + רשימה חדשה
              </button>
              {myLists === null ? (
                <div className="flex justify-center py-6"><Spinner2 /></div>
              ) : myLists.length === 0 ? (
                <p className="text-center text-[#A79A7C] text-sm py-4">אין רשימות נוספות</p>
              ) : myLists.map(l => (
                <button key={l.id} onClick={() => copyToList(l.id)} disabled={busy}
                  className="w-full text-right rounded-xl px-3 py-2.5 bg-[#F7F2E4] text-sm disabled:opacity-40">
                  {l.name}
                </button>
              ))}
            </div>
          )}
        </React.Fragment>
      )}
    </Modal>
  );
}

// ── SHOPPING OPTIMIZER ────────────────────────────────────────────────────────
// Best split of the list's items across 1..3 of the currently displayed
// vendors. Small numbers only (capped at 3 of however many vendors are
// displayed), so plain enumeration of every combo is exact and fast — no
// real optimizer needed. Never touches the original list; only writes
// anything if the user picks a plan and asks to create lists from it.
function OptimizerModal({ uid, list, items, visibleProfiles, activeProfiles, onlineVendors, priceMap, promoMap, pricesLoading, onClose, onHome, showToast }) {
  const [plans, setPlans] = useState(null);
  const [selectedK, setSelectedK] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createdCount, setCreatedCount] = useState(null);
  const [orderVendor, setOrderVendor] = useState(null); // { vendor, entries } | null
  const isOnline = list.mode === "online";
  // A ref, not state — opening this modal before prices have finished
  // loading must NOT get stuck showing an all-₪0 result computed from an
  // empty priceMap; recomputing once real prices arrive is the fix. The
  // ref (not a dependency-driven re-select) keeps the auto-pick from
  // fighting a plan the user already chose by hand if prices refresh again
  // later while the modal is still open.
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    // Prices load asynchronously after the list screen mounts — computing
    // a plan against a still-empty priceMap marked every item "missing"
    // and every total ₪0.00. Wait for the real fetch to finish instead.
    if (pricesLoading) return;
    const pool = visibleProfiles;
    const maxK = Math.min(3, pool.length);
    const computed = [];
    for (let k = 1; k <= maxK; k++) {
      const combos = combinations(pool, k);
      let best = null;
      combos.forEach(combo => {
        let itemsCost = 0;
        const missingItems = [];
        const byVendor = {};
        combo.forEach(p => { byVendor[p.id] = []; });
        items.forEach(item => {
          const priced = itemProfilePrices(item, combo, priceMap, promoMap);
          if (priced.length === 0) { missingItems.push(item.name); return; }
          const bestEntry = priced.reduce((acc, e) => {
            const eff = (e.promo && e.promo.active) ? e.promo.price : e.price;
            const accEff = (acc.promo && acc.promo.active) ? acc.promo.price : acc.price;
            return eff < accEff ? e : acc;
          });
          const effPrice = (bestEntry.promo && bestEntry.promo.active) ? bestEntry.promo.price : bestEntry.price;
          itemsCost += effPrice * (item.quantity || 1);
          byVendor[bestEntry.profile.id].push({ item, price: effPrice });
        });
        // Delivery is per vendor actually used in this combo (a vendor with
        // no items assigned to it in this split contributes nothing) — the
        // "fewer stores wins unless splitting saves more" ranking below
        // falls out on its own once delivery is folded into the same total,
        // since a 2-store split now has to beat two delivery fees, not zero.
        let deliveryCost = 0;
        const belowMinimum = [];
        if (isOnline) {
          combo.forEach(p => {
            const vendorItems = byVendor[p.id];
            if (!vendorItems || vendorItems.length === 0) return;
            const cfg = onlineVendors[p.vendor] || {};
            deliveryCost += cfg.deliveryFee || 0;
            const subtotal = vendorItems.reduce((s, e) => s + e.price * (e.item.quantity || 1), 0);
            if (cfg.minimumOrder && subtotal < cfg.minimumOrder) {
              belowMinimum.push({ profile: p, subtotal, minimumOrder: cfg.minimumOrder });
            }
          });
        }
        const totalCost = itemsCost + deliveryCost;
        if (!best || missingItems.length < best.missingItems.length ||
            (missingItems.length === best.missingItems.length && totalCost < best.totalCost)) {
          best = { k, vendors: combo, itemsCost, deliveryCost, totalCost, missingItems, byVendor, belowMinimum };
        }
      });
      if (best) computed.push(best);
    }
    setPlans(computed);
    // Auto-expand the recommended plan (fewest missing items, then
    // cheapest) so its per-vendor breakdown — and, for an online list, the
    // "מעבר להזמנה" hand-off — is visible immediately instead of requiring
    // an extra tap to open a plan card first. Only the first time: if
    // prices refresh again later while the modal is open, this must not
    // yank a plan the user already picked by hand back to the "best" one.
    if (!autoSelectedRef.current && computed.length > 0) {
      const recommended = computed.reduce((acc, p) =>
        (!acc || p.missingItems.length < acc.missingItems.length ||
          (p.missingItems.length === acc.missingItems.length && p.totalCost < acc.totalCost)) ? p : acc, null);
      setSelectedK(recommended.k);
      autoSelectedRef.current = true;
    }
    // eslint-disable-next-line
  }, [pricesLoading, items, visibleProfiles, onlineVendors, isOnline, JSON.stringify(priceMap), JSON.stringify(promoMap)]);

  function createListsFromPlan(plan) {
    setCreating(true);
    const now = Date.now();
    // Each new list's items reference it via a security rule get() on the
    // parent doc, so the parent must actually be committed first — a single
    // batch with both isn't guaranteed to see its own sibling write.
    const toCreate = plan.vendors
      .map(p => ({ profile: p, vendorItems: plan.byVendor[p.id] || [] }))
      .filter(x => x.vendorItems.length > 0);
    Promise.all(toCreate.map(x => {
      const hideIds = activeProfiles.filter(vp => vp.id !== x.profile.id).map(vp => vp.id);
      return db.collection("lists").add({
        name: list.name + " - " + profileLabel(x.profile, plan.vendors),
        ownerId: uid, mode: (list.mode || "instore"), hiddenVendorIds: hideIds,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }).then(ref => ({ ref, vendorItems: x.vendorItems }));
    })).then(created => {
      const batch = db.batch();
      created.forEach(({ ref, vendorItems }) => {
        vendorItems.forEach((entry, idx) => {
          const itemRef = ref.collection("items").doc();
          const copy = Object.assign({}, entry.item);
          delete copy.id;
          copy.addedBy = uid;
          copy.addedAt = firebase.firestore.Timestamp.fromMillis(now + idx);
          batch.set(itemRef, copy);
        });
      });
      return batch.commit().then(() => created.length);
    }).then(createdN => {
      setCreating(false);
      setCreatedCount(createdN);
    }, () => { setCreating(false); showToast("שגיאה ביצירת הרשימות"); });
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg text-center mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>אופטימיזציית קניות</h3>
      {createdCount != null ? (
        <div className="text-center py-4">
          <div className="text-4xl mb-3">✅</div>
          <p className="text-[#2B2418] font-medium mb-5">{createdCount} רשימות נוצרו!</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl border border-[#DECBA1] text-[#5B5749] font-medium text-sm">סגירה</button>
            <button onClick={() => { onClose(); onHome(); }} className="flex-1 bg-[#2E4A3B] text-white py-3 rounded-2xl font-semibold text-sm">🏠 לדף הבית</button>
          </div>
        </div>
      ) : (
        <React.Fragment>
          <p className="text-xs text-[#8A7F66] text-center mb-4">השוואת עלות קנייה במספר חנויות שונה — הרשימה המקורית לא משתנה</p>
          {plans === null ? (
            <div className="flex justify-center py-10"><Spinner2 /></div>
          ) : plans.length === 0 ? (
            <p className="text-center text-[#A79A7C] text-sm py-6">אין מספיק נתוני מחיר להשוואה</p>
          ) : (
            <div className="space-y-2">
              {plans.map(plan => {
                const isSelected = selectedK === plan.k;
                const vendorNames = plan.vendors.map(p => profileLabel(p, plan.vendors)).join(" + ");
                return (
                  <div key={plan.k}>
                    <button onClick={() => setSelectedK(isSelected ? null : plan.k)}
                      className={"w-full text-right rounded-xl px-4 py-3 border transition " + (isSelected ? "bg-[#EEF5EC] border-[#B9D9B0]" : "bg-white border-[#E5D8B5]")}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-[#2B2418] text-sm">{plan.k === 1 ? "חנות אחת" : plan.k + " חנויות"}</span>
                        <span className="font-bold text-[#2E4A3B] text-sm">₪{plan.totalCost.toFixed(2)}</span>
                      </div>
                      <div className="text-xs text-[#8A7F66] mt-1">{vendorNames}</div>
                      {isOnline && (
                        <div className="text-[11px] text-[#8A7F66] mt-0.5">
                          פריטים: ₪{plan.itemsCost.toFixed(2)} + משלוח: ₪{plan.deliveryCost.toFixed(2)}
                        </div>
                      )}
                      {plan.missingItems.length > 0 && (
                        <div className="text-[11px] text-[#B8462F] mt-1">חסר: {plan.missingItems.join(", ")}</div>
                      )}
                      {isOnline && plan.belowMinimum.length > 0 && (
                        <div className="text-[11px] text-[#8A5A15] mt-1">
                          {plan.belowMinimum.map(b => `${vendorLabel(b.profile.vendor)}: מתחת למינימום הזמנה (₪${b.subtotal.toFixed(2)} מתוך ₪${b.minimumOrder})`).join(" · ")}
                        </div>
                      )}
                    </button>
                    {isSelected && (
                      <div className="mt-2 mb-1 space-y-2 px-1">
                        {plan.vendors.map(p => {
                          const vendorItems = plan.byVendor[p.id] || [];
                          if (vendorItems.length === 0) return null;
                          return (
                            <div key={p.id} className="bg-[#F7F2E4] rounded-xl p-2.5">
                              <div className="text-xs font-semibold text-[#5B5749] mb-1">{profileLabel(p, plan.vendors)} ({vendorItems.length})</div>
                              <div className="space-y-0.5">
                                {vendorItems.map(entry => (
                                  <div key={entry.item.id} className="flex items-center justify-between text-xs text-[#5B5749]">
                                    <span>{entry.item.name}</span>
                                    <span>₪{entry.price.toFixed(2)}</span>
                                  </div>
                                ))}
                                {isOnline && (onlineVendors[p.vendor] || {}).deliveryFee != null && (
                                  <div className="flex items-center justify-between text-xs text-[#8A7F66] pt-0.5 border-t border-[#E5D8B5] mt-1">
                                    <span>משלוח</span>
                                    <span>₪{(onlineVendors[p.vendor].deliveryFee).toFixed(2)}</span>
                                  </div>
                                )}
                              </div>
                              {isOnline && (
                                <button
                                  onClick={() => setOrderVendor({ vendor: p.vendor, entries: vendorItems.map(e => e.item) })}
                                  className="w-full mt-2 bg-white border border-[#B9D9B0] text-[#256A3F] py-2 rounded-lg text-xs font-semibold">
                                  🛒 מעבר להזמנה ב{vendorLabel(p.vendor)}
                                </button>
                              )}
                            </div>
                          );
                        })}
                        <button onClick={() => createListsFromPlan(plan)} disabled={creating}
                          className="w-full bg-[#2E4A3B] text-white py-2.5 rounded-xl font-medium text-sm disabled:opacity-40">
                          {creating ? <Spinner /> : "+ צור רשימות לפי התכנית"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </React.Fragment>
      )}
      {orderVendor && (
        <VendorOrderModal vendor={orderVendor.vendor} entries={orderVendor.entries} onClose={() => setOrderVendor(null)} />
      )}
    </Modal>
  );
}

// Hands an online plan's per-vendor sub-basket off to the vendor's own
// site: one button opens the vendor's site once (reliable everywhere,
// including an installed PWA on mobile, unlike opening a tab per item),
// and each item is a copy-to-clipboard row the user pastes into the
// vendor's own search there. Login, cart, address and payment happen
// entirely on the vendor's own site — nothing about them can be automated
// here (see VENDOR_ORDER_URL above for why).
function VendorOrderModal({ vendor, entries, onClose }) {
  const [copiedId, setCopiedId] = useState(null);
  const siteUrl = VENDOR_ORDER_URL[vendor];

  function copyName(item) {
    copyToClipboard(itemDisplayName(item)).then(() => {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg text-center mb-1" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>מעבר להזמנה ב{vendorLabel(vendor)}</h3>
      <p className="text-xs text-[#8A7F66] text-center mb-4">
        פתחו את אתר הרשת, ואז העתיקו כל שם פריט מכאן והדביקו בחיפוש שם. ההתחברות, הסל, הכתובת למשלוח והתשלום מתבצעים כולם באתר הרשת עצמו.
      </p>
      {siteUrl && (
        <a href={siteUrl} target="_blank" rel="noopener noreferrer"
          className="w-full flex items-center justify-center gap-2 bg-[#2E4A3B] text-white py-3 rounded-2xl font-semibold text-sm mb-4">
          🔗 פתיחת אתר {vendorLabel(vendor)}
        </a>
      )}
      <div className="space-y-1.5 max-h-[45vh] overflow-y-auto">
        {entries.map(item => (
          <button key={item.id} onClick={() => copyName(item)}
            className="w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 bg-[#F7F2E4] hover:bg-[#F0E9D4] text-right">
            <span className="text-sm text-[#2B2418]">{itemDisplayName(item)}</span>
            <span className={"text-xs font-bold flex-shrink-0 " + (copiedId === item.id ? "text-[#256A3F]" : "text-[#2E4A3B]")}>
              {copiedId === item.id ? "✓ הועתק" : "📋 העתקה"}
            </span>
          </button>
        ))}
      </div>
      <button onClick={onClose} className="w-full mt-4 py-3 rounded-2xl bg-[#2E4A3B] text-white font-semibold text-sm">סגירה</button>
    </Modal>
  );
}

// ── LIST SCREEN ───────────────────────────────────────────────────────────────
function ListScreen({ uid, listId, listName, justCreatedOnline, onBack }) {
  const [list, setList] = useState({ name: listName });
  const [items, setItems] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showBrowse, setShowBrowse] = useState(false);
  const [showAddChoice, setShowAddChoice] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmDeleteList, setConfirmDeleteList] = useState(false);
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);
  const [priceMap, setPriceMap] = useState({});
  const [promoMap, setPromoMap] = useState({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [viewMode, setViewMode] = useState("list");
  const [showVendorVisibility, setShowVendorVisibility] = useState(false);
  const [showCopyItems, setShowCopyItems] = useState(false);
  const [showOptimizer, setShowOptimizer] = useState(false);
  const [profiles, setProfiles] = useState(null); // every vendorProfiles doc, active or not — needed to avoid re-provisioning a vendor the user turned off

  useEffect(() => db.collection("users").doc(uid).collection("vendorProfiles")
    .onSnapshot(snap => setProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })))), [uid]);

  const listMode = list.mode || "instore";
  // A user's vendor profiles span both in-store and online — each list only
  // ever deals with the ones matching its own mode, exactly like it never
  // saw the others at all. Everything downstream (matching, pricing, promo
  // tags, the optimizer) is unchanged either way; it just receives a
  // pre-filtered set instead of the whole thing.
  const allActiveProfiles = useActiveVendorProfiles(uid);
  const activeProfiles = allActiveProfiles.filter(p => (p.mode || "instore") === listMode);
  const onlineVendors = useOnlineVendors();
  const categories = useCategories();
  // Which of the user's active vendors THIS list currently shows — a
  // per-list display filter, distinct from "active" (a vendor stays
  // active/matched in the background even while hidden here, so unhiding
  // it later doesn't need a fresh search).
  const hiddenVendorIds = list.hiddenVendorIds || [];
  const visibleProfiles = activeProfiles.filter(p => hiddenVendorIds.indexOf(p.id) === -1);
  function toggleVendorVisibility(profileId) {
    const nowHidden = hiddenVendorIds.indexOf(profileId) === -1;
    db.collection("lists").doc(listId).update({
      hiddenVendorIds: nowHidden
        ? firebase.firestore.FieldValue.arrayUnion(profileId)
        : firebase.firestore.FieldValue.arrayRemove(profileId),
    });
  }

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 3400); return () => clearTimeout(t); }
  }, [toast]);

  useEffect(() => {
    if (justCreatedOnline) setToast("⚠️ הזמינות תלויה בעיר המשלוח — מומלץ לבדוק באתר הרשת");
    // eslint-disable-next-line
  }, []);

  useEffect(() => db.collection("lists").doc(listId).onSnapshot(snap => {
    if (snap.exists) setList({ id: snap.id, ...snap.data() });
  }), [listId]);

  useEffect(() => {
    return db.collection("lists").doc(listId).collection("items").orderBy("addedAt")
      .onSnapshot(snap => setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [listId]);


  // Opening an online list for the first time is what actually creates its
  // "premade" vendor list (Settings does the same thing, so whichever the
  // user reaches first is enough) — this is what makes the list usable
  // without a separate trip to Settings first.
  useEffect(() => {
    if (listMode !== "online") return;
    provisionOnlineVendorProfiles(uid, onlineVendors, profiles, setToast);
    // eslint-disable-next-line
  }, [listMode, profiles, JSON.stringify(onlineVendors)]);

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

  function fetchPrices() {
    if (!barcodeKey || activeProfiles.length === 0) { setPriceMap({}); setPromoMap({}); return; }
    setPricesLoading(true);
    const payload = {};
    Object.keys(barcodesByVendor).forEach(v => { payload[v] = Array.from(barcodesByVendor[v]); });
    fns.httpsCallable("getBasketPrices", { timeout: 180000 })({ barcodesByVendor: payload }).then(res => {
      setPriceMap(res.data.prices || {});
      setPromoMap(res.data.promoPrices || {});
      setPricesLoading(false);
    }).catch(() => { setPricesLoading(false); });
  }

  useEffect(() => { fetchPrices(); }, [barcodeKey, activeProfiles.length]);

  function insertItem(payload, done) {
    db.collection("lists").doc(listId).collection("items").add(Object.assign({}, payload, {
      addedBy: uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    })).then(() => done());
  }

  function saveEdit(payload) {
    db.collection("lists").doc(listId).collection("items").doc(editItem.id).update(payload).then(() => setEditItem(null));
  }

  function deleteItem(item) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).delete();
  }
  function updateNote(item, note) {
    db.collection("lists").doc(listId).collection("items").doc(item.id).update({ note });
  }

  function renameList(name) { db.collection("lists").doc(listId).update({ name }); }
  async function duplicateList(name) {
    const itemsSnap = await db.collection("lists").doc(listId).collection("items").get();
    const newRef = await db.collection("lists").add({
      name,
      ownerId: uid,
      mode: listMode,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    const batch = db.batch();
    itemsSnap.docs.forEach(d => {
      const data = d.data();
      const itemRef = newRef.collection("items").doc();
      batch.set(itemRef, Object.assign({}, data, { addedAt: firebase.firestore.FieldValue.serverTimestamp() }));
    });
    await batch.commit();
    setToast("הרשימה שוכפלה");
  }
  async function deleteList() {
    const itemsSnap = await db.collection("lists").doc(listId).collection("items").get();
    const batch = db.batch();
    itemsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection("lists").doc(listId));
    await batch.commit();
    onBack();
  }

  const groups = groupByCategory(items || [], categories);

  return (
    <div className="min-h-dvh bg-[#FBF4E7] flex flex-col">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2 no-print">
        <BackButton onClick={onBack} />
        <h1 className="text-xl flex-1 min-w-0 truncate" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>{list.name}</h1>
        {visibleProfiles.length > 0 && (
          <div className="flex bg-white/10 rounded-full p-0.5 flex-shrink-0">
            <button onClick={() => setViewMode("list")}
              className={"text-xs px-3 py-1.5 rounded-full font-bold whitespace-nowrap transition " +
                (viewMode !== "table" ? "bg-[#F3ECD9] text-[#26361F]" : "text-[#C9BE9E]")}>
              רשימה
            </button>
            <button onClick={() => setViewMode("table")}
              className={"text-xs px-3 py-1.5 rounded-full font-bold whitespace-nowrap transition " +
                (viewMode === "table" ? "bg-[#F3ECD9] text-[#26361F]" : "text-[#C9BE9E]")}>
              טבלה
            </button>
          </div>
        )}
        <button onClick={() => setShowMenu(true)} className="text-[#F3ECD9] text-lg w-8 h-8 flex items-center justify-center bg-white/10 rounded-full flex-shrink-0">☰</button>
      </div>

      {pricesLoading && visibleProfiles.length > 0 && (
        <div className="bg-[#EFE4C6] text-[#5B5749] text-xs px-4 py-2 flex items-center justify-center gap-2 no-print">
          <Spinner2 /> טוען מחירים...
        </div>
      )}

      <div className="hidden print-only px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold text-right" style={{ fontFamily: "'Suez One', serif" }}>{list.name}</h1>
        <p className="text-xs text-[#8A7F66] text-right mt-1">{new Date().toLocaleDateString("he-IL")}</p>
      </div>

      <div className="flex-1 px-3 pt-3 pb-28 print-items-area">
        {items === null && <div className="text-[#8A7F66] text-sm py-6 text-center">טוען...</div>}
        {items !== null && items.length === 0 && (
          <div className="text-[#8A7F66] text-sm py-6 text-center">הרשימה ריקה</div>
        )}
        {items !== null && items.length > 0 && viewMode === "table" ? (
          <PriceComparisonTable items={items} activeProfiles={visibleProfiles} priceMap={priceMap} promoMap={promoMap} onEditItem={setEditItem} />
        ) : (
          groups.map(group => (
            <div key={group.label} className="mb-5">
              <div className="text-xs font-semibold text-[#8A9A72] mb-1.5 flex items-center justify-between gap-1.5 uppercase tracking-wide px-1">
                <span className="flex items-center gap-1.5">
                  <span>{group.emoji}</span><span>{categoryHeaderLabel(group.label)}</span>
                </span>
                <span className="text-[#A79A7C] normal-case tracking-normal font-normal" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {group.items.length}/{(items || []).length}
                </span>
              </div>
              <div>
                {group.items.map(item => (
                  <ItemRow key={item.id} item={item} activeProfiles={visibleProfiles} priceMap={priceMap} promoMap={promoMap}
                    onDelete={setConfirmDeleteItem} onEdit={setEditItem}
                    onUpdateNote={note => updateNote(item, note)} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 flex items-center gap-2 no-print">
        {visibleProfiles.length > 0 && (items || []).length > 0 && (
          <button
            onClick={() => setShowOptimizer(true)}
            className="bg-white border border-[#C7B78E] text-[#5B5749] px-3 py-2 rounded-xl shadow-md text-xs font-medium flex items-center gap-1 whitespace-nowrap"
          >
            {listMode === "online" ? "🛒 סיום ומעבר להזמנה" : "🧮 אופטימיזציה וסיום"}
          </button>
        )}
        <button
          onClick={() => setShowAddChoice(true)}
          className="bg-[#2E4A3B] text-[#FBF4E7] px-5 py-3 rounded-2xl shadow-xl font-semibold text-sm flex items-center gap-1.5"
        >
          <span className="text-base font-light">+</span> הוספת פריט
        </button>
      </div>

      {showAddChoice && (
        <Modal onClose={() => setShowAddChoice(false)}>
          <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>הוספת פריט</h3>
          <div className="space-y-2">
            <button onClick={() => { setShowAddChoice(false); setShowAdd(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3.5 rounded-xl border border-[#E0D4B4] bg-white hover:bg-[#FBF4E7]">
              <span className="text-xl">🔎</span>
              <span>
                <div className="text-sm font-semibold text-[#2B2418]">לפי שם</div>
                <div className="text-[11px] text-[#8A7F66]">מקלידים שם ובוחרים התאמה</div>
              </span>
            </button>
            <button onClick={() => { setShowAddChoice(false); setShowBrowse(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3.5 rounded-xl border border-[#E0D4B4] bg-white hover:bg-[#FBF4E7]">
              <span className="text-xl">📂</span>
              <span>
                <div className="text-sm font-semibold text-[#2B2418]">עיון לפי קטגוריה</div>
                <div className="text-[11px] text-[#8A7F66]">כשלא בטוחים בשם המדויק</div>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {showAdd && (
        <ItemWizard uid={uid} mode="add" categories={categories} activeProfiles={activeProfiles} onInsert={insertItem} onClose={() => setShowAdd(false)} showToast={setToast} />
      )}
      {showBrowse && (
        <CategoryBrowseModal categories={categories} activeProfiles={activeProfiles} onInsert={insertItem} onClose={() => setShowBrowse(false)} showToast={setToast} />
      )}
      {editItem && (
        <ItemWizard uid={uid} mode="edit" item={editItem} categories={categories} activeProfiles={activeProfiles} onSave={saveEdit} onClose={() => setEditItem(null)} showToast={setToast} />
      )}

      {showMenu && (
        <Modal onClose={() => setShowMenu(false)}>
          <h3 className="text-lg text-center mb-4" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>פעולות</h3>

          <div className="text-[10px] font-semibold text-[#A79A7C] uppercase tracking-wide px-2 pb-1">הרשימה</div>
          <div className="space-y-1 mb-3">
            <button onClick={() => { setShowMenu(false); setRenaming(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">✏️</span><span className="text-sm font-medium text-[#2B2418]">שינוי שם</span>
            </button>
            <button onClick={() => { setShowMenu(false); setDuplicating(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">📋</span><span className="text-sm font-medium text-[#2B2418]">שכפול רשימה</span>
            </button>
            <button onClick={() => { setShowMenu(false); setShowCopyItems(true); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">📤</span><span className="text-sm font-medium text-[#2B2418]">העתק פריטים לרשימה אחרת</span>
            </button>
            <button onClick={() => { setShowMenu(false); window.print(); }}
              className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
              <span className="text-lg">🖨️</span><span className="text-sm font-medium text-[#2B2418]">הדפס / ייצוא ל-PDF</span>
            </button>
          </div>

          {activeProfiles.length > 0 && (
            <React.Fragment>
              <div className="text-[10px] font-semibold text-[#A79A7C] uppercase tracking-wide px-2 pb-1">מחירים והשוואה</div>
              <div className="space-y-1 mb-3">
                <button onClick={() => { setShowMenu(false); setShowVendorVisibility(true); }}
                  className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#F0E9D4]">
                  <span className="text-lg">🏪</span><span className="text-sm font-medium text-[#2B2418]">רשתות מוצגות</span>
                </button>
              </div>
            </React.Fragment>
          )}

          <div className="pt-2 border-t border-[#E5D8B5]">
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
      {duplicating && (
        <RenameDialog title="שם הרשימה המשוכפלת" initialValue={list.name + " (עותק)"} onSave={duplicateList} onClose={() => setDuplicating(false)} />
      )}
      {confirmDeleteList && (
        <ConfirmDialog message={`למחוק את הרשימה "${list.name}"?`} onConfirm={deleteList} onClose={() => setConfirmDeleteList(false)} />
      )}
      {confirmDeleteItem && (
        <ConfirmDialog message={`למחוק את "${itemDisplayName(confirmDeleteItem)}"?`}
          onConfirm={() => deleteItem(confirmDeleteItem)}
          onClose={() => setConfirmDeleteItem(null)} />
      )}
      {showVendorVisibility && (
        <VendorVisibilityModal uid={uid} listMode={listMode} activeProfiles={activeProfiles} hiddenVendorIds={hiddenVendorIds}
          onToggle={toggleVendorVisibility} onClose={() => setShowVendorVisibility(false)} showToast={setToast} />
      )}
      {showCopyItems && (
        <CopyItemsModal uid={uid} sourceListId={listId} sourceMode={listMode} items={items || []} categories={categories}
          onClose={() => setShowCopyItems(false)} showToast={setToast} />
      )}
      {showOptimizer && (
        <OptimizerModal uid={uid} list={list} items={items || []} visibleProfiles={visibleProfiles} activeProfiles={activeProfiles}
          onlineVendors={onlineVendors} priceMap={priceMap} promoMap={promoMap} pricesLoading={pricesLoading}
          onClose={() => setShowOptimizer(false)} onHome={onBack} showToast={setToast} />
      )}
      {toast && <Toast msg={toast} />}
    </div>
  );
}

// ── FEEDBACK ──────────────────────────────────────────────────────────────────
// Ported from FouFou-Pets' feedback module: a two-way conversation thread
// between a user and admin, not a one-shot form. Everyone signed in can
// start a thread and reply to it; an admin sees every user's threads
// instead of just their own, and replies as "admin". Real Google sign-in
// is already required app-wide, so there's no separate "sign in to send
// feedback" gate needed.
const FEEDBACK_CATEGORIES = [
  { value: "bug", label: "🐛 באג" },
  { value: "idea", label: "💡 רעיון" },
  { value: "general", label: "💭 כללי" },
];
function feedbackCategoryLabel(value) {
  const c = FEEDBACK_CATEGORIES.find(x => x.value === value);
  return c ? c.label : value;
}
function messageTime(ms) {
  return new Date(ms).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}
function isThreadUnread(thread, isAdmin) {
  return isAdmin ? thread.unreadByAdmin : thread.unreadByUser;
}

function FeedbackDialog({ uid, displayName, email, onClose }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState("list"); // "list" | "new" | "thread"
  const [threads, setThreads] = useState(null);
  const [activeThread, setActiveThread] = useState(null);

  const [category, setCategory] = useState("general");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => db.collection("users").doc(uid).onSnapshot(snap => {
    setIsAdmin(effectiveRole((snap.data() || {}).role) === "admin");
  }), [uid]);

  function loadThreads(admin) {
    setThreads(null);
    const col = db.collection("feedbackThreads");
    const q = admin ? col.orderBy("lastActivityAt", "desc") : col.where("userId", "==", uid);
    q.get().then(snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // No orderBy combined with the userId filter (would need a composite
      // index) — sort the small per-user result client-side instead.
      if (!admin) rows.sort((a, b) => (b.lastActivityAt?.toMillis?.() || 0) - (a.lastActivityAt?.toMillis?.() || 0));
      setThreads(rows);
    });
  }
  useEffect(() => { loadThreads(isAdmin); }, [isAdmin]);

  function openThread(thread) {
    setActiveThread(thread);
    setView("thread");
    if (isThreadUnread(thread, isAdmin)) {
      db.collection("feedbackThreads").doc(thread.id).update(isAdmin ? { unreadByAdmin: false } : { unreadByUser: false });
      setThreads(prev => prev.map(t => t.id === thread.id ? Object.assign({}, t, { [isAdmin ? "unreadByAdmin" : "unreadByUser"]: false }) : t));
    }
  }

  function handleCreate() {
    if (!text.trim()) return;
    setSubmitting(true);
    fns.httpsCallable("submitFeedbackMessage")({
      text: text.trim(), category, subject: subject.trim(),
      senderName: displayName || "", senderEmail: email || "",
    }).then(() => {
      setSubject(""); setText(""); setCategory("general"); setView("list");
      loadThreads(isAdmin);
    }).finally(() => setSubmitting(false));
  }

  function handleReply() {
    if (!replyText.trim() || !activeThread) return;
    setSending(true);
    const from = isAdmin ? "admin" : "user";
    const message = { from, text: replyText.trim(), timestamp: Date.now() };
    fns.httpsCallable("submitFeedbackMessage")({ threadId: activeThread.id, text: replyText.trim() }).then(() => {
      setActiveThread(prev => Object.assign({}, prev, { messages: prev.messages.concat([message]) }));
      setReplyText("");
    }).finally(() => setSending(false));
  }

  return (
    <Modal onClose={onClose} footer={
      view === "list" && !isAdmin ? (
        <button onClick={() => setView("new")} className="w-full bg-[#2E4A3B] text-white py-3 rounded-2xl font-semibold text-sm">
          + שיחה חדשה
        </button>
      ) : view === "new" ? (
        <div className="flex gap-2">
          <button onClick={handleCreate} disabled={submitting || !text.trim()}
            className="flex-1 bg-[#2E4A3B] text-white py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
            {submitting ? <Spinner /> : "שליחה"}
          </button>
          <button onClick={() => setView("list")} disabled={submitting}
            className="flex-1 border border-[#DECBA1] text-[#8A7F66] py-3 rounded-2xl font-medium text-sm disabled:opacity-40">
            ביטול
          </button>
        </div>
      ) : view === "thread" ? (
        <div className="flex gap-2">
          <input value={replyText} onChange={e => setReplyText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleReply(); }}
            placeholder="הקלידו תגובה..."
            className="flex-1 min-w-0 border border-[#C7B78E] bg-white rounded-xl px-3 py-2.5 text-right outline-none text-sm" />
          <button onClick={handleReply} disabled={sending || !replyText.trim()}
            className="px-4 rounded-xl bg-[#2E4A3B] text-white text-sm font-medium disabled:opacity-40 flex-shrink-0">
            {sending ? <Spinner /> : "שליחה"}
          </button>
        </div>
      ) : null
    }>
      <div className="flex items-center gap-2 mb-4">
        {view === "thread" && (
          <button onClick={() => setView("list")} className="text-[#2E4A3B] text-lg px-1">›</button>
        )}
        <h3 className="flex-1 text-lg text-center" style={{ fontFamily: "'Suez One', serif", color: "#26361F" }}>
          {view === "thread" ? (activeThread?.subject || feedbackCategoryLabel(activeThread?.category)) : "💬 משוב"}
        </h3>
        {view === "thread" && <span style={{ width: 20 }} />}
      </div>

      {view === "list" && (
        <div className="space-y-2">
          {threads === null && <p className="text-sm text-[#8A7F66] text-center py-6">טוען...</p>}
          {threads && threads.length === 0 && <p className="text-sm text-[#A79A7C] text-center py-6">אין שיחות עדיין</p>}
          {threads && threads.map(t => (
            <button key={t.id} onClick={() => openThread(t)}
              className="w-full text-right flex items-start gap-2 rounded-xl border border-[#E5D8B5] bg-white px-3 py-2.5 hover:bg-[#FBF4E7]">
              <span className="flex-shrink-0">{feedbackCategoryLabel(t.category).split(" ")[0]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[#2B2418]">
                  {t.subject || t.messages?.[0]?.text || "(ללא נושא)"}
                </span>
                {isAdmin && <span className="block truncate text-xs text-[#A79A7C]">{t.senderName || t.senderEmail}</span>}
                <span className="block text-xs text-[#A79A7C]">{t.messages?.length || 0} הודעות</span>
              </span>
              {isThreadUnread(t, isAdmin) && <span className="mt-1 w-2 h-2 rounded-full bg-[#B8462F] flex-shrink-0" />}
            </button>
          ))}
        </div>
      )}

      {view === "new" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            {FEEDBACK_CATEGORIES.map(c => (
              <button key={c.value} onClick={() => setCategory(c.value)}
                className={"flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium " +
                  (category === c.value ? "border-[#2E4A3B] bg-[#2E4A3B] text-white" : "border-[#C7B78E] text-[#5B5749]")}>
                {c.label}
              </button>
            ))}
          </div>
          <input value={subject} onChange={e => setSubject(e.target.value)} maxLength={100} placeholder="נושא"
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none text-sm" />
          <textarea value={text} onChange={e => setText(e.target.value)} rows={6} maxLength={3000} placeholder="ספרו לנו מה חשבתם..."
            className="w-full border border-[#C7B78E] bg-white rounded-xl px-4 py-3 text-right outline-none text-sm resize-none" />
        </div>
      )}

      {view === "thread" && activeThread && (
        <div className="space-y-2">
          {activeThread.messages.map((m, i) => (
            <div key={i} className={"flex " + (m.from === (isAdmin ? "admin" : "user") ? "justify-start" : "justify-end")}>
              <div className={"max-w-[80%] rounded-2xl px-3 py-2 text-sm " + (m.from === "admin" ? "bg-[#EEF5EC] text-[#2B2418]" : "bg-[#F3ECD9] text-[#2B2418]")}>
                <p className="text-[10px] text-[#A79A7C] mb-0.5">{m.from === "admin" ? "👑" : "👤"} {messageTime(m.timestamp)}</p>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── HELP ──────────────────────────────────────────────────────────────────────
function HelpCard({ icon, title, children }) {
  return (
    <div className="bg-white border border-[#E0D4B4] rounded-2xl p-4 flex gap-3">
      <div className="w-10 h-10 rounded-full bg-[#F3ECD9] flex items-center justify-center text-lg flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="font-semibold text-[#2B2418] text-sm mb-0.5">{title}</div>
        <div className="text-[13px] text-[#5B5749] leading-snug">{children}</div>
      </div>
    </div>
  );
}

function HelpScreen({ onBack }) {
  const [tab, setTab] = useState("setup"); // "setup" | "extra"

  return (
    <div className="min-h-dvh bg-[#FBF4E7]">
      <div className="bg-[#26361F] px-4 pt-4 pb-3 flex items-center gap-2">
        <BackButton onClick={onBack} />
        <h1 className="text-xl" style={{ fontFamily: "'Suez One', serif", color: "#F3ECD9" }}>עזרה ומדריך</h1>
      </div>

      <div className="px-4 pt-4 flex justify-center">
        <div className="flex bg-white border border-[#E0D4B4] rounded-full p-1">
          <button onClick={() => setTab("setup")}
            className={"text-sm px-4 py-2 rounded-full font-medium transition " + (tab === "setup" ? "bg-[#2E4A3B] text-white" : "text-[#8A7F66]")}>
            התחלת עבודה
          </button>
          <button onClick={() => setTab("extra")}
            className={"text-sm px-4 py-2 rounded-full font-medium transition " + (tab === "extra" ? "bg-[#2E4A3B] text-white" : "text-[#8A7F66]")}>
            יכולות נוספות
          </button>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {tab === "setup" ? (
          <React.Fragment>
            <div className="bg-[#EEF5EC] border border-[#B9D9B0] rounded-2xl p-4 text-[13px] text-[#2E4A3B] leading-snug">
              <b>חדשים באפליקציה?</b> שני הצעדים הראשונים (התקנה + הוספת רשתות) הם חד-פעמיים — אחריהם כל רשימה חדשה כבר משווה מחירים אוטומטית.
            </div>
            <HelpCard icon="📲" title="1. התקנה למסך הבית">
              כפתור גלגל השיניים ⚙️ בפינת מסך הבית ← "התקנת אפליקציה". כך סופר זולה נפתחת כמו אפליקציה רגילה, בלי לחפש אותה בדפדפן בכל פעם.
            </HelpCard>
            <HelpCard icon="🏪" title="2. הוספת רשתות וסניפים לקנייה רגילה">
              כפתור גלגל השיניים ⚙️ ← "רשתות להשוואת מחירים" — הוסיפו את הסניפים שבהם אתם קונים בפועל — חיפוש לפי שם או לפי כתובת קרובה. רק סניפים "פעילים" משפיעים על השוואת המחירים.
            </HelpCard>
            <HelpCard icon="🛒" title="3. קונים גם אונליין?">
              אין צורך להוסיף כלום ידנית. כשפותחים רשימה מסוג "קנייה אונליין" האפליקציה בונה אוטומטית רשימת רשתות שתומכות במשלוח, ואפשר לכבות מהן את מה שלא רלוונטי. הזמינות בפועל תלויה בעיר המשלוח שלכם — האפליקציה לא בודקת זאת אוטומטית, כדאי לוודא באתר הרשת לפני ההזמנה.
            </HelpCard>
            <HelpCard icon="📝" title="4. יצירת רשימה">
              במסך הבית: "+ קניה בסניף" לקנייה רגילה, או "+ קנייה אונליין" לרשימה שמושווית מול הרשתות האונליין. הרשימה נפתחת מיד, בלי שם מוקדם — אפשר לשנות שם בכל שלב מתפריט הרשימה (☰).
            </HelpCard>
            <HelpCard icon="➕" title="5. הוספת פריט">
              בתוך רשימה, לחצו "+ הוספת פריט" ובחרו איך למצוא אותו: 🔍 לפי שם — מקלידים שם ובוחרים מתוך התאמה, או 📁 עיון לפי קטגוריה — כשלא בטוחים בשם המדויק. אחר כך נותנים כמות וקטגוריה. זו אותה מנגנון בדיוק כמו "🔍 חיפוש והוספת פריט" במסך הבית — שם בוחרים לאיזו רשימה מוסיפים רק ברגע שבאמת מוסיפים פריט, לא לפני החיפוש.
            </HelpCard>
            <HelpCard icon="🔍" title="6. התאמת מחיר לפריט">
              האפליקציה מחפשת את הפריט בכל רשת פעילה. לפעמים לרשתות שונות יש ברקוד שונה לאותו מוצר — כשהחיפוש מכסה כמה רשתות אפשר לסמן (☑) כמה התאמות בבת אחת, אחת לכל רשת, ולשמור הכול יחד.
            </HelpCard>
            <HelpCard icon="📊" title="7. תצוגת רשימה מול טבלה">
              בכל רשימה יש שני מצבי תצוגה, מתחלפים מכפתור בראש המסך: 📋 רשימה — פריט אחר פריט עם המחירים לצדו. 📊 טבלה — כל הפריטים והרשתות יחד כמו גיליון, כולל שורת סיכום.
            </HelpCard>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <HelpCard icon="🔍" title="חיפוש והוספת פריט">
              במסך הבית — בוחרים מתג רגיל/אונליין (כדי לדעת מול אילו רשתות להשוות) ואז מחפשים פריט לפי שם או קטגוריה, בדיוק כמו בתוך רשימה. אפשר גם רק להסתכל על ההתאמות בלי להוסיף כלום. רק ברגע שבאמת לוחצים להוסיף פריט נשאלים לאיזו רשימה — ואז זה נשמר לכל שאר החיפוש, בלי לשאול שוב על כל פריט.
            </HelpCard>
            <HelpCard icon="🧮" title="אופטימיזציית קניות">
              כפתור קטן ליד "+ הוספת פריט" ("🧮 אופטימיזציה וסיום" ברשימה רגילה, "🛒 סיום ומעבר להזמנה" ברשימת אונליין) פותח את אופטימיזציית הקניות — משווה קנייה בחנות אחת מול פיצול בין כמה חנויות, ומאפשר ליצור רשימות נפרדות לפי התכנית הזולה ביותר. ברשימת קנייה אונליין העלות כוללת גם דמי משלוח לכל רשת בתכנית, והתכנית הזולה נבחרת אוטומטית עם הפתיחה.
            </HelpCard>
            <HelpCard icon="🛒" title="מעבר להזמנה (רשימת אונליין)">
              בתכנית שנבחרה באופטימיזציה יש לכל רשת כפתור מעבר להזמנה. הוא פותח את אתר הרשת בטאב חדש, ומאפשר להעתיק כל שם פריט ולהדביק אותו בחיפוש שם. ההתחברות, הסל, הכתובת למשלוח והתשלום מתבצעים כולם באתר הרשת עצמו.
            </HelpCard>
            <HelpCard icon="🏪" title="רשתות מוצגות">
              מסתירים רשת מסוימת רק ברשימה הזו, בלי לכבות אותה לגמרי — שימושי כשלא מתכננים לקנות שם הפעם. מאותו מסך אפשר גם להוסיף סניף חדש (לא רק לנהל את הקיימים).
            </HelpCard>
            <HelpCard icon="📤" title="העתק פריטים לרשימה אחרת">
              בתפריט הרשימה (☰) — בוחרים פריטים מהרשימה הנוכחית ומעתיקים אותם לרשימה קיימת או חדשה, מאותו סוג (רגילה או אונליין) כמו הרשימה המקורית.
            </HelpCard>
            <HelpCard icon="🏷️" title="מבצעים">
              תג כתום ליד מחיר מציין מבצע שתלוי בכמות, למשל "2 ב-₪10" — המחיר יתעדכן אוטומטית כשתגיעו לכמות הנדרשת.
            </HelpCard>
            <HelpCard icon="💬" title="משוב">
              כפתור גלגל השיניים ⚙️ ← "שליחת משוב" — דיווח על באג, רעיון או פנייה כללית. התשובות מגיעות לאותה שיחה, עם סימון הודעות שלא נקראו.
            </HelpCard>
          </React.Fragment>
        )}
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

  let content;
  if (user === undefined) {
    content = <Loading />;
  } else if (!user) {
    content = <SignInScreen />;
  } else if (screen.view === "list") {
    content = (
      <ListScreen
        uid={user.uid}
        listId={screen.id}
        listName={screen.name}
        justCreatedOnline={screen.justCreatedOnline}
        onBack={() => setScreen({ view: "home" })}
      />
    );
  } else if (screen.view === "vendors") {
    content = <VendorsScreen uid={user.uid} onBack={() => setScreen({ view: "home" })} />;
  } else if (screen.view === "adminOptions") {
    content = <AdminOptionsScreen uid={user.uid} onBack={() => setScreen({ view: "home" })} />;
  } else if (screen.view === "help") {
    content = <HelpScreen onBack={() => setScreen({ view: "home" })} />;
  } else {
    content = (
      <Home
        uid={user.uid}
        displayName={user.displayName}
        email={user.email}
        onOpenList={(id, name, justCreatedOnline) => setScreen({ view: "list", id, name, justCreatedOnline })}
        onOpenVendors={() => setScreen({ view: "vendors" })}
        onOpenAdminOptions={() => setScreen({ view: "adminOptions" })}
        onOpenHelp={() => setScreen({ view: "help" })}
        onSignOut={signOut}
      />
    );
  }

  // Fixed narrow width made sense for phones, but left laptops/tablets with
  // a stretched or oddly narrow app — this widens progressively with the
  // viewport instead (ported from Buli), so wider screens actually get to
  // use the extra space (most visible in the price comparison table, which
  // otherwise scrolls horizontally sooner than it needs to).
  return (
    <div className="max-w-md sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl mx-auto min-h-dvh relative">
      {content}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
