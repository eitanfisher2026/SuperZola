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
    const model = geminiModel || 'gemini-2.5-flash-lite';
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

function extractJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new HttpsError('internal', 'לא ניתן לפרסר את תשובת ה-AI');
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { throw new HttpsError('internal', 'לא ניתן לפרסר את תשובת ה-AI'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new HttpsError('internal', 'לא זוהו פריטים בטקסט');
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item parsing — free-text shopping input → structured, categorized items
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_AI_PROMPT = 'אתה מסייע לסיווג פריטי קנייה בעברית לקטגוריות.\n\nקטגוריות זמינות — חייב להשתמש באחד השמות המדויקים האלו:\n{categories}\n\nכללים:\n1. זהה כל פריט נפרד בטקסט\n2. לכל פריט, בחר את הקטגוריה המתאימה ביותר מהרשימה\n3. שם הקטגוריה חייב להיות זהה לחלוטין לאחד השמות ברשימה\n4. "שונות" — רק אם אין שום קטגוריה מתאימה אחרת\n5. אם לא צוינה כמות — הכנס 1. אם לא צוינה יחידה — הכנס "יחידות"\n6. הערה (note) — רק אם קיימת בטקסט, אחרת ""\n7. שם הפריט (name) — העתק בדיוק כפי שהמשתמש כתב, באותה שפה\n\nיחידות אפשריות: יחידות / ק"ג / גרם / ליטר / מ"ל / קופסה / חבילה / צרור\n\nפרמט JSON נדרש:\n[{"name":"שם הפריט","quantity":1,"unit":"יחידות","category":"שם קטגוריה מדויק","note":""}]\n\nטקסט: {text}\n\nהחזר מערך JSON בלבד, ללא הסברים:';

exports.parseItems = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { text, categories, prompt } = request.data || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new HttpsError('invalid-argument', 'text required');
    }
    const cats = Array.isArray(categories) && categories.length > 0 ? categories : [{ label: 'שונות' }];
    const catLabels = cats.map(c => c.label).join(' / ');
    let template = DEFAULT_AI_PROMPT;
    if (typeof prompt === 'string' && prompt.includes('{categories}') && prompt.includes('{text}')) template = prompt;
    const finalPrompt = template.replace('{categories}', catLabels).replace('{text}', text);

    const ai = makeAI(request.data);
    const { text: raw, usage } = await callAI(ai, finalPrompt, 2048);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
    return { items: extractJsonArray(raw) };
  }
);

function cheapestModelId(models) {
  const priced = models.filter(m => m.price);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (a.price.in + a.price.out) <= (b.price.in + b.price.out) ? a : b).id;
}

