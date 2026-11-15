/* Dermatouch Offline — Dermi's voice (Netlify Function, free).
   Natural Hindi / Indian-English speech from Sarvam AI (Bulbul). No card:
   Sarvam gives free signup credits. Every clip is made ONCE and kept in
   Netlify Blobs, so all phones share it and it never costs again. A monthly
   character cap protects the free credits; past it, the app uses the
   phone's own voice.

   Netlify → Site configuration → Environment variables:
     SARVAM_API_KEY      your key from dashboard.sarvam.ai (free account)
     SARVAM_KEY_DERMI    optional — a separate key just for Dermi (its own free credits)
     SARVAM_KEY_MOMO     optional — a separate key just for Momo
     SARVAM_KEY_TINKU    optional — a separate key just for Tinku
                         (an agent without its own key uses SARVAM_API_KEY)
     SARVAM_VOICE_DERMI_EN / _MOMO_EN / _TINKU_EN  optional — a different voice
                         when English is chosen (bulbul:v4-flash voices are per language)
   A voice name with an underscore (shalini_enhi_customer, chhavi_hi_kids) is a
   bulbul:v4-flash voice and uses that model by itself; a short name (priya,
   kavya, shubh) uses bulbul:v3. SARVAM_MODEL_DERMI / _MOMO / _TINKU force a model.
     SARVAM_VOICE_DERMI  optional — Dermi's own voice (default: SARVAM_VOICE_GIRL or priya)
     SARVAM_VOICE_MOMO   optional — Momo's own voice  (default: SARVAM_VOICE_KID or kavya)
     SARVAM_VOICE_TINKU  optional — Tinku's own voice (default: shubh)
     SARVAM_VOICE_GIRL   optional, default priya   ("Didi awaaz")
     SARVAM_VOICE_KID    optional, default kavya   ("Chhoti cute awaaz")
   All voices must belong to SARVAM_MODEL (bulbul:v3 names like priya, or the
   full persona IDs of bulbul:v4-flash).
     SARVAM_MODEL        optional, default bulbul:v3
     SARVAM_MONTH_CHARS  optional, default 30000   (new characters per month)
   Optional, for the agent's free AI answers (Google AI Studio key, no card):
     GEMINI_API_KEY      key from aistudio.google.com → Get API key
     GEMINI_MODEL        optional; default tries gemini-flash-lite-latest and others
   GOOGLE_CLIENT_ID (already set for sign-in) limits this to people signed
   in to this app. Keys never reach the browser. */
import crypto from 'node:crypto';

const env = k => (process.env[k] || '').trim();
const VOICE = {
  girl: () => env('SARVAM_VOICE_GIRL') || 'priya', kid: () => env('SARVAM_VOICE_KID') || 'kavya',
  dermi: () => env('SARVAM_VOICE_DERMI') || env('SARVAM_VOICE_GIRL') || 'priya',
  momo: () => env('SARVAM_VOICE_MOMO') || env('SARVAM_VOICE_KID') || 'kavya',
  tinku: () => env('SARVAM_VOICE_TINKU') || 'shubh'
};
const STYLE = { girl: { pace: 1.0, temperature: 0.7 }, kid: { pace: 1.08, temperature: 0.95 }, dermi: { pace: 1.0, temperature: 0.72 }, momo: { pace: 1.06, temperature: 0.92 }, tinku: { pace: 1.04, temperature: 0.78 } };
const MODEL = () => env('SARVAM_MODEL') || 'bulbul:v3';
const CHARS = ['dermi', 'momo', 'tinku'];
const U = w => w.toUpperCase();
/* the key for an agent: its own key, else the shared one */
const keyFor = c => (CHARS.includes(c) && (env('SARVAM_KEY_' + U(c)) || env('SARVAM_API_KEY_' + U(c)))) || env('SARVAM_API_KEY');
const anyKey = () => !!(env('SARVAM_API_KEY') || CHARS.some(c => env('SARVAM_KEY_' + U(c)) || env('SARVAM_API_KEY_' + U(c))));
const voiceFor = (who, lang) => (lang === 'en-IN' && CHARS.includes(who) && env('SARVAM_VOICE_' + U(who) + '_EN')) || VOICE[who]();
const modelFor = (who, name) => (CHARS.includes(who) && env('SARVAM_MODEL_' + U(who))) || (name.includes('_') ? 'bulbul:v4-flash' : (MODEL() === 'bulbul:v4-flash' ? 'bulbul:v3' : MODEL()));
const keyTag = k => k ? crypto.createHash('sha1').update(k).digest('hex').slice(0, 10) : 'none';
const LIMIT = () => Math.max(0, +env('SARVAM_MONTH_CHARS') || 30000);
const MAXP = 14, MAXC = 300;
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const out = (code, o) => new Response(JSON.stringify(o), { status: code, headers: H });

