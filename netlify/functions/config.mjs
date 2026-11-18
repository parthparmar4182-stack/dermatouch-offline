/* Dermatouch Offline — which Google Sheets the app uses (Netlify Function).
   The admin can connect a new master sheet (Test 4) or app sheet (Test 5)
   from the app (Settings → Sheets & Admin) without a new deploy. The choice
   is kept in Netlify Blobs, so every phone and laptop follows it.
   An optional admin PIN locks the change. Only a person who is Admin in the
   USERS tab of the app sheet in use can change it (checked with their own
   Google sign-in), and while USERS is still empty, anyone who can open it.

   Optional Netlify environment variables:
     SHEET_MASTER   default master sheet id (else the one built in)
     SHEET_APP      default app sheet id (else the one built in)
   GOOGLE_CLIENT_ID (already set for sign-in) limits this to this app. */
import crypto from 'node:crypto';

const env = k => (process.env[k] || '').trim();
const DEF = () => ({ t2: env('SHEET_MASTER') || '1Pz10Hhzkq4PMxvW58x1XHJGuXyXAJeWqs4mvU5Kg3rY', t3: env('SHEET_APP') || '1bCAdd5I4g1c4e4EbkCZxP0xa-h1finm-aehbxkkTSVk' });
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const out = (code, o) => new Response(JSON.stringify(o), { status: code, headers: H });
const ID_RX = /^[A-Za-z0-9_-]{20,80}$/;
const hk = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

let storeP = null;
const mem = new Map();
async function store() {
  if (globalThis.__dtCfgStore) return globalThis.__dtCfgStore;
  if (!storeP) storeP = import('@netlify/blobs').then(m => m.getStore('dt-config')).catch(() => null);
  return (await storeP) || { async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; }, async setJSON(k, v) { mem.set(k, JSON.stringify(v)); } };
}
async function readCfg(S) { try { return (await S.get('cfg', { type: 'json' })) || {}; } catch { return {}; } }

async function who(tok) {
  if (!tok) return null;
  let r; try { r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tok)); } catch { return null; }
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const cid = env('GOOGLE_CLIENT_ID');
  if (cid && j.aud !== cid && j.azp !== cid) return null;
  return j.email ? String(j.email).toLowerCase() : null;
}
/* Admin in the USERS tab of the app sheet in use (read with the caller's own token) */
async function isAdmin(tok, email, t3) {
  let r; try { r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${t3}/values/${encodeURIComponent("'USERS'!A1:H600")}`, { headers: { Authorization: 'Bearer ' + tok } }); } catch { return false; }
  if (r.status === 400) return true;            // no USERS tab yet: first setup
  if (!r.ok) return false;                      // cannot even open the app sheet
  const rows = ((await r.json().catch(() => ({}))).values) || [];
  const head = (rows[0] || []).map(hk); const ie = head.indexOf('EMAIL'), ia = head.indexOf('ACCESS'), iv = head.indexOf('ACTIVE');
  if (ie < 0) return true;
  const yes = v => /^(yes|y|true|1|active)$/i.test(String(v ?? '').trim());
  const users = rows.slice(1).filter(x => String(x[ie] || '').trim()).map(x => ({ email: String(x[ie]).trim().toLowerCase(), admin: /admin/i.test(String(x[ia] ?? '')), active: iv < 0 ? true : yes(x[iv]) }));
  if (!users.some(u => u.active)) return true;  // nobody set up yet
  return users.some(u => u.email === email && u.active && u.admin);
}
const hashPin = (pin, salt) => crypto.createHash('sha256').update(salt + ':' + String(pin)).digest('hex');

export default async req => {
  const S = await store();
  const cfg = await readCfg(S);
  if (req.method === 'GET') return out(200, { ok: true, sheets: { t2: cfg.t2 || null, t3: cfg.t3 || null }, defaults: DEF(), lock: !!cfg.pinHash, by: cfg.by || '', at: cfg.at || '' });
  if (req.method !== 'POST') return out(405, { error: 'method' });
  const tok = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const email = await who(tok);
  if (!email) return out(401, { error: 'not_signed_in' });
  let b = {}; try { b = await req.json(); } catch { }
  const cur = { ...DEF(), ...(cfg.t2 ? { t2: cfg.t2 } : {}), ...(cfg.t3 ? { t3: cfg.t3 } : {}) };
  if (!(await isAdmin(tok, email, cur.t3))) return out(403, { error: 'not_admin', message: 'Sirf Admin ye kar sakta hai.' });
  /* wrong PIN 5 times → wait 10 minutes */
  const fails = cfg.fails || {}; const f = fails[email] || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 10 * 60e3) return out(429, { error: 'locked', message: '5 baar galat PIN — 10 minute baad try karo.' });
  const pinOk = !cfg.pinHash || (b.pin != null && hashPin(b.pin, cfg.salt) === cfg.pinHash);
  const save = async o => { await S.setJSON('cfg', o); };
  if (!pinOk) { fails[email] = { n: (Date.now() - f.t < 10 * 60e3 ? f.n : 0) + 1, t: Date.now() }; await save({ ...cfg, fails }); return out(200, { ok: false, error: 'bad_pin', message: 'PIN galat hai.' }); }
  if (fails[email]) { delete fails[email]; }
  if (b.action === 'check') { await save({ ...cfg, fails }); return out(200, { ok: true }); }
  if (b.action === 'setSheets') {
    const t2 = String(b.t2 || '').trim(), t3 = String(b.t3 || '').trim();
    if (!ID_RX.test(t2) || !ID_RX.test(t3)) return out(400, { error: 'bad_id', message: 'Sheet ID sahi nahi hai.' });
    if (t2 === t3) return out(400, { error: 'same', message: 'Master aur app sheet alag honi chahiye.' });
    const hist = (cfg.hist || []).concat([{ t2: cur.t2, t3: cur.t3, by: email, at: new Date().toISOString() }]).slice(-20);
    await save({ ...cfg, fails, t2: t2 === DEF().t2 ? '' : t2, t3: t3 === DEF().t3 ? '' : t3, by: email, at: new Date().toISOString(), hist });
    return out(200, { ok: true, sheets: { t2, t3 } });
  }
  if (b.action === 'setPin') {
    const np = String(b.newPin ?? '').trim();
    if (np === '') { const o = { ...cfg, fails }; delete o.pinHash; delete o.salt; await save(o); return out(200, { ok: true, lock: false }); }
    if (!/^\d{4,8}$/.test(np)) return out(400, { error: 'bad_pin_format', message: 'PIN 4 se 8 number ka hona chahiye.' });
    const salt = crypto.randomBytes(12).toString('hex');
    await save({ ...cfg, fails, salt, pinHash: hashPin(np, salt), pinBy: email, pinAt: new Date().toISOString() });
    return out(200, { ok: true, lock: true });
  }
  return out(400, { error: 'action' });
};