exports.listProviderModels = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: REGION },
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
  { timeoutSeconds: 30, memory: '128MiB', region: REGION },
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
const DEFAULT_MAX_ACTIVE_VENDORS = 8;

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
    barcodes.slice(i, i + BATCH_SIZE).forEach(bc => {
      batch.set(db.collection('vendorCatalogs').doc(key).collection('items').doc(bc), items[bc]);
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
async function readCatalogItemPrice(key, barcode) {
  const snap = await db.collection('vendorCatalogs').doc(key).collection('items').doc(barcode).get();
  return snap.exists ? (snap.data().price ?? null) : null;
}
async function readCatalogItemName(key, barcode) {
  const snap = await db.collection('vendorCatalogs').doc(key).collection('items').doc(barcode).get();
  return snap.exists ? (snap.data().name || '') : '';
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
function parseXmlBuffer(buf, isGz) {
  if (isGz) buf = require('zlib').gunzipSync(buf);
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

function branchesFromStoresXml(obj) {
  const root = obj.Root || obj.Chain || {};
  const branches = {};
  for (const subChain of asArray(root.SubChains?.SubChain)) {
    for (const s of asArray(subChain.Stores?.Store)) {
      const id = String(s.StoreID ?? '').padStart(3, '0');
      if (!id || id === '000') continue;
      branches[id] = {
        name: String(s.StoreName ?? '').trim() || `Store ${id}`,
        address: String(s.Address ?? '').replace(/&#x0?[dDaA];/g, '').replace(/[\r\n]+/g, '').trim(),
        city: String(s.City ?? '').trim(),
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
    const manufacturer = String(item.ManufactureName ?? '').trim();
    items[barcode] = {
      name: String(item.ItemName ?? '').trim(), price,
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
  const branches = branchesFromStoresXml(obj);
  if (Object.keys(branches).length === 0) return null;
  await db.collection('vendorBranches').doc(vendor).set({ branches, updatedAt: Date.now() });
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

// Runs independently of any user request so a real person's "match item" or
// list-open action is never the thing waiting on a 30-50s re-ingest.
exports.refreshActiveVendorCatalogs = onSchedule(
  { schedule: 'every 12 hours', region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const snap = await db.collectionGroup('vendorProfiles').get();
    const pairs = {};
    snap.forEach(doc => {
      const p = doc.data();
      if (p && p.active && VENDOR_IDS.includes(p.vendor) && p.branchId) pairs[`${p.vendor}:${p.branchId}`] = p;
    });
    await Promise.all(Object.values(pairs).map(p => ingestVendorCatalog(p.vendor, String(p.branchId)).catch(() => {})));
  }
);

function scoreCatalogName(name, q, qTokens) {
  const nameTokens = name.split(' ').filter(Boolean);
  if (name === q) return 100;
  if (qTokens.length > 1 && !nameTokens.includes(qTokens[0])) return null;
  const overlap = qTokens.filter(t => nameTokens.includes(t)).length;
  if (overlap > 0 && overlap === qTokens.length) {
    let score = 70;
    if (nameTokens.slice(0, qTokens.length).join(' ') === q) score += 20;
    else if (nameTokens[0] === qTokens[0]) score += 10;
    return score;
  }
  if (qTokens.length > 1) return null;
  if (overlap > 0) return 15 + Math.round((overlap / qTokens.length) * 15);
  if (name.includes(q) || q.includes(name)) return 15;
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
  { timeoutSeconds: 30, memory: '128MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    return { vendors: VENDOR_IDS.map(id => ({ id, label: VENDOR_LABELS[id] || id })) };
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
    let branches = (snap.data() || {}).branches;
    if (!branches || Object.keys(branches).length === 0) {
      console.log('getVendorBranches: no cache, ingesting', vendor);
      branches = await ingestVendorBranches(vendor);
    }
    console.log('getVendorBranches: done', vendor, 'count=', Object.keys(branches || {}).length);
    return { branches: branches || {} };
  }
);

// Fired (without the client waiting on it) right after a vendor+branch is
// added in Settings, so the first real price search against it doesn't have
// to pay for a cold catalog ingest — by the time someone opens an item
// dialog and searches, the branch's catalog is very likely already cached.
exports.prewarmVendorCatalog = onCall(
  { timeoutSeconds: 120, memory: '512MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { vendor, branchId } = request.data || {};
    if (!VENDORS[vendor] || !branchId) throw new HttpsError('invalid-argument', 'vendor and branchId required');
    await ensureFreshCatalog(vendor, String(branchId), false).catch(() => {});
    return { ok: true };
  }
);

exports.resolveItemBarcodes = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { items, force, vendors } = request.data || {};
    console.log('resolveItemBarcodes: start', { uid: request.auth.uid, items, force, vendors });
    if (!Array.isArray(items) || items.length === 0) throw new HttpsError('invalid-argument', 'items array required');

    const activeProfiles = await getUserActiveProfiles(request.auth.uid);
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

    const extraCatalogsByVendor = {};
    await Promise.all(VENDOR_IDS.filter(v => !catalogsByVendor[v]).map(async (vendor) => {
      const idxSnap = await db.collection('vendorCatalogIndex').orderBy(admin.firestore.FieldPath.documentId()).startAt(vendor + '__').endAt(vendor + '__' + String.fromCharCode(0xFFFF)).limit(1).get();
      if (idxSnap.empty) return;
      const catalogItems = await readAllCatalogItems(idxSnap.docs[0].id);
      if (Object.keys(catalogItems).length > 0) extraCatalogsByVendor[vendor] = catalogItems;
    }));
    const searchCatalogsByVendor = Object.assign({}, catalogsByVendor, extraCatalogsByVendor);
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
      const candidates = fuzzyMatchCatalogs(name, searchCatalogsByVendor, promoPricesByVendor);
      console.log('resolveItemBarcodes: name', name, 'candidates found', candidates.length);
      results[name] = { barcodes, missingVendors, searchedVendors, candidates };
    }
    console.log('resolveItemBarcodes: done', Object.keys(results).length, 'names processed');
    return { results };
  }
);

exports.confirmItemBarcode = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
    const { name, barcode, matchedName, vendors } = request.data || {};
    if (!name || !barcode) throw new HttpsError('invalid-argument', 'name and barcode required');
    const vendorList = (Array.isArray(vendors) ? vendors : VENDOR_IDS).filter(v => VENDOR_IDS.includes(v));
    if (vendorList.length === 0) throw new HttpsError('invalid-argument', 'no valid vendors');
    const entry = { barcode: String(barcode), name: String(matchedName || name).trim(), matchedAt: Date.now() };
    const payload = {};
    vendorList.forEach(v => { payload[v] = entry; });
    await db.collection('itemBarcodes').doc(itemNameKey(name)).set(payload, { merge: true });
    return { ok: true };
  }
);

exports.getActiveCatalogTimestamps = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: REGION },
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
  { timeoutSeconds: 300, memory: '1GiB', region: REGION },
  async (request) => {
    requireSignedIn(request);
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
      const promoSnap = await db.collection('vendorPromoPrices').doc(dKey).get();
      const promoMap = promoSnap.data() || {};
      prices[p.id] = {}; promoPrices[p.id] = {};
      await Promise.all(barcodesByVendor[p.vendor].map(async (barcode) => {
        const price = await readCatalogItemPrice(dKey, barcode);
        prices[p.id][barcode] = price;
        promoPrices[p.id][barcode] = effectivePromoInfo(promoMap[barcode], price);
      }));
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
      const names = {};
      await Promise.all(barcodes.map(async (bc) => { names[bc] = await readCatalogItemName(dKey, bc); }));
      promotionsByProfile[p.id] = promotions.map(promo => ({
        ...promo,
        items: promo.items.map(item => ({ ...item, name: names[item.barcode] || '' })),
      }));
    }));
    return { promotionsByProfile, profiles: activeProfiles };
  }
);

