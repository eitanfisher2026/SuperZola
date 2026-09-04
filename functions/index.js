const functions = require('firebase-functions/v1');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

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

// ─────────────────────────────────────────────────────────────────────────────
// Access helpers — SuperZola has no family allowlist (unlike Buli): any
// Google sign-in auto-provisions a 'user' role via onUserCreate above. Admin
// is just the Firestore role field.
// ─────────────────────────────────────────────────────────────────────────────
function requireSignedIn(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
}
async function requireAdmin(request) {
  requireSignedIn(request);
  const snap = await db.collection('users').doc(request.auth.uid).get();
  if ((snap.data() || {}).role !== 'admin') throw new HttpsError('permission-denied', 'נדרשת הרשאת מנהל.');
}
async function requireEditorOrAdmin(request) {
  requireSignedIn(request);
  const snap = await db.collection('users').doc(request.auth.uid).get();
  const role = (snap.data() || {}).role;
  if (role !== 'admin' && role !== 'editor') throw new HttpsError('permission-denied', 'נדרשת הרשאת עורך.');
}

// ─────────────────────────────────────────────────────────────────────────────
// AI cost tracking — per user, per month, per provider
// ─────────────────────────────────────────────────────────────────────────────
async function recordCost(request, ai, inputTokens, outputTokens) {
  const costUsd = calcCostUsd(ai, inputTokens, outputTokens);
  if (costUsd > 0 && request.auth) {
    const uid = request.auth.uid;
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    await db.collection('costLedger').doc(uid).collection('months').doc(month).set({
      [ai.type]: admin.firestore.FieldValue.increment(costUsd),
    }, { merge: true }).catch(() => {}); // never fail the user-facing request over a cost-logging hiccup
  }
  return costUsd;
}

// Sign-up stays open to any Google account (no allowlist/invite) — this is
// the safety net for that choice: a hard per-user monthly ceiling on the
// one feature that actually costs real money (AI categorization), checked
// BEFORE spending anything. $1/month is enormous headroom for genuine use
// (a family adds maybe a few hundred items a month, each call costs a
// small fraction of a cent on the flash-lite/mini tier models) — this only
// ever bites a runaway loop or deliberate abuse, and fails soft: the caller
// already treats "no category returned" as a normal case (falls back to
// "other"), so hitting the cap degrades a feature, it doesn't break the app.
const FREE_TIER_MONTHLY_AI_CAP_USD = 1.0;
async function monthlyCostSoFar(uid) {
  const month = new Date().toISOString().slice(0, 7);
  const snap = await db.collection('costLedger').doc(uid).collection('months').doc(month).get();
  if (!snap.exists) return 0;
  return Object.values(snap.data()).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
}

// Same open-signup safety net for the functions that don't cost AI money but
// still cost real Firestore/compute — a per-user, per-day call cap, cheap
// to check (one tiny document per user per day) and set well above any
// plausible genuine usage, so it only ever stops a scripted/abusive caller.
const DAILY_CALL_CAPS = {
  categorizeItemName: 300,
  resolveItemBarcodes: 500,
  getBasketPrices: 800,
  browseCategoryItems: 300,
  prewarmVendorCatalog: 50,
  submitCategoryCorrection: 50,
  submitFeedbackMessage: 50,
};
async function enforceDailyCap(uid, fnName) {
  const cap = DAILY_CALL_CAPS[fnName];
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection('usageLedger').doc(uid).collection('days').doc(day);
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = ((snap.data() || {})[fnName] || 0) + 1;
    if (count > cap) return false;
    tx.set(ref, { [fnName]: count }, { merge: true });
    return true;
  });
  if (!allowed) throw new HttpsError('resource-exhausted', 'חריגה ממכסת השימוש היומית — נסו שוב מחר');
}

// ─── AI pricing ($ per million tokens) ───────────────────────────────────────
const PRICING = {
  anthropic: {
    'claude-sonnet-4-6':          { in: 3, out: 15 },
    'claude-haiku-4-5-20251001':  { in: 1, out: 5 },
  },
  gemini: {
    'gemini-2.0-flash-lite':     { in: 0.075, out: 0.30 },
    'gemini-2.0-flash':          { in: 0.10, out: 0.40 },
    'gemini-2.5-flash-lite':     { in: 0.10, out: 0.40 },
    'gemini-2.5-flash':          { in: 0.30, out: 2.50 },
    'gemini-2.5-pro':            { in: 1.25, out: 10.00 },
  },
  openai: {
    'gpt-4o-mini':   { in: 0.15, out: 0.60 },
    'gpt-4o':        { in: 2.50, out: 10.00 },
    'gpt-4.1':       { in: 2.00, out: 8.00 },
    'gpt-4.1-mini':  { in: 0.40, out: 1.60 },
  }
};

function makeAI(data) {
  const { provider, geminiApiKey, geminiModel, openaiApiKey, openaiModel, anthropicApiKey, anthropicModel } = data || {};
  if (provider === 'gemini' && geminiApiKey) {
    const model = geminiModel || 'gemini-flash-lite-latest';
    return { type: 'gemini', client: new GoogleGenerativeAI(geminiApiKey), model };
  }
  if (provider === 'openai' && openaiApiKey) {
    const model = openaiModel || 'gpt-4o-mini';
    return { type: 'openai', client: new OpenAI({ apiKey: openaiApiKey }), model };
  }
  if (provider === 'anthropic' && anthropicApiKey) {
    const model = anthropicModel || 'claude-haiku-4-5-20251001';
    return { type: 'anthropic', client: new Anthropic({ apiKey: anthropicApiKey }), model };
  }
  throw new HttpsError('failed-precondition',
    'לא הוגדר ספק AI.\n\nמה לעשות: פתח הגדרות → הגדרות AI והזן מפתח API של Gemini, OpenAI או Anthropic.'
  );
}