let storeP = null;
async function store() {
  if (globalThis.__dtVoiceStore) return globalThis.__dtVoiceStore;
  if (!storeP) storeP = import('@netlify/blobs').then(m => m.getStore('dermi-voice')).catch(() => null);
  return storeP;
}
const mem = { usage: new Map() };   // fallback when Blobs is not there
const month = () => new Date().toISOString().slice(0, 7);
async function usage(S, tag = '') {
  const k = 'usage-' + month() + (tag ? '-' + tag : '');
  if (S) { try { const u = await S.get(k, { type: 'json' }); if (u) return u; } catch { } }
  return mem.usage.get(k) || { chars: 0, clips: 0 };
}
async function saveUsage(S, u, tag = '') {
  const k = 'usage-' + month() + (tag ? '-' + tag : ''); mem.usage.set(k, u);
  if (S) { try { await S.setJSON(k, u); } catch { } }
}

const seen = new Map();   // access token -> valid until
async function signedIn(t) {
  if (!t) return false;
  const until = seen.get(t); if (until && until > Date.now()) return true;
  let r; try { r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(t)); } catch { return false; }
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  const cid = env('GOOGLE_CLIENT_ID');
  if (cid && j.aud !== cid && j.azp !== cid) return false;
  if (seen.size > 500) seen.clear();
  seen.set(t, Date.now() + Math.min(600, Math.max(30, +j.expires_in || 300)) * 1000);
  return true;
}

async function sarvam(text, lang, who, key) {
  const speaker = voiceFor(who, lang);
  const r = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST', headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language_code: lang, speaker, model: modelFor(who, speaker), pace: STYLE[who].pace, temperature: STYLE[who].temperature, speech_sample_rate: 24000, output_audio_codec: 'mp3' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.audios || !j.audios[0]) { const e = new Error(String((j.error && j.error.message) || j.message || 'Sarvam error ' + r.status).slice(0, 240)); e.status = r.status; throw e; }
  return j.audios[0];
}

/* ---------- free AI answers (Gemini free tier) ---------- */
let goodModel = '';
const MODELS = () => [...new Set([env('GEMINI_MODEL'), goodModel, 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(Boolean))];
const SYS = name => `You are ${name}, a warm, cheerful helper inside the Dermatouch Offline warehouse app (India). People ask about stock, SKUs, docs (orders), minus in Uniware, dispatch, B2B stock and the team.
Rules:
- Use ONLY the facts in DATA. Never invent numbers, SKUs, names or dates. If DATA does not hold the answer, say so kindly and suggest what to ask instead (a product name, a doc number, "aaj ka minus", "pending").
- Be short: at most 3 sentences or 6 short lines. Friendly, natural, not robotic. Do not repeat the question.
- Reply ONLY as JSON: {"text": "...", "hi": "...", "en": "...", "mood": "happy|think|sad|alert|wow|love|confused"}
  text = Hinglish in Roman script for the screen (you may use **bold** for key numbers).
  hi = the same meaning in simple, clear Hindi (Devanagari) for speaking aloud, no symbols or markdown.
  en = the same in simple English for speaking aloud.`;
async function ask(b) {
  const key = env('GEMINI_API_KEY');
  if (!key) return out(200, { error: 'ai_off' });
  const q = String(b.q || '').slice(0, 500); if (!q.trim()) return out(400, { error: 'no_text' });
  const data = JSON.stringify(b.data || {}).slice(0, 14000);
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: SYS(String(b.name || 'Dermi').slice(0, 20)) }] }, contents: [{ role: 'user', parts: [{ text: `DATA:\n${data}\n\nQUESTION (${b.lang === 'en' ? 'user prefers English' : 'user prefers Hindi/Hinglish'}): ${q}` }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1200, responseMimeType: 'application/json' } });
  let last = '';
  for (const m of MODELS()) {
    let r; try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body }); } catch { return out(200, { error: 'ai_unreachable' }); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) return out(200, { error: 'quota' });
    if (r.status === 404 || (r.status === 400 && /model|not found|not supported/i.test(JSON.stringify(j.error || '')))) { last = 'model ' + m; continue; }
    if (!r.ok) return out(200, { error: 'ai_failed', message: String((j.error && j.error.message) || r.status).slice(0, 200) });
    goodModel = m;
    const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('').trim();
    let o = null; try { o = JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { }
    if (!o || !o.text) o = txt ? { text: txt.slice(0, 900) } : null;
    if (!o) return out(200, { error: 'ai_empty' });
    return out(200, { text: String(o.text).slice(0, 900), hi: String(o.hi || '').slice(0, 600), en: String(o.en || '').slice(0, 600), mood: /^(happy|think|sad|alert|wow|love|confused)$/.test(o.mood) ? o.mood : 'think', model: m });
  }
  return out(200, { error: 'ai_failed', message: 'No model available: ' + last });
}

