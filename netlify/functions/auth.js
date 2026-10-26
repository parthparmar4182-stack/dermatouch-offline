/* Dermatouch Offline — sign-in helper (Netlify Function, free tier).
   Keeps people signed in: Google gives a refresh token once at sign-in; it is
   kept encrypted in an HttpOnly cookie that page scripts cannot read. The page
   asks this helper for a fresh 1-hour access token whenever it needs one, so
   nobody has to sign in again (until they sign out or remove access).

   Netlify → Site configuration → Environment variables:
     GOOGLE_CLIENT_ID      the OAuth client id (…apps.googleusercontent.com)
     GOOGLE_CLIENT_SECRET  the client secret of the same OAuth client
   Google Cloud → the OAuth client → Authorized redirect URIs:
     https://YOUR-SITE.netlify.app/.netlify/functions/auth
*/
const crypto = require('crypto');

const PATH = '/.netlify/functions/auth';
const BASE = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'];
const GMAIL = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const YEAR = 60 * 60 * 24 * 365;

const env = k => (process.env[k] || '').trim();
const key = () => crypto.createHash('sha256').update(env('GOOGLE_CLIENT_SECRET') + ':dt-session-v1').digest();
function seal(obj) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}
function open(s) {
  try {
    const b = Buffer.from(String(s || ''), 'base64url'); if (b.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch (_) { return null; }
}
function cookies(h) {
  const out = {}; const raw = (h && (h.cookie || h.Cookie)) || '';
  for (const p of raw.split(/;\s*/)) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); }
  return out;
}
const ck = (name, val, age) => `${name}=${encodeURIComponent(val)}; Path=${PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const json = (code, body, set) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, multiValueHeaders: set ? { 'Set-Cookie': set } : undefined, body: JSON.stringify(body) });
const go = (url, set) => ({ statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, multiValueHeaders: set ? { 'Set-Cookie': set } : undefined, body: '' });
const origin = e => `https://${(e.headers && (e.headers['x-forwarded-host'] || e.headers.host)) || ''}`;
const safeBack = b => (/^\/[\w\-./]*$/.test(b || '') && !String(b).startsWith('//')) ? b : '/';
const emailOf = idt => { try { return JSON.parse(Buffer.from(String(idt).split('.')[1], 'base64url').toString('utf8')).email || ''; } catch (_) { return ''; } };

async function google(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), ...params }) });
  let j = {}; try { j = await r.json(); } catch (_) { }
  return { ok: r.ok, status: r.status, j };
}

exports.handler = async event => {
  const q = event.queryStringParameters || {};
  const c = cookies(event.headers);
  const a = q.a || (q.code || q.error ? 'callback' : '');
  const configured = !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
  const redirect = origin(event) + PATH;

  if (a === 'ping') return json(200, { ok: configured, v: 1 });
  if (!configured) return json(500, { error: 'not_configured', message: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Netlify environment variables.' });

  if (a === 'login') {
    const state = crypto.randomBytes(18).toString('base64url');
    const scope = [...BASE, ...(q.gm === '1' ? GMAIL : [])].join(' ');
    const p = new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent select_account', state });
    if (q.hint && /^[^@\s]+@[^@\s]+$/.test(q.hint)) p.set('login_hint', q.hint);
    return go('https://accounts.google.com/o/oauth2/v2/auth?' + p, [ck('dt_st', seal({ s: state, back: safeBack(q.back), t: Date.now() }), 600)]);
  }

  if (a === 'callback') {
    const st = open(c.dt_st); const back = (st && st.back) || '/';
    const fail = why => go(`${back}?auth_error=${encodeURIComponent(why)}`, [ck('dt_st', '', 0)]);
    if (q.error) return fail(q.error === 'access_denied' ? 'You cancelled the Google sign-in.' : 'Google sign-in failed: ' + q.error);
    if (!st || st.s !== q.state || Date.now() - st.t > 600e3) return fail('The sign-in took too long or was opened twice. Please try again.');
    const r = await google({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirect });
    if (!r.ok) return fail('Google did not accept the sign-in (' + (r.j.error || r.status) + '). Check the redirect URI and client secret.');
    const old = open(c.dt_rt) || {};
    const rt = r.j.refresh_token || old.rt;
    if (!rt) return fail('Google did not give a long-term sign-in. Remove the app at myaccount.google.com/permissions and sign in again.');
    const sess = { rt, email: emailOf(r.j.id_token) || old.email || '', scope: r.j.scope || '', t: Date.now() };
    return go(back + '?signed=1', [ck('dt_st', '', 0), ck('dt_rt', seal(sess), YEAR)]);
  }

  if (a === 'token') {
    if ((event.httpMethod || 'GET') !== 'POST') return json(405, { error: 'post_only' });
    const sess = open(c.dt_rt);
    if (!sess || !sess.rt) return json(401, { error: 'signed_out' });
    const r = await google({ grant_type: 'refresh_token', refresh_token: sess.rt });
    if (!r.ok) {
      if (r.j.error === 'invalid_grant') return json(401, { error: 'signed_out', message: 'Google access was removed or expired. Sign in again.' }, [ck('dt_rt', '', 0)]);
      return json(502, { error: 'google', status: r.status });
    }
    return json(200, { access_token: r.j.access_token, expires_in: r.j.expires_in || 3600, scope: r.j.scope || sess.scope || '', email: sess.email || '' });
  }

  if (a === 'logout') {
    const sess = open(c.dt_rt);
    if (sess && sess.rt) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(sess.rt), { method: 'POST' }); } catch (_) { } }
    return json(200, { ok: true }, [ck('dt_rt', '', 0)]);
  }
  return json(400, { error: 'unknown_action' });
};