async function callAI(ai, prompt, maxTokens) {
  try {
    if (ai.type === 'gemini') {
      const gemModel = ai.client.getGenerativeModel({ model: ai.model });
      const result = await gemModel.generateContent(prompt);
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      return { text, usage: { input_tokens: meta?.promptTokenCount || 0, output_tokens: meta?.candidatesTokenCount || 0 } };
    }
    if (ai.type === 'openai') {
      const completion = await ai.client.chat.completions.create({
        model: ai.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      return {
        text: completion.choices[0].message.content,
        usage: { input_tokens: completion.usage?.prompt_tokens || 0, output_tokens: completion.usage?.completion_tokens || 0 }
      };
    }
    const resp = await ai.client.messages.create({
      model: ai.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    return { text: resp.content[0].text, usage: resp.usage };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    const msg = (e.message || '').toLowerCase();
    const status = e.status || e.statusCode || 0;
    const name = ai.type === 'gemini' ? 'Gemini' : ai.type === 'openai' ? 'OpenAI' : 'Claude';
    if (status === 401 || msg.includes('api key') || msg.includes('api_key_invalid') || msg.includes('invalid x-api-key') || msg.includes('incorrect api key') || msg.includes('authentication_error') || msg.includes('invalid_api_key')) {
      throw new HttpsError('permission-denied', `מפתח ה-${name} שלך אינו תקין או פג תוקף.\n\nמה לעשות: פתח הגדרות → הגדרות AI, מחק את המפתח הנוכחי והדבק מפתח תקין.`);
    }
    if (msg.includes('insufficient_quota') || msg.includes('exceeded your current quota') || msg.includes('billing') || e.code === 'insufficient_quota') {
      throw new HttpsError('resource-exhausted', `לחשבון ה-${name} שלך אין מכסה זמינה.\n\nמה לעשות: היכנס לעמוד החיוב בחשבון ה-${name} שלך והוסף אמצעי תשלום, ואז נסה שוב.`);
    }
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('rate_limit_exceeded')) {
      throw new HttpsError('resource-exhausted', `הגעת למגבלת הקצב של ${name}.\n\nמה לעשות: המתן 30–60 שניות ונסה שוב, או עבור לספק AI אחר בהגדרות.`);
    }
    throw new HttpsError('internal', `שגיאת ${name}: ${e.message}`);
  }
}

function calcCostUsd(ai, inputTokens, outputTokens) {
  const table = PRICING[ai.type] || {};
  const fallback = ai.type === 'gemini' ? 'gemini-2.5-flash-lite' : ai.type === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001';
  const p = table[ai.model] || table[fallback];
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

// The AI provider/key is configured once by an admin (appConfig/ai) and
// shared by every user — nobody brings their own key. The client never
// sees this doc (Firestore rules restrict it to admin reads); every AI
// callable loads it here, server-side, via the Admin SDK.
async function getAppAiConfig() {
  const snap = await db.collection('appConfig').doc('ai').get();
  return snap.exists ? snap.data() : null;
}

// Real-time, single-item categorization at add-time — a short, cheap
// prompt that never throws: no admin config, a bad response, or a rate
// limit all just mean "no suggestion," and the user still picks manually,
// same as before this feature existed.
// Shared by the live per-item guess (categorizeItemName) and the catalog
// backfill (categorizeCatalogBatch) — same prompt shape either way, just
// called against a typed name in one case and a full catalog product name
// in the other. A numbered choice is far more reliable to parse back out
// than asking for the exact label as free text — no risk of the model
// wrapping the answer in extra words that break an exact-match check. The
// explicit examples and the "last resort" rule for "שונות" are here
// because a plain "pick the best category" prompt was landing everyday
// items like yogurt in the misc bucket instead of dairy.
async function categorizeName(ai, name, catLabels) {
  const prompt = `אתה מסווג פריטי קניה בסופרמרקט לקטגוריות, לפי ידע כללי על מוצרי מזון וצריכה.\n\nקטגוריות (ממוספרות):\n${catLabels.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nפריט לסיווג: "${name.trim()}"\n\nכללים:\n- בחר לפי הידע הכללי שלך על מוצרי סופרמרקט. לדוגמה: יוגורט, גבינה, קוטג', חמאה, שמנת וחלב שייכים לקטגוריית מוצרי חלב; עגבניה ומלפפון שייכים לירקות טריים.\n- הקטגוריה "שונות" היא מוצא אחרון בלבד — רק אם שום קטגוריה אחרת לא מתאימה כלל.\n- החזר אך ורק את המספר של הקטגוריה שבחרת, ללא שום טקסט נוסף.`;
  const { text: raw, usage } = await callAI(ai, prompt, 10);
  const num = parseInt((raw.match(/\d+/) || [])[0], 10);
  const category = (num >= 1 && num <= catLabels.length) ? catLabels[num - 1] : null;
  return { category, usage };
}

// Catalog backfill only — picks a category AND subcategory together, one
// leaf choice out of every category>subcategory combination (falling back
// to just the category if it has no subcategories defined yet). Not used
// for the live per-item guess, since there's nowhere in the item UI that
// shows a subcategory today; this is purely for the shared catalog cache
// that will eventually power browsing by category.
async function categorizeNameWithSubcategory(ai, name, categories) {
  const leaves = [];
  categories.forEach(cat => {
    const subs = cat.subcategories || [];
    if (subs.length === 0) leaves.push({ label: cat.label, category: cat.label, subcategory: null });
    else subs.forEach(s => leaves.push({ label: `${cat.label} > ${s.label}`, category: cat.label, subcategory: s.label }));
  });
  const prompt = `אתה מסווג פריטי קניה בסופרמרקט לקטגוריות ותתי-קטגוריות, לפי ידע כללי על מוצרי מזון וצריכה.\n\nאפשרויות (ממוספרות, קטגוריה > תת-קטגוריה):\n${leaves.map((l, i) => `${i + 1}. ${l.label}`).join('\n')}\n\nפריט לסיווג: "${name.trim()}"\n\nכללים:\n- בחר את האפשרות הספציפית והמתאימה ביותר, לפי ידע כללי על מוצרי סופרמרקט.\n- "שונות" הוא מוצא אחרון בלבד — רק אם שום אפשרות אחרת לא מתאימה כלל.\n- החזר אך ורק את המספר של האפשרות שבחרת, ללא שום טקסט נוסף.`;
  const { text: raw, usage } = await callAI(ai, prompt, 10);
  const num = parseInt((raw.match(/\d+/) || [])[0], 10);
  const picked = (num >= 1 && num <= leaves.length) ? leaves[num - 1] : null;
  return { category: picked ? picked.category : null, subcategory: picked ? picked.subcategory : null, usage };
}

// Admin/editor-triggered, one batch at a time — the client calls this
// repeatedly (same shape as geocodeVendorBranchesBatch) until `remaining`
// hits 0. Only ever touches barcodes not already in productCategories, so
// re-running it costs nothing once a catalog's fully tagged.
// Runs `worker` over `items` with at most `concurrency` in flight at once —
// categorizing one barcode at a time sequentially made a real branch
// catalog (thousands of items) take hours; this cuts a batch of 100 down
// to roughly the time of one AI call instead of one hundred.
async function runWithConcurrency(items, concurrency, worker) {
  let i = 0;
  async function lane() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

exports.categorizeCatalogBatch = onCall(
  { timeoutSeconds: 300, memory: '256MiB', region: REGION },
  async (request) => {
    await requireEditorOrAdmin(request);
    const { vendor, limit } = request.data || {};
    if (!VENDORS[vendor]) throw new HttpsError('invalid-argument', 'valid vendor required');
    // Every call re-reads the whole catalog and re-checks cache membership
    // for every barcode before it can even start — fixed overhead that's
    // identical call to call within one run. A small batch size meant that
    // overhead got paid dozens of times over for a big catalog; a much
    // bigger batch means far fewer calls, so it's paid far fewer times.
    const batchSize = Math.min(parseInt(limit, 10) || 250, 300);

    // Categorization is barcode-keyed and shared regardless of which branch
    // sells it, so the caller only ever needs to name a vendor — any one
    // cached branch is a fine representative sample of that chain's
    // catalog. Whichever branch happens to already be cached (from some
    // user tracking it) is picked automatically.
    const idxSnap = await db.collection('vendorCatalogIndex')
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(vendor + '__').endAt(vendor + '__' + String.fromCharCode(0xFFFF)).limit(1).get();
    if (idxSnap.empty) return { noCatalog: true, totalInCatalog: 0, alreadyCached: 0, processedNow: 0, remaining: 0 };
    const key = idxSnap.docs[0].id;

    const [catsSnap, config, items] = await Promise.all([
      db.collection('categories').get(),
      getAppAiConfig(),
      readAllCatalogItems(key),
    ]);
    if (!config) throw new HttpsError('failed-precondition', 'לא הוגדר ספק AI');
    const categories = catsSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    const ai = makeAI(config);

    const barcodes = Object.keys(items);
    const cachedSet = new Set();
    const CHUNK = 300;
    for (let i = 0; i < barcodes.length; i += CHUNK) {
      const chunk = barcodes.slice(i, i + CHUNK);
      const snaps = await db.getAll(...chunk.map(bc => db.collection('productCategories').doc(bc)));
      snaps.forEach(d => { if (d.exists) cachedSet.add(d.id); });
    }
    const todo = barcodes.filter(bc => !cachedSet.has(bc)).slice(0, batchSize);

    let processed = 0;
    await runWithConcurrency(todo, 15, async (bc) => {
      const name = items[bc].name;
      if (!name) return;
      try {
        const { category, subcategory } = await categorizeNameWithSubcategory(ai, name, categories);
        if (category) {
          await db.collection('productCategories').doc(bc).set({ category, subcategory: subcategory || null, categorizedAt: Date.now() }, { merge: true });
        }
        processed++;
      } catch (e) { /* leave this one for the next batch rather than aborting the whole run */ }
    });
    const remaining = Math.max(0, barcodes.length - cachedSet.size - processed);
    return { totalInCatalog: barcodes.length, alreadyCached: cachedSet.size, processedNow: processed, remaining };
  }
);

exports.categorizeItemName = onCall(
  { timeoutSeconds: 20, memory: '256MiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'categorizeItemName');
    const { name, categories } = request.data || {};
    if (!name || typeof name !== 'string' || !name.trim()) throw new HttpsError('invalid-argument', 'name required');
    const cats = Array.isArray(categories) && categories.length > 0 ? categories : [];
    if (cats.length === 0) return { category: null };
    if ((await monthlyCostSoFar(request.auth.uid)) >= FREE_TIER_MONTHLY_AI_CAP_USD) return { category: null };
    const config = await getAppAiConfig();
    if (!config) return { category: null };
    let ai;
    try { ai = makeAI(config); } catch (e) { return { category: null }; }
    try {
      const { category, usage } = await categorizeName(ai, name, cats.map(c => c.label));
      await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
      return { category };
    } catch (e) {
      return { category: null };
    }
  }
);

function cheapestModelId(models) {
  const priced = models.filter(m => m.price);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (a.price.in + a.price.out) <= (b.price.in + b.price.out) ? a : b).id;
}

exports.listProviderModels = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { provider, apiKey } = request.data || {};
    if (!apiKey || typeof apiKey !== 'string') throw new HttpsError('invalid-argument', 'apiKey required');

    async function fetchJson(url, headers) {
      let res;
      try { res = await fetch(url, { headers }); }
      catch (e) { throw new HttpsError('unavailable', `לא ניתן היה להגיע לספק: ${e.message}`); }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new HttpsError('permission-denied', 'מפתח ה-API נדחה. בדוק אותו ונסה שוב.');
        throw new HttpsError('failed-precondition', `לא ניתן היה לקבל רשימת מודלים (HTTP ${res.status}).`);
      }
      return res.json();
    }

    if (provider === 'openai') {
      const json = await fetchJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` });
      const EXCLUDE = /embedding|whisper|tts|dall-e|davinci|babbage|moderation|realtime|audio|transcribe|image|search/i;
      const models = (json.data || [])
        .filter(m => /^(gpt-|o[1-9]|chatgpt|chat-)/i.test(m.id) && !EXCLUDE.test(m.id))
        .map(m => ({ id: m.id, price: PRICING.openai[m.id] || null }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, cheapestId: cheapestModelId(models) };
    }
    if (provider === 'anthropic') {
      const json = await fetchJson('https://api.anthropic.com/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
      const models = (json.data || [])
        .map(m => ({ id: m.id, label: m.display_name || null, price: PRICING.anthropic[m.id] || null }))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return { models, cheapestId: cheapestModelId(models) };
    }
    if (provider === 'gemini') {
      const json = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {});
      const models = (json.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && !/embedding|aqa|imagen|veo/i.test(m.name))
        .map(m => { const id = m.name.replace(/^models\//, ''); return { id, label: m.displayName || null, price: PRICING.gemini[id] || null }; })
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, cheapestId: cheapestModelId(models) };
    }
    throw new HttpsError('invalid-argument', 'Unknown provider');
  }
);

exports.getCosts = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { scope } = request.data || {};
    if (scope === 'all') {
      await requireAdmin(request);
      const snap = await db.collectionGroup('months').get();
      const byUid = {};
      snap.forEach(doc => {
        const uid = doc.ref.parent.parent.id;
        (byUid[uid] = byUid[uid] || []).push({ month: doc.id, ...doc.data() });
      });
      return { users: Object.entries(byUid).map(([uid, months]) => ({ uid, months })) };
    }
    const snap = await db.collection('costLedger').doc(request.auth.uid).collection('months').get();
    const costs = {};
    snap.forEach(doc => { costs[doc.id] = doc.data(); });
    return { costs };
  }
);

// Non-AI call counts (the daily-cap ledger doubles as a usage view) — admin
// only, same shape as getCosts' scope:'all' so the client can merge them by
// uid into one "how much is this person actually using it" picture.
exports.getUsageStats = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    await requireAdmin(request);
    const snap = await db.collectionGroup('days').get();
    const byUid = {};
    snap.forEach(doc => {
      const uid = doc.ref.parent.parent.id;
      (byUid[uid] = byUid[uid] || []).push({ day: doc.id, ...doc.data() });
    });
    return { users: Object.entries(byUid).map(([uid, days]) => ({ uid, days })) };
  }
);

// Moved off a direct client-side Firestore write so it goes through the same
// daily-cap machinery as everything else — a create-only Firestore rule has
// no way to rate-limit, so a signed-in user could otherwise flood this
// collection with garbage documents at no cost to them (cheap Firestore
// writes, but real noise in the editor review queue). uid is set server-side
// too, closing off the (already narrow) option of forging someone else's.
exports.submitCategoryCorrection = onCall(
  { timeoutSeconds: 20, memory: '256MiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'submitCategoryCorrection');
    const { barcode, itemName, oldCategory, newCategory } = request.data || {};
    if (!barcode || !newCategory) throw new HttpsError('invalid-argument', 'barcode and newCategory required');
    await db.collection('categoryCorrections').add({
      barcode: String(barcode), itemName: String(itemName || '').trim(),
      oldCategory: oldCategory || null, newCategory: String(newCategory),
      uid: request.auth.uid, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true };
  }
);

// Same reasoning as submitCategoryCorrection — new threads AND replies now
// go through here instead of a direct client write, so both are covered by
// the daily cap. Handles both cases: no threadId creates a new thread,
// otherwise it appends to an existing one (the caller must own that thread,
// unless they're admin replying to someone else's).
exports.submitFeedbackMessage = onCall(
  { timeoutSeconds: 20, memory: '256MiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'submitFeedbackMessage');
    const { threadId, text, category, subject, senderName, senderEmail } = request.data || {};
    if (!text || typeof text !== 'string' || !text.trim()) throw new HttpsError('invalid-argument', 'text required');
    const uid = request.auth.uid;
    const userSnap = await db.collection('users').doc(uid).get();
    const isAdmin = (userSnap.data() || {}).role === 'admin';
    const message = { from: isAdmin ? 'admin' : 'user', text: text.trim(), timestamp: Date.now() };

    if (threadId) {
      const threadRef = db.collection('feedbackThreads').doc(String(threadId));
      const threadSnap = await threadRef.get();
      if (!threadSnap.exists) throw new HttpsError('not-found', 'thread not found');
      if (threadSnap.data().userId !== uid && !isAdmin) throw new HttpsError('permission-denied', 'not your thread');
      await threadRef.update({
        messages: admin.firestore.FieldValue.arrayUnion(message),
        lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
        lastFrom: message.from, unreadByUser: message.from === 'admin', unreadByAdmin: message.from === 'user',
      });
      return { ok: true, threadId };
    }

    const ref = await db.collection('feedbackThreads').add({
      userId: uid, senderName: String(senderName || ''), senderEmail: String(senderEmail || ''),
      category: category || 'general', subject: String(subject || '').trim(), currentView: 'home',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
      lastFrom: 'user', unreadByUser: false, unreadByAdmin: true,
      messages: [message],
    });
    return { ok: true, threadId: ref.id };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Price comparison — vendor price-transparency feeds (regulatory data, no AI
// anywhere in this feature). Configs below are reused as-is from Buli, where
// each was individually verified live against the real feed before being
// added — see the date/detail in each comment before assuming a new vendor
// works the same way as its neighbors.
// ─────────────────────────────────────────────────────────────────────────────
const VENDORS = {
  ramiLevy: { ftpUser: 'RamiLevi' },
  osherAd: { ftpUser: 'osherad' },
  keshet: { ftpUser: 'Keshet' },
  yohananof: { ftpUser: 'yohananof' },
  superYuda: { ftpUser: 'yuda_ho', ftpPassword: 'Yud@147', ftpPath: '/Yuda' },
  lahav: { ftpUser: 'freshmarket' },
  shufersal: { http: 'shufersal' },
  carrefour: { http: 'carrefour' },
  tivTaam: { ftpUser: 'TivTaam' },
  salachDabach: { ftpUser: 'SalachD', ftpPassword: '12345' },
  stopMarket: { ftpUser: 'Stop_Market' },
  victory: { http: 'laibcatalog', chainId: '7290696200003' },
  mahsaniAshuk: { http: 'laibcatalog', chainId: '7290661400001' },
  haziHinam: { http: 'haziHinam', chainId: '7290700100008' },
  wolt: { http: 'wolt', chainId: '7290058249350' },
};
const VENDOR_LABELS = {
  ramiLevy: 'רמי לוי', osherAd: 'אושר עד', keshet: 'קשת טעמים', yohananof: 'יוחננוף',
  superYuda: 'סופר יודה', lahav: 'פרש מרקט', shufersal: 'שופרסל', carrefour: 'קרפור',
  tivTaam: 'טיב טעם', salachDabach: 'סלאח דבאח', stopMarket: 'סטופ מרקט', victory: 'ויקטורי',
  mahsaniAshuk: 'מחסני השוק', haziHinam: 'חצי חינם', wolt: 'וולט מרקט',
};
const VENDOR_IDS = Object.keys(VENDORS);
const FTP_HOST = 'url.retail.publishedprices.co.il';
const SHUFERSAL_BASE_URL = 'https://prices.shufersal.co.il';
const SHUFERSAL_CAT_ID = { stores: 5, priceFull: 2, promoFull: 4 };
const CARREFOUR_BASE_URL = 'https://prices.carrefour.co.il';
const LAIBCATALOG_BASE_URL = 'https://laibcatalog.co.il';
const HAZI_HINAM_BASE_URL = 'https://shop.hazi-hinam.co.il';
const WOLT_BASE_URL = 'https://wm-gateway.wolt.com/isr-prices/public/v1';
const CATALOG_STALENESS_MS = 18 * 60 * 60 * 1000; // 18h — matches the feed's own refresh cadence
// This is a single budget shared across EVERY active profile a user has —
// instore branches and auto-provisioned online vendors together, across
// all of their lists, not per-list. At 8 it was silently dropping the
// newest profile once instore + online combined crossed the cap (found via
// a real report: a second physical branch someone had just added never
// got prices, because 3 auto-provisioned online profiles plus 6 existing
// instore ones already filled the budget — no error, it just vanished from
// every price lookup). Raised well above the real ceiling (15 vendors,
// even doubled for a couple of same-vendor branches) so this can't recur.
const DEFAULT_MAX_ACTIVE_VENDORS = 30;

function asArray(x) { return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]; }
function docKey(vendor, branchId) { return `${vendor}__${branchId}`; }

// A full vendor catalog (5,000-20,000+ items) blows straight through
// Firestore's 1MB-per-document limit as a single map field — a real chain's
// catalog silently failed to save that way (the small index doc committed
// fine, the big catalog doc didn't, leaving a permanent "looks ready but is
// actually empty" state). Each item is its own tiny document in a
// subcollection instead, which also turns a per-barcode price lookup into a
// cheap point read instead of downloading the whole catalog.
async function writeCatalogItems(key, items) {
  const barcodes = Object.keys(items);
  const BATCH_SIZE = 400; // Firestore caps a batch at 500 writes; keep margin
  for (let i = 0; i < barcodes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    // merge: true — a plain overwrite here would wipe any field a later
    // feature adds to an item doc (e.g. a cached category) every time this
    // branch's price feed refreshes, since a fresh scrape only ever knows
    // about name/price/unit/manufacturer.
    barcodes.slice(i, i + BATCH_SIZE).forEach(bc => {
      batch.set(db.collection('vendorCatalogs').doc(key).collection('items').doc(bc), items[bc], { merge: true });
    });
    await batch.commit();
  }
}
async function readAllCatalogItems(key) {
  const snap = await db.collection('vendorCatalogs').doc(key).collection('items').get();
  const items = {};
  snap.forEach(d => { items[d.id] = d.data(); });
  return items;
}
// One document per item is what keeps a single catalog under Firestore's
// 1MB doc cap (see writeCatalogItems), but that means looking up N barcodes
// one-by-one costs N separate round-trips — the more items a list has, the
// slower opening it gets. getAll() fetches many docs in a single RPC, so
// this scales with round-trips instead of with barcode count. Chunked well
// under any practical getAll limit so one huge list can't misbehave.
async function readCatalogItemsBatch(key, barcodes) {
  const out = {};
  if (!barcodes || barcodes.length === 0) return out;
  const CHUNK = 300;
  const chunks = [];
  for (let i = 0; i < barcodes.length; i += CHUNK) chunks.push(barcodes.slice(i, i + CHUNK));
  await Promise.all(chunks.map(async (chunk) => {
    const refs = chunk.map(bc => db.collection('vendorCatalogs').doc(key).collection('items').doc(bc));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, i) => { out[chunk[i]] = snap.exists ? snap.data() : null; });
  }));
  return out;
}

function decodeXmlBuffer(buf) {
  const text = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^﻿/, '');
}
function normalizeItemName(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function itemNameKey(name) { return require('crypto').createHash('sha1').update(normalizeItemName(name)).digest('hex'); }

// basic-ftp's own client timeout doesn't reliably abort every stuck TLS
// handshake in a Cloud Run container — an explicit outer race turns a real
// network hang into a clean rejection instead of the caller waiting up to
// the full function timeout with no feedback.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error((label || 'operation') + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

async function ftpConnect(vendor) {
  console.log('ftpConnect: connecting', vendor, FTP_HOST);
  const ftp = require('basic-ftp');
  const client = new ftp.Client(20000);
  try {
    await withTimeout(client.access({
      host: FTP_HOST, user: VENDORS[vendor].ftpUser, password: VENDORS[vendor].ftpPassword || '',
      secure: true, secureOptions: { rejectUnauthorized: false },
    }), 20000, 'FTP connect');
  } catch (e) {
    console.error('ftpConnect: FAILED', vendor, e && e.message);
    throw e;
  }
  console.log('ftpConnect: access ok', vendor);
  if (VENDORS[vendor].ftpPath) await withTimeout(client.cd(VENDORS[vendor].ftpPath), 10000, 'FTP cd');
  return client;
}
async function ftpDownloadBuffer(client, fileName) {
  const { Writable } = require('stream');
  const chunks = [];
  const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
  await withTimeout(client.downloadTo(sink, fileName), 90000, 'FTP download');
  return Buffer.concat(chunks);
}
// A single-entry ZIP's local file header: magic, compression method,
// compressed size, and the name/extra field lengths needed to find where
// the actual entry data starts (fixed 30-byte header, see APPNOTE.TXT).
function unzipSingleEntry(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a valid zip local file header');
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const compData = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return compData;
  if (method === 8) return require('zlib').inflateRawSync(compData);
  throw new Error('unsupported zip compression method ' + method);
}
// Some chains' feeds name a file "...gz" that's actually a ZIP archive (one
// XML entry inside) rather than a gzip stream — happened with Rami Levy's
// online-branch (039) feed specifically, which crashed gunzipSync with
// "incorrect header check" and, since that failure was swallowed upstream,
// silently left that branch's catalog permanently un-cached. Detecting by
// the real magic bytes instead of trusting the extension survives that.
function parseXmlBuffer(buf, isGz) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) buf = unzipSingleEntry(buf);
  else if (isGz || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = require('zlib').gunzipSync(buf);
  const { XMLParser } = require('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: { maxTotalExpansions: 100000 } });
  return parser.parse(decodeXmlBuffer(buf));
}
async function ftpDownloadXmlObject(client, fileEntry) {
  const buf = await ftpDownloadBuffer(client, fileEntry.name);
  return parseXmlBuffer(buf, fileEntry.name.endsWith('.gz'));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('HTTP request timed out fetching ' + url)); });
  });
}
async function shufersalListFiles(catId, storeId) {
  const qs = storeId ? `catID=${catId}&storeId=${storeId}` : `catID=${catId}`;
  const html = (await httpGet(`${SHUFERSAL_BASE_URL}/FileObject/UpdateCategory?${qs}`)).toString('utf8');
  const matches = [...html.matchAll(/href="(https:\/\/pricesprodpublic[^"]+\.gz\?[^"]*)"/g)];
  return matches.map((m) => {
    const url = m[1].replace(/&amp;/g, '&');
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]);
    return { name, url };
  });
}
async function shufersalDownloadXmlObject(fileEntry) {
  const buf = await httpGet(fileEntry.url);
  return parseXmlBuffer(buf, /\.gz(\?|$)/i.test(fileEntry.url) || fileEntry.name.endsWith('.gz'));
}
async function carrefourListFiles() {
  const html = (await httpGet(`${CARREFOUR_BASE_URL}/`)).toString('utf8');
  const pathMatch = html.match(/const path = ['"]([^'"]+)['"]/);
  const filesMatch = html.match(/const files = (\[[\s\S]*?\]);/);
  if (!pathMatch || !filesMatch) return [];
  const path = pathMatch[1];
  const files = JSON.parse(filesMatch[1]);
  return files.map((f) => ({ name: f.name, url: `${CARREFOUR_BASE_URL}/${path}/${f.name}` }));
}
async function carrefourDownloadXmlObject(fileEntry) {
  const buf = await httpGet(fileEntry.url);
  return parseXmlBuffer(buf, fileEntry.name.endsWith('.gz'));
}
async function laibcatalogListFiles(chainId) {
  const buf = await httpGet(`${LAIBCATALOG_BASE_URL}/webapi/api/getfiles?edi=${chainId}`);
  const files = JSON.parse(buf.toString('utf8'));
  return files.map((f) => ({ name: f.fileName, url: `${LAIBCATALOG_BASE_URL}/webapi/${chainId}/${f.fileName}` }));
}
async function laibcatalogDownloadXmlObject(fileEntry) {
  const buf = await httpGet(fileEntry.url);
  return parseXmlBuffer(buf, fileEntry.name.endsWith('.gz'));
}
async function haziHinamListFiles(typeId) {
  const date = new Date().toISOString().slice(0, 10);
  let page = 1, maxPage = 1;
  const all = [];
  do {
    const html = (await httpGet(`${HAZI_HINAM_BASE_URL}/Prices?p=${page}&s=&f=null&t=${typeId}&d=${date}`)).toString('utf8');
    const pageNums = [...html.matchAll(/pagination-link" href="\?p=(\d+)/g)].map((m) => parseInt(m[1], 10));
    if (pageNums.length > 0) maxPage = Math.max(maxPage, Math.max(...pageNums));
    const rows = html.match(/<tr[\s\S]*?<\/tr>/g) || [];
    rows.forEach((row) => {
      const nameMatch = row.match(/([\w-]+\.gz)/);
      const urlMatch = row.match(/href="([^"]+\.gz)"/);
      if (nameMatch && urlMatch) all.push({ name: nameMatch[1], url: urlMatch[1] });
    });
    page++;
  } while (page <= maxPage && page <= 20);
  return all;
}
async function haziHinamDownloadXmlObject(fileEntry) {
  const buf = await httpGet(fileEntry.url);
  return parseXmlBuffer(buf, fileEntry.name.endsWith('.gz'));
}
async function woltListFiles() {
  const date = new Date().toISOString().slice(0, 10);
  const html = (await httpGet(`${WOLT_BASE_URL}/${date}.html`)).toString('utf8');
  const matches = [...html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)];
  return matches.map((m) => ({ name: m[2], url: `${WOLT_BASE_URL}/${m[1]}` }));
}
async function woltDownloadXmlObject(fileEntry) {
  const buf = await httpGet(fileEntry.url);
  return parseXmlBuffer(buf, fileEntry.name.endsWith('.gz'));
}

// Israel's official settlement-code registry (same dataset getIsraeliCities
// uses) — despite the schema calling it "City", most chains' real store
// feeds put the numeric סמל ישוב (settlement code) in that field instead of
// an actual city name (confirmed across every vendor checked: Carrefour,
// Rami Levy, Shufersal, Yohananof were all 100% numeric). Left unresolved,
// this breaks both text search (a real city name a user types never
// matches the stored code) and geocoding (the address query sent to
// Nominatim included the bare code instead of a real place name).
async function getSettlementCityMap() {
  const cacheRef = db.collection('staticData').doc('settlementCodes');
  const cached = await cacheRef.get();
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  if (cached.exists && Date.now() - (cached.data().updatedAt || 0) < ONE_WEEK_MS) {
    return cached.data().map || {};
  }
  const res = await fetch('https://data.gov.il/api/3/action/datastore_search?resource_id=d4901968-dad3-4845-a9b0-a57d027f11ab&limit=1500');
  const json = await res.json();
  const map = {};
  (json.result.records || []).forEach(r => {
    const code = r['סמל_ישוב'];
    const name = (r['שם_ישוב'] || '').trim();
    if (code != null && name) map[String(code)] = name;
  });
  await cacheRef.set({ map, updatedAt: Date.now() });
  return map;
}
function branchesFromStoresXml(obj, cityMap) {
  const root = obj.Root || obj.Chain || {};
  const branches = {};
  for (const subChain of asArray(root.SubChains?.SubChain)) {
    for (const s of asArray(subChain.Stores?.Store)) {
      const id = String(s.StoreID ?? '').padStart(3, '0');
      if (!id || id === '000') continue;
      // Latitude/Longitude aren't in every chain's feed (some leave them
      // blank or 0) — null rather than a bogus 0,0 coordinate so "nearby
      // branches" can skip these instead of showing them at the equator.
      const lat = parseFloat(s.Latitude);
      const lng = parseFloat(s.Longitude);
      const rawCity = String(s.City ?? '').trim();
      const city = (cityMap && /^\d+$/.test(rawCity) && cityMap[rawCity]) ? cityMap[rawCity] : rawCity;
      branches[id] = {
        name: String(s.StoreName ?? '').trim() || `Store ${id}`,
        address: String(s.Address ?? '').replace(/&#x0?[dDaA];/g, '').replace(/[\r\n]+/g, '').trim(),
        city,
        lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
        lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
      };
    }
  }
  return branches;
}
function itemsFromPriceXml(obj) {
  const root = obj.Root || {};
  const items = {};
  for (const item of asArray(root.Items?.Item)) {
    const barcode = String(item.ItemCode ?? '').trim();
    const price = parseFloat(item.ItemPrice);
    if (!barcode || !Number.isFinite(price)) continue;
    // A couple of feeds (seen on Rami Levy's online-branch feed) use ItemNm
    // / ManufacturerName instead of the usual ItemName / ManufactureName —
    // without this fallback every item silently came through nameless.
    const manufacturer = String(item.ManufactureName ?? item.ManufacturerName ?? '').trim();
    items[barcode] = {
      name: String(item.ItemName ?? item.ItemNm ?? '').trim(), price,
      unit: String(item.UnitOfMeasure ?? item.UnitQty ?? '').trim(),
      manufacturer: manufacturer === 'לא ידוע' ? '' : manufacturer,
    };
  }
  return items;
}
function promotionsFromXml(obj) {
  const root = obj.Root || {};
  const now = Date.now();
  const promotions = [];
  for (const promo of asArray(root.Promotions?.Promotion)) {
    const endDate = String(promo.PromotionEndDateTime ?? '').trim();
    if (endDate && new Date(endDate).getTime() < now) continue;
    const groups = asArray(promo.Groups?.Group);
    if (groups.length > 1) continue;
    const items = [];
    for (const group of groups) {
      for (const item of asArray(group.PromotionItems?.PromotionItem)) {
        const barcode = String(item.ItemCode ?? '').trim();
        if (!barcode || barcode === '0') continue;
        items.push({
          barcode, minQty: Number(item.MinQty) || 1,
          discountedPrice: Number.isFinite(parseFloat(item.DiscountedPrice)) && parseFloat(item.DiscountedPrice) > 0 ? parseFloat(item.DiscountedPrice) : null,
          discountRate: Number.isFinite(parseFloat(item.DiscountRate)) && parseFloat(item.DiscountRate) > 0 ? parseFloat(item.DiscountRate) : null,
          weighted: Number(item.bIsWeighted) === 1,
        });
      }
    }
    if (items.length === 0) continue;
    promotions.push({
      id: String(promo.PromotionID ?? '').trim(),
      description: String(promo.PromotionDescription || promo.Remarks || '').trim(),
      endDate,
      additionalIsCoupon: Number(promo.AdditionalIsCoupon) === 1,
      items,
    });
  }
  return promotions;
}
function promoPricesByBarcode(promotions) {
  const byBarcode = {};
  for (const promo of promotions) {
    if (promo.additionalIsCoupon) continue;
    for (const item of promo.items) {
      if (item.discountedPrice == null && item.discountRate == null) continue;
      const candidate = { discountedPrice: item.discountedPrice, discountRate: item.discountRate, minQty: item.minQty || 1, weighted: !!item.weighted };
      const existing = byBarcode[item.barcode];
      if (!existing) { byBarcode[item.barcode] = candidate; continue; }
      if (candidate.minQty < existing.minQty) { byBarcode[item.barcode] = candidate; continue; }
      if (candidate.minQty > existing.minQty) continue;
      if (existing.discountedPrice == null && candidate.discountedPrice != null) { byBarcode[item.barcode] = candidate; continue; }
      if (existing.discountedPrice != null && candidate.discountedPrice != null && candidate.discountedPrice < existing.discountedPrice) { byBarcode[item.barcode] = candidate; continue; }
      if (existing.discountedPrice == null && candidate.discountedPrice == null && candidate.discountRate > existing.discountRate) { byBarcode[item.barcode] = candidate; }
    }
  }
  return byBarcode;
}
function effectivePromoInfo(promo, catalogPrice) {
  if (!promo) return null;
  const minQty = promo.minQty || 1;
  let price = null;
  if (promo.discountedPrice != null) {
    price = promo.weighted ? promo.discountedPrice : Math.round((promo.discountedPrice / minQty) * 100) / 100;
  } else if (promo.discountRate != null && catalogPrice != null) {
    price = Math.round(catalogPrice * (1 - promo.discountRate / 100) * 100) / 100;
  }
  if (price == null) return null;
  return { price, minQty: promo.weighted ? 1 : minQty, discountedPrice: promo.discountedPrice, discountRate: promo.discountRate };
}
function sameIsraelDate(ts1, ts2) {
  if (!ts1 || !ts2) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(ts1)) === fmt.format(new Date(ts2));
}

async function ingestVendorBranches(vendor) {
  let obj;
  const v = VENDORS[vendor];
  if (v.http === 'shufersal') {
    const files = await shufersalListFiles(SHUFERSAL_CAT_ID.stores);
    const storeFiles = files.filter(f => /^stores/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    if (storeFiles.length === 0) return null;
    obj = await shufersalDownloadXmlObject(storeFiles[0]);
  } else if (v.http === 'carrefour') {
    const files = await carrefourListFiles();
    const storeFiles = files.filter(f => /^stores/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    if (storeFiles.length === 0) return null;
    obj = await carrefourDownloadXmlObject(storeFiles[0]);
  } else if (v.http === 'laibcatalog') {
    const files = await laibcatalogListFiles(v.chainId);
    const storeFiles = files.filter(f => /^stores/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    if (storeFiles.length === 0) return null;
    obj = await laibcatalogDownloadXmlObject(storeFiles[0]);
  } else if (v.http === 'haziHinam') {
    const files = (await haziHinamListFiles(3)).sort((a, b) => b.name.localeCompare(a.name));
    if (files.length === 0) return null;
    obj = await haziHinamDownloadXmlObject(files[0]);
  } else if (v.http === 'wolt') {
    const files = await woltListFiles();
    const storeFiles = files.filter(f => /^stores/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    if (storeFiles.length === 0) return null;
    obj = await woltDownloadXmlObject(storeFiles[0]);
  } else {
    const client = await ftpConnect(vendor);
    try {
      const list = await withTimeout(client.list(), 45000, 'FTP list');
      const storeFiles = list.filter(f => /^stores/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
      if (storeFiles.length === 0) return null;
      obj = await ftpDownloadXmlObject(client, storeFiles[0]);
    } finally { client.close(); }
  }
  const cityMap = await getSettlementCityMap();
  const branches = branchesFromStoresXml(obj, cityMap);
  if (Object.keys(branches).length === 0) return null;
  // schemaVersion 2 = branches carry lat/lng, 3 = city resolved from a
  // settlement code to a real name — bumping it forces a one-time re-ingest
  // of anything cached under an older schema, without permanently
  // re-fetching chains whose feed just doesn't have that data at all.
  await db.collection('vendorBranches').doc(vendor).set({ branches, updatedAt: Date.now(), schemaVersion: 3 });
  return branches;
}

async function pickFile(vendor, branchId, kind) {
  // kind: 'price' | 'promo'
  const v = VENDORS[vendor];
  const full = kind === 'price' ? 'pricefull' : 'promofull';
  const loose = kind === 'price' ? 'price' : 'promo';
  let files;
  if (v.http === 'shufersal') {
    files = await shufersalListFiles(kind === 'price' ? SHUFERSAL_CAT_ID.priceFull : SHUFERSAL_CAT_ID.promoFull, parseInt(branchId, 10));
  } else if (v.http === 'carrefour') {
    files = (await carrefourListFiles()).filter(f => f.name.includes(`-${branchId}-`));
  } else if (v.http === 'laibcatalog') {
    files = (await laibcatalogListFiles(v.chainId)).filter(f => f.name.includes(`-${branchId}-`));
  } else if (v.http === 'haziHinam') {
    files = (await haziHinamListFiles(kind === 'price' ? 1 : 2)).filter(f => f.name.includes(`-${branchId}-`));
  } else if (v.http === 'wolt') {
    files = (await woltListFiles()).filter(f => f.name.includes(`-${branchId}-`));
  } else {
    return { ftp: true };
  }
  let candidates = files.filter(f => new RegExp(full, 'i').test(f.name));
  if (candidates.length === 0) candidates = files.filter(f => new RegExp(loose, 'i').test(f.name));
  candidates.sort((a, b) => b.name.localeCompare(a.name));
  const pick = candidates[0];
  if (!pick) throw new HttpsError('not-found', `No ${kind} file found for ${vendor} branch ${branchId}`);
  if (v.http === 'shufersal') return { obj: await shufersalDownloadXmlObject(pick) };
  if (v.http === 'carrefour') return { obj: await carrefourDownloadXmlObject(pick) };
  if (v.http === 'laibcatalog') return { obj: await laibcatalogDownloadXmlObject(pick) };
  if (v.http === 'haziHinam') return { obj: await haziHinamDownloadXmlObject(pick) };
  if (v.http === 'wolt') return { obj: await woltDownloadXmlObject(pick) };
}

async function ingestVendorCatalog(vendor, branchId) {
  console.log('ingestVendorCatalog: start', vendor, branchId);
  let obj;
  const picked = await pickFile(vendor, branchId, 'price');
  console.log('ingestVendorCatalog: pickFile done', vendor, branchId, 'ftp=', !!picked.ftp);
  if (picked.ftp) {
    const client = await ftpConnect(vendor);
    console.log('ingestVendorCatalog: FTP connected', vendor);
    try {
      const list = await withTimeout(client.list(), 45000, 'FTP list');
      console.log('ingestVendorCatalog: FTP list done', vendor, 'fileCount=', list.length);
      const branchFiles = list.filter(f => f.name.includes(`-${branchId}-`));
      let candidates = branchFiles.filter(f => /pricefull/i.test(f.name));
      if (candidates.length === 0) candidates = branchFiles.filter(f => /price/i.test(f.name));
      candidates.sort((a, b) => b.name.localeCompare(a.name));
      const pick = candidates[0];
      if (!pick) throw new HttpsError('not-found', `No price file found for ${vendor} branch ${branchId}`);
      console.log('ingestVendorCatalog: downloading', vendor, pick.name);
      obj = await ftpDownloadXmlObject(client, pick);
      console.log('ingestVendorCatalog: download done', vendor);
    } finally { client.close(); }
  } else {
    obj = picked.obj;
  }
  const items = itemsFromPriceXml(obj);
  console.log('ingestVendorCatalog: parsed', vendor, branchId, 'itemCount=', Object.keys(items).length);
  const sizeBytes = Buffer.byteLength(JSON.stringify(items));
  const updatedAt = Date.now();
  const key = docKey(vendor, branchId);
  await writeCatalogItems(key, items);
  await db.collection('vendorCatalogIndex').doc(key).set({ updatedAt, sizeBytes, itemCount: Object.keys(items).length });
  console.log('ingestVendorCatalog: saved', vendor, branchId);
  return items;
}

async function ingestVendorPromotions(vendor, branchId) {
  let obj;
  const picked = await pickFile(vendor, branchId, 'promo');
  if (picked.ftp) {
    const client = await ftpConnect(vendor);
    try {
      const list = await withTimeout(client.list(), 45000, 'FTP list');
      const branchFiles = list.filter(f => f.name.includes(`-${branchId}-`));
      let candidates = branchFiles.filter(f => /promofull/i.test(f.name));
      if (candidates.length === 0) candidates = branchFiles.filter(f => /promo/i.test(f.name));
      candidates.sort((a, b) => b.name.localeCompare(a.name));
      const pick = candidates[0];
      if (!pick) throw new HttpsError('not-found', `No promo file found for ${vendor} branch ${branchId}`);
      obj = await ftpDownloadXmlObject(client, pick);
    } finally { client.close(); }
  } else {
    obj = picked.obj;
  }
  const promotions = promotionsFromXml(obj);
  const sizeBytes = Buffer.byteLength(JSON.stringify(promotions));
  const updatedAt = Date.now();
  const key = docKey(vendor, branchId);
  await Promise.all([
    db.collection('vendorPromotions').doc(key).set({ promotions, updatedAt, sizeBytes }),
    db.collection('vendorPromotionsIndex').doc(key).set({ updatedAt, sizeBytes, promotionCount: promotions.length }),
    db.collection('vendorPromoPrices').doc(key).set(promoPricesByBarcode(promotions)),
  ]);
  return promotions;
}

async function ensureFreshCatalog(vendor, branchId, force) {
  const key = docKey(vendor, branchId);
  const indexSnap = await db.collection('vendorCatalogIndex').doc(key).get();
  const updatedAt = indexSnap.exists ? indexSnap.data().updatedAt : null;
  if (!force && updatedAt) {
    const items = await readAllCatalogItems(key);
    if (Date.now() - updatedAt >= CATALOG_STALENESS_MS) {
      ingestVendorCatalog(vendor, branchId).catch(() => {});
    }
    return items;
  }
  return ingestVendorCatalog(vendor, branchId);
}

// Disabled while there are effectively no real daily users — this used to
// run unconditionally every 12 hours, doing a full catalog re-fetch and
// rewrite (thousands of Firestore writes) for every tracked vendor/branch
// whether or not anyone actually used it that day. ensureFreshCatalog's own
// 18h staleness check already covers "keep it fresh for real usage" on
// demand, at zero cost for branches nobody queries. The tradeoff: the first
// search of the day against a given branch now pays a live ~30-50s
// re-ingest instead of hitting a pre-warmed cache — worth re-enabling this
// (or a lighter, usage-aware version of it) once real daily traffic makes
// that latency worth paying to avoid.

// Branch/store lists had no refresh at all before this — once ingested for
// a vendor they were cached forever (barring a schemaVersion bump), so a
// newly opened physical branch would just never appear. Store lists are
// small and store openings are rare, so weekly for every vendor (not just
// ones someone's actively tracking) is cheap and keeps this from silently
// going stale again.
exports.refreshVendorBranches = onSchedule(
  { schedule: 'every 168 hours', region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    await Promise.all(VENDOR_IDS.map(v => ingestVendorBranches(v).catch(() => {})));
  }
);

// Tiers are spaced 100+ apart on purpose — fuzzyMatchCatalogs adds a small
// (+20 max) bonus for a barcode priced at every searched vendor, and that
// bonus must never be able to push a weaker match above a stronger one
// (e.g. a "contains the word" hit at 3 vendors outranking an exact-name hit
// at 1 vendor). Exact name, then starts-with, then same-lead-word, then
// "has every query word somewhere", then a loose single-word substring.
function scoreCatalogName(name, q, qTokens) {
  const nameTokens = name.split(' ').filter(Boolean);
  if (name === q) return 1000;
  if (qTokens.length > 1 && !nameTokens.includes(qTokens[0])) return null;
  const overlap = qTokens.filter(t => nameTokens.includes(t)).length;
  if (overlap > 0 && overlap === qTokens.length) {
    if (nameTokens.slice(0, qTokens.length).join(' ') === q) return 900;
    if (nameTokens[0] === qTokens[0]) return 800;
    return 700;
  }
  if (qTokens.length > 1) return null;
  if (name.includes(q) || q.includes(name)) return 100;
  return null;
}

function fuzzyMatchCatalogs(query, catalogsByVendor, promoPricesByVendor) {
  const q = normalizeItemName(query);
  const qTokens = q.split(' ').filter(Boolean);
  const vendorNames = Object.keys(catalogsByVendor);
  const byBarcode = {};
  for (const vendor of vendorNames) {
    for (const [barcode, item] of Object.entries(catalogsByVendor[vendor] || {})) {
      const name = normalizeItemName(item.name);
      if (!name) continue;
      const score = scoreCatalogName(name, q, qTokens);
      if (score === null) continue;
      if (!byBarcode[barcode]) byBarcode[barcode] = { barcode, name: item.name, unit: item.unit, manufacturer: item.manufacturer || '', bestScore: -1, prices: {} };
      const entry = byBarcode[barcode];
      entry.prices[vendor] = item.price;
      if (score > entry.bestScore) { entry.bestScore = score; entry.name = item.name; entry.unit = item.unit; entry.manufacturer = item.manufacturer || ''; }
    }
  }
  for (const entry of Object.values(byBarcode)) {
    for (const vendor of vendorNames) {
      if (entry.prices[vendor] === undefined) {
        const other = (catalogsByVendor[vendor] || {})[entry.barcode];
        if (other) entry.prices[vendor] = other.price;
      }
    }
  }
  const list = Object.values(byBarcode).map(entry => {
    const promoPrices = {};
    for (const vendor of vendorNames) {
      const promo = promoPricesByVendor && promoPricesByVendor[vendor] && promoPricesByVendor[vendor][entry.barcode];
      const info = effectivePromoInfo(promo, entry.prices[vendor]);
      if (info) promoPrices[vendor] = info;
    }
    return {
      barcode: entry.barcode, name: entry.name, unit: entry.unit, manufacturer: entry.manufacturer,
      score: entry.bestScore + (vendorNames.length > 1 && vendorNames.every(v => entry.prices[v] != null) ? 20 : 0),
      prices: entry.prices, promoPrices,
    };
  });
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, 40);
}

async function getUserActiveProfiles(uid) {
  const snap = await db.collection('users').doc(uid).collection('vendorProfiles')
    .where('active', '==', true).get();
  const rows = snap.docs
    .filter(d => VENDOR_IDS.includes(d.data().vendor) && d.data().branchId)
    .map(d => ({ id: d.id, vendor: d.data().vendor, branchId: String(d.data().branchId), addedAt: d.data().addedAt || 0 }));
  rows.sort((a, b) => (a.addedAt?.toMillis?.() || a.addedAt || 0) - (b.addedAt?.toMillis?.() || b.addedAt || 0));
  return rows.slice(0, DEFAULT_MAX_ACTIVE_VENDORS).map(({ id, vendor, branchId }) => ({ id, vendor, branchId }));
}

exports.getVendorList = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    return { vendors: VENDOR_IDS.map(id => ({ id, label: VENDOR_LABELS[id] || id })) };
  }
);

// Israel's official government locality list (data.gov.il, ~1,270 real
// cities/settlements) — used for the profile address city dropdown so it
// only ever offers real places, not free text. Cached in Firestore and
// refreshed at most weekly; this list changes extremely rarely.
exports.getIsraeliCities = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const cacheRef = db.collection('staticData').doc('israeliCities');
    const cached = await cacheRef.get();
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    if (cached.exists && Date.now() - (cached.data().updatedAt || 0) < ONE_WEEK_MS) {
      return { cities: cached.data().cities };
    }
    const res = await fetch('https://data.gov.il/api/3/action/datastore_search?resource_id=d4901968-dad3-4845-a9b0-a57d027f11ab&limit=1500');
    const json = await res.json();
    const cities = [...new Set((json.result.records || []).map(r => (r['שם_ישוב'] || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'he'));
    await cacheRef.set({ cities, updatedAt: Date.now() });
    return { cities };
  }
);

exports.getVendorBranches = onCall(
  { timeoutSeconds: 180, memory: '512MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { vendor } = request.data || {};
    console.log('getVendorBranches: start', vendor);
    if (!VENDORS[vendor]) throw new HttpsError('invalid-argument', 'valid vendor required');
    const snap = await db.collection('vendorBranches').doc(vendor).get();
    const cached = snap.data() || {};
    let branches = cached.branches;
    if (!branches || Object.keys(branches).length === 0 || cached.schemaVersion !== 3) {
      console.log('getVendorBranches: no cache or stale schema, ingesting', vendor);
      branches = await ingestVendorBranches(vendor);
    }
    console.log('getVendorBranches: done', vendor, 'count=', Object.keys(branches || {}).length);
    return { branches: branches || {} };
  }
);

// Geocodes one small batch of a vendor's still-uncoordinated branches via
// Nominatim (OpenStreetMap) — free, no API key, but its usage policy caps
// requests at ~1/second, so a full chain (hundreds of branches) has to be
// walked in batches across several client-driven calls rather than done in
// one shot. Results are written back into the same vendorBranches doc the
// branch list already lives in, so once a branch is geocoded every user
// benefits from it, not just whoever triggered it. A branch that fails to
// geocode is marked geocodeFailed so it's skipped on future batches instead
// of being retried (and re-delaying) forever.
exports.geocodeVendorBranchesBatch = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { vendor } = request.data || {};
    if (!VENDORS[vendor]) throw new HttpsError('invalid-argument', 'valid vendor required');
    const batchSize = 15;
    const ref = db.collection('vendorBranches').doc(vendor);
    const snap = await ref.get();
    const data = snap.data() || {};
    const branches = data.branches || {};
    const ids = Object.keys(branches);
    const pending = ids.filter(id => branches[id].lat == null && !branches[id].geocodeFailed);
    const toProcess = pending.slice(0, batchSize);

    for (let i = 0; i < toProcess.length; i++) {
      const id = toProcess[i];
      const b = branches[id];
      const q = [b.address, b.city, 'ישראל'].filter(Boolean).join(', ');
      try {
        const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=il&q=' + encodeURIComponent(q), {
          headers: { 'User-Agent': 'SuperZola/1.0 (https://superzola.web.app)' },
        });
        const results = await res.json();
        if (Array.isArray(results) && results.length > 0) {
          branches[id] = { ...b, lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
        } else {
          branches[id] = { ...b, geocodeFailed: true };
        }
      } catch (e) {
        branches[id] = { ...b, geocodeFailed: true };
      }
      if (i < toProcess.length - 1) await new Promise(r => setTimeout(r, 1100));
    }

    if (toProcess.length > 0) await ref.update({ branches });
    const remaining = ids.filter(id => branches[id].lat == null && !branches[id].geocodeFailed).length;
    return { processed: toProcess.length, remaining, total: ids.length, branches };
  }
);

// Fired (without the client waiting on it) right after a vendor+branch is
// added in Settings, so the first real price search against it doesn't have
// to pay for a cold catalog ingest — by the time someone opens an item
// dialog and searches, the branch's catalog is very likely already cached.
exports.prewarmVendorCatalog = onCall(
  { timeoutSeconds: 120, memory: '512MiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'prewarmVendorCatalog');
    const { vendor, branchId, force } = request.data || {};
    if (!VENDORS[vendor] || !branchId) throw new HttpsError('invalid-argument', 'vendor and branchId required');
    // A forced refresh is a real, synchronous re-scrape of the vendor's
    // live feed (not the "warm the cache in the background" default) —
    // gated to editor/admin so it can't be triggered ad hoc by every user.
    if (force) await requireEditorOrAdmin(request);
    await ensureFreshCatalog(vendor, String(branchId), !!force).catch(() => {});
    const snap = await db.collection('vendorCatalogIndex').doc(docKey(vendor, String(branchId))).get();
    return { ok: true, updatedAt: (snap.data() || {}).updatedAt || null };
  }
);

exports.resolveItemBarcodes = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'resolveItemBarcodes');
    const { items, force, vendors, profileIds } = request.data || {};
    console.log('resolveItemBarcodes: start', { uid: request.auth.uid, items, force, vendors, profileIds });
    if (!Array.isArray(items) || items.length === 0) throw new HttpsError('invalid-argument', 'items array required');

    const allActiveProfiles = await getUserActiveProfiles(request.auth.uid);
    // A vendor can have more than one active profile at once (a physical
    // branch for in-store lists, a separate branch for online lists) — the
    // caller tells us exactly which profiles its list actually cares about,
    // so a vendor with two profiles never gets an arbitrary one of them
    // picked as "the" representative for pricing/matching.
    const activeProfiles = Array.isArray(profileIds) && profileIds.length > 0
      ? allActiveProfiles.filter(p => profileIds.includes(p.id))
      : allActiveProfiles;
    console.log('resolveItemBarcodes: activeProfiles', activeProfiles);
    const repProfileByVendor = {};
    activeProfiles.forEach(p => { if (!repProfileByVendor[p.vendor]) repProfileByVendor[p.vendor] = p; });
    const vendorIds = Object.keys(repProfileByVendor).filter(v => !Array.isArray(vendors) || vendors.includes(v));
    if (vendorIds.length === 0) throw new HttpsError('invalid-argument', 'no active vendors');

    const catalogsByVendor = {};
    const promoPricesByVendor = {};
    await Promise.all(vendorIds.map(async (vendor) => {
      const p = repProfileByVendor[vendor];
      const key = docKey(vendor, p.branchId);
      console.log('resolveItemBarcodes: fetching catalog for', vendor, p.branchId);
      const [items2, promoSnap] = await Promise.all([
        ensureFreshCatalog(vendor, p.branchId, false).catch((e) => { console.error('resolveItemBarcodes: catalog fetch failed', vendor, p.branchId, e && e.message); return {}; }),
        db.collection('vendorPromoPrices').doc(key).get(),
      ]);
      console.log('resolveItemBarcodes: catalog ready for', vendor, 'itemCount', Object.keys(items2 || {}).length);
      catalogsByVendor[vendor] = items2;
      promoPricesByVendor[vendor] = promoSnap.data() || {};
    }));

    // Used to widen fuzzy-match scoring by pulling in every OTHER vendor's
    // full catalog (thousands of docs each) on every search — but results
    // are filtered below to only candidates priced at one of the caller's
    // own vendorIds anyway, so that cost bought almost nothing and was a
    // major source of search latency. Dropped: search only the vendor(s)
    // the caller actually asked about.
    const searchCatalogsByVendor = catalogsByVendor;
    const searchedVendors = Object.keys(searchCatalogsByVendor);

    const results = {};
    for (const rawName of items) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      const cachedDoc = force ? null : await db.collection('itemBarcodes').doc(itemNameKey(name)).get();
      const cached = cachedDoc && cachedDoc.exists ? cachedDoc.data() : null;
      const barcodes = {};
      if (cached) vendorIds.forEach(v => { if (cached[v]) barcodes[v] = cached[v]; });
      const missingVendors = vendorIds.filter(v => !barcodes[v]);
      if (missingVendors.length === 0) { results[name] = { barcodes, missingVendors: [] }; continue; }
      // extraCatalogsByVendor widens the pool fuzzyMatchCatalogs scores
      // against (helps it find the right barcode even when the caller's own
      // vendor's naming is a weak match), but a result only the caller can
      // actually act on if it's priced at one of the vendors they searched
      // for — otherwise it's just an unpickable "not sold here" row from an
      // unrelated vendor's catalog.
      const candidates = fuzzyMatchCatalogs(name, searchCatalogsByVendor, promoPricesByVendor)
        .filter(c => vendorIds.some(v => c.prices[v] != null));
      console.log('resolveItemBarcodes: name', name, 'candidates found', candidates.length);
      results[name] = { barcodes, missingVendors, searchedVendors, candidates };
    }
    console.log('resolveItemBarcodes: done', Object.keys(results).length, 'names processed');
    return { results };
  }
);

// Lets the add-item flow browse the shared category/subcategory cache
// instead of typing a name — useful exactly when you don't know a product's
// exact name (e.g. "which milk options are there"). productCategories only
// holds category tags, not names/prices, so this queries it for matching
// barcodes first and then looks up those specific barcodes (not the whole
// catalog) in each active vendor's catalog via the existing point-read
// helper. Capped so a big, unnarrowed category can't turn into an
// unbounded read — the `truncated` flag tells the client to suggest
// picking a subcategory instead.
exports.browseCategoryItems = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'browseCategoryItems');
    const { category, subcategory, profileIds, nameFilter } = request.data || {};
    if (!category) throw new HttpsError('invalid-argument', 'category required');
    const allActiveProfiles = await getUserActiveProfiles(request.auth.uid);
    const activeProfiles = Array.isArray(profileIds) && profileIds.length > 0
      ? allActiveProfiles.filter(p => profileIds.includes(p.id))
      : allActiveProfiles;
    if (activeProfiles.length === 0) throw new HttpsError('invalid-argument', 'no active vendors');
    const repProfileByVendor = {};
    activeProfiles.forEach(p => { if (!repProfileByVendor[p.vendor]) repProfileByVendor[p.vendor] = p; });

    // productCategories docs are tiny (barcode -> category/subcategory only),
    // so reading far more of them is cheap — a plain browse still caps at
    // 200 to bound the per-vendor catalog hydration below, but a real text
    // search inside a category needs to scan much further than that or it
    // silently misses matches sitting past the first 200 (found via a real
    // report: "עוף טוב" existed in the category but wasn't in the first 200
    // barcodes read, so the in-browser filter over that partial list found
    // nothing even though a plain name search elsewhere found it fine).
    const LIMIT = nameFilter ? 3000 : 200;
    let q = db.collection('productCategories').where('category', '==', category);
    if (subcategory) q = q.where('subcategory', '==', subcategory);
    const snap = await q.limit(LIMIT).get();
    const barcodes = snap.docs.map(d => d.id);
    if (barcodes.length === 0) return { items: [], truncated: false };

    const perVendorItems = {};
    await Promise.all(Object.entries(repProfileByVendor).map(async ([vendor, p]) => {
      perVendorItems[vendor] = await readCatalogItemsBatch(docKey(vendor, p.branchId), barcodes);
    }));

    // The government price-transparency feeds hard-cap item names (commonly
    // right at 20 characters), and some vendors reuse one generic truncated
    // name across real flavor/size variants of the same product line —
    // gather every vendor's name for each barcode rather than picking one
    // right away, so a collision can be fixed after the fact.
    const candidatesByBarcode = {};
    for (const bc of barcodes) {
      const cands = [];
      const prices = {};
      for (const vendor of Object.keys(repProfileByVendor)) {
        const item = perVendorItems[vendor][bc];
        if (!item) continue;
        prices[vendor] = item.price;
        if (item.name) cands.push({ name: item.name, unit: item.unit || '', manufacturer: item.manufacturer || '' });
      }
      if (cands.length === 0) continue;
      cands.sort((a, b) => b.name.length - a.name.length);
      candidatesByBarcode[bc] = { cands, prices };
    }

    // Default pick: longest available name — usually the least truncated.
    const picked = {};
    for (const [bc, { cands }] of Object.entries(candidatesByBarcode)) picked[bc] = cands[0];

    // Two different barcodes can still land on the exact same name when the
    // vendor with the longest string used one generic name for both real,
    // different products (verified this actually happens — a chain's own
    // feed had an identical name for two distinct SKUs). For every barcode
    // but the first in such a collision, try another vendor's name for it
    // instead, so at least one of them stops looking like a duplicate.
    const nameGroups = {};
    for (const [bc, c] of Object.entries(picked)) (nameGroups[c.name] = nameGroups[c.name] || []).push(bc);
    for (const group of Object.values(nameGroups)) {
      if (group.length < 2) continue;
      const sharedName = picked[group[0]].name;
      for (const bc of group.slice(1)) {
        const alt = candidatesByBarcode[bc].cands.find(c => c.name !== sharedName);
        if (alt) picked[bc] = alt;
      }
    }

    let results = [];
    for (const bc of barcodes) {
      if (!picked[bc]) continue;
      const { name, unit, manufacturer } = picked[bc];
      results.push({ barcode: bc, name, unit, manufacturer, prices: candidatesByBarcode[bc].prices });
    }
    if (nameFilter) {
      const nf = normalizeItemName(nameFilter);
      results = results.filter(r => normalizeItemName(r.name).includes(nf));
    }
    results.sort((a, b) => a.name.localeCompare(b.name, 'he'));
    return { items: results, truncated: snap.size === LIMIT };
  }
);

exports.confirmItemBarcode = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { name, barcode, matchedName, vendors } = request.data || {};
    if (!name || !barcode) throw new HttpsError('invalid-argument', 'name and barcode required');
    const vendorList = (Array.isArray(vendors) ? vendors : VENDOR_IDS).filter(v => VENDOR_IDS.includes(v));
    if (vendorList.length === 0) throw new HttpsError('invalid-argument', 'no valid vendors');
    const entry = { barcode: String(barcode), name: String(matchedName || name).trim(), matchedAt: Date.now() };
    const payload = {};
    vendorList.forEach(v => { payload[v] = entry; });
    const [, catSnap] = await Promise.all([
      db.collection('itemBarcodes').doc(itemNameKey(name)).set(payload, { merge: true }),
      db.collection('productCategories').doc(String(barcode)).get(),
    ]);
    const cat = catSnap.exists ? catSnap.data() : null;
    return { ok: true, category: (cat && cat.category) || null, subcategory: (cat && cat.subcategory) || null };
  }
);

exports.getActiveCatalogTimestamps = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const activeProfiles = await getUserActiveProfiles(request.auth.uid);
    const timestamps = await Promise.all(activeProfiles.map(async (p) => {
      const snap = await db.collection('vendorCatalogIndex').doc(docKey(p.vendor, p.branchId)).get();
      return { id: p.id, vendor: p.vendor, branchId: p.branchId, updatedAt: (snap.data() || {}).updatedAt || null };
    }));
    return { timestamps };
  }
);

exports.getBasketPrices = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: REGION, enforceAppCheck: true },
  async (request) => {
    requireSignedIn(request);
    await enforceDailyCap(request.auth.uid, 'getBasketPrices');
    const { barcodesByVendor, force } = request.data || {};
    if (!barcodesByVendor || typeof barcodesByVendor !== 'object') throw new HttpsError('invalid-argument', 'barcodesByVendor required');

    const activeProfiles = await getUserActiveProfiles(request.auth.uid);
    const relevantProfiles = activeProfiles.filter(p => Array.isArray(barcodesByVendor[p.vendor]) && barcodesByVendor[p.vendor].length > 0);
    const prices = {};
    const promoPrices = {};
    if (relevantProfiles.length === 0) return { prices, promoPrices, profiles: activeProfiles };

    if (force) {
      const catalogByBranch = {};
      const promoByBranch = {};
      const refreshedBranches = [];
      const skippedBranches = [];
      await Promise.all(relevantProfiles.map(async (p) => {
        const key = `${p.vendor}:${p.branchId}`;
        const dKey = docKey(p.vendor, p.branchId);
        if (!catalogByBranch[key]) {
          catalogByBranch[key] = (async () => {
            const idxSnap = await db.collection('vendorCatalogIndex').doc(dKey).get();
            if (sameIsraelDate((idxSnap.data() || {}).updatedAt, Date.now())) {
              skippedBranches.push(key);
              return readAllCatalogItems(dKey);
            }
            refreshedBranches.push(key);
            return ingestVendorCatalog(p.vendor, p.branchId).catch(() => ({}));
          })();
        }
        if (!promoByBranch[key]) {
          promoByBranch[key] = (async () => {
            const idxSnap = await db.collection('vendorPromotionsIndex').doc(dKey).get();
            if (!sameIsraelDate((idxSnap.data() || {}).updatedAt, Date.now())) {
              await ingestVendorPromotions(p.vendor, p.branchId).catch(() => {});
            }
            const snap = await db.collection('vendorPromoPrices').doc(dKey).get();
            return snap.data() || {};
          })();
        }
        const items = await catalogByBranch[key];
        const promoMap = await promoByBranch[key];
        prices[p.id] = {}; promoPrices[p.id] = {};
        barcodesByVendor[p.vendor].forEach(barcode => {
          const price = items[barcode]?.price ?? null;
          prices[p.id][barcode] = price;
          promoPrices[p.id][barcode] = effectivePromoInfo(promoMap[barcode], price);
        });
      }));
      return { prices, promoPrices, profiles: activeProfiles, refreshResult: { refreshedCount: refreshedBranches.length, skippedSameDayCount: skippedBranches.length } };
    }

    await Promise.all(relevantProfiles.map(async (p) => {
      const dKey = docKey(p.vendor, p.branchId);
      const [promoSnap, itemsByBarcode] = await Promise.all([
        db.collection('vendorPromoPrices').doc(dKey).get(),
        readCatalogItemsBatch(dKey, barcodesByVendor[p.vendor]),
      ]);
      const promoMap = promoSnap.data() || {};
      prices[p.id] = {}; promoPrices[p.id] = {};
      barcodesByVendor[p.vendor].forEach((barcode) => {
        const price = itemsByBarcode[barcode]?.price ?? null;
        prices[p.id][barcode] = price;
        promoPrices[p.id][barcode] = effectivePromoInfo(promoMap[barcode], price);
      });
    }));
    return { prices, promoPrices, profiles: activeProfiles };
  }
);

exports.getVendorPromotions = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const activeProfiles = await getUserActiveProfiles(request.auth.uid);
    if (activeProfiles.length === 0) return { promotionsByProfile: {}, profiles: activeProfiles };
    const promosByBranch = {};
    await Promise.all(activeProfiles.map(async (p) => {
      const key = `${p.vendor}:${p.branchId}`;
      if (!promosByBranch[key]) {
        promosByBranch[key] = db.collection('vendorPromotions').doc(docKey(p.vendor, p.branchId)).get()
          .then(snap => (snap.data() || {}).promotions || []);
      }
      return promosByBranch[key];
    }));
    const promotionsByProfile = {};
    await Promise.all(activeProfiles.map(async (p) => {
      const key = `${p.vendor}:${p.branchId}`;
      const promotions = await promosByBranch[key];
      const barcodes = [...new Set(promotions.flatMap(promo => promo.items.map(i => i.barcode)))];
      const dKey = docKey(p.vendor, p.branchId);
      const itemsByBarcode = await readCatalogItemsBatch(dKey, barcodes);
      promotionsByProfile[p.id] = promotions.map(promo => ({
        ...promo,
        items: promo.items.map(item => ({ ...item, name: itemsByBarcode[item.barcode]?.name || '' })),
      }));
    }));
    return { promotionsByProfile, profiles: activeProfiles };
  }
);