export default async req => {
  if (req.method === 'GET') {
    const S = await store(); const u = await usage(S, keyTag(env('SARVAM_API_KEY')));
    const agents = {};
    for (const c of CHARS) { const k = keyFor(c); const uc = await usage(S, keyTag(k)); const v = voiceFor(c, 'hi-IN'), ve = voiceFor(c, 'en-IN'); agents[c] = { key: !!k, ownKey: !!(env('SARVAM_KEY_' + U(c)) || env('SARVAM_API_KEY_' + U(c))), voice: v, voiceEn: ve, model: modelFor(c, v), used: uc.chars }; }
    return out(200, { ok: true, configured: anyKey(), ai: !!env('GEMINI_API_KEY'), provider: 'sarvam', model: MODEL(), voices: Object.fromEntries(Object.keys(VOICE).map(k => [k, VOICE[k]()])), agents, shared: !!S, used: u.chars, clips: u.clips, limit: LIMIT() });
  }
  if (req.method !== 'POST') return out(405, { error: 'method' });
  const t = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!(await signedIn(t))) return out(401, { error: 'not_signed_in' });
  let b = {}; try { b = await req.json(); } catch { }
  if (b.action === 'ask') return ask(b);
  const lang = b.lang === 'en' ? 'en-IN' : 'hi-IN';
  const who = b.who === 'kid' || b.who === 'girl' ? b.who : (b.who === 'char' && VOICE[b.char] && !['kid', 'girl'].includes(b.char)) ? b.char : 'girl';
  const parts = (Array.isArray(b.parts) ? b.parts : [b.text]).map(p => String(p || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAXC)).filter(Boolean).slice(0, MAXP);
  if (!parts.length) return out(400, { error: 'no_text' });
  const S = await store();
  const keyWho = CHARS.includes(b.char) ? b.char : who;
  const key = keyFor(keyWho), tag = keyTag(key);
  const spk = voiceFor(who, lang);
  const id = p => crypto.createHash('sha1').update([modelFor(who, spk), spk, lang, STYLE[who].pace, STYLE[who].temperature, p].join('|')).digest('hex');
  const audios = new Array(parts.length).fill(null);
  const miss = [];
  await Promise.all(parts.map(async (p, i) => {
    if (S) { try { const a = await S.get(id(p), { type: 'arrayBuffer' }); if (a && a.byteLength) { audios[i] = Buffer.from(a).toString('base64'); return; } } catch { } }
    miss.push(i);
  }));
  let made = 0, error = '', budget = false;
  if (miss.length) {
    if (!key) return out(200, { audios, made, budget, error: 'not_configured' });
    const u = await usage(S, tag); const need = miss.reduce((a, i) => a + parts[i].length, 0);
    if (u.chars + need > LIMIT()) budget = true;
    else {
      await Promise.all(miss.map(async i => {
        try {
          let a;
          try { a = await sarvam(parts[i], lang, who, key); }
          catch (e) { const main = env('SARVAM_API_KEY'); if (main && main !== key && [401, 402, 403, 429].includes(e.status)) a = await sarvam(parts[i], lang, who, main); else throw e; }
          audios[i] = a; made++; u.chars += parts[i].length; u.clips++;
          if (S) { try { await S.set(id(parts[i]), Buffer.from(a, 'base64')); } catch { } }
        } catch (e) { error = e.message; }
      }));
      if (made) await saveUsage(S, u, tag);
    }
  }
  return out(200, { audios, made, budget, error, shared: !!S });
};
