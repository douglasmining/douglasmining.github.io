// Douglas Mining encrypted newsletter list.
//
// The signup form on douglasmining.com encrypts each subscriber's address in the
// browser to the PGP public key below. This Worker only ever sees ciphertext:
// it checks the message really is encrypted to that key, rate-limits, stores it
// in D1, and emails a notification that contains no personal data. The admin
// page (/admin/) unlocks the list by signing a challenge with the private key
// and decrypts every entry locally in the browser.
//
// Same design as the douglas.lol secure drop.

import * as openpgp from 'openpgp';
import { EmailMessage } from 'cloudflare:email';
import PUBLIC_KEY from './public-key.asc';

const MAX_BYTES = 8000;        // an encrypted address is ~1 KB armored
const PER_SENDER_PER_DAY = 5;  // signups per hashed IP per day
const ALL_PER_DAY = 300;       // signups across everyone per day
const CHALLENGE_TTL = 5 * 60;  // seconds an admin login challenge stays valid
const SESSION_TTL = 12 * 3600; // seconds an admin session lasts

let keyPromise;
const publicKey = () => (keyPromise ||= openpgp.readKey({ armoredKey: PUBLIC_KEY }));

const enc = new TextEncoder();
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}
async function sha(text) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
// Constant-time string compare.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const now = () => Math.floor(Date.now() / 1000);

// Human-friendly reference like "K7Q2-M9XA": shown to the subscriber and used to unsubscribe.
function ref() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return [...r].map((x, i) => (i === 4 ? '-' : '') + c[x % c.length]).join('');
}

function cors(req, env) {
  const o = req.headers.get('Origin') || '';
  const ok = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(o);
  return ok
    ? {
        'Access-Control-Allow-Origin': o,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
}

const json = (h, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Increments a daily counter and returns the new count.
const hit = (env, k, day) =>
  env.DB.prepare('INSERT INTO hits (k, d, n) VALUES (?1, ?2, 1) ON CONFLICT (k) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(k, day)
    .first('n');

async function subscribe(req, env, h, ctx) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BYTES + 1000) return json(h, { error: 'Request is too large.' }, 413);

  const body = await readJson(req);
  if (!body) return json(h, { error: 'Bad request.' }, 400);
  const m = typeof body.m === 'string' ? body.m.trim() : '';
  if (!m || m.length > MAX_BYTES) return json(h, { error: m ? 'Request is too large.' : 'Empty request.' }, 400);
  if (!m.startsWith('-----BEGIN PGP MESSAGE-----') || !m.endsWith('-----END PGP MESSAGE-----'))
    return json(h, { error: 'Not an encrypted message.' }, 400);

  // Accept only messages encrypted to this inbox's key, so nothing unreadable piles up.
  try {
    const key = await publicKey();
    const mine = (await key.getEncryptionKey()).getKeyID().toHex();
    const msg = await openpgp.readMessage({ armoredMessage: m });
    if (!msg.getEncryptionKeyIDs().some((k) => k.toHex() === mine))
      return json(h, { error: 'Not encrypted to this list.' }, 400);
  } catch {
    return json(h, { error: 'Not an encrypted message.' }, 400);
  }

  const day = new Date().toISOString().slice(0, 10);
  const who = 'ip:' + (await sha((req.headers.get('CF-Connecting-IP') || 'unknown') + '|' + day + '|' + env.SESSION_SECRET)).slice(0, 32);
  if ((await hit(env, who, day)) > PER_SENDER_PER_DAY)
    return json(h, { error: 'Too many signups from your connection today. Please try again tomorrow.' }, 429);
  if ((await hit(env, 'all:' + day, day)) > ALL_PER_DAY)
    return json(h, { error: 'The list is busy right now. Please try again tomorrow.' }, 429);

  const r = ref();
  const at = new Date().toISOString();
  await env.DB.prepare('INSERT INTO subscribers (id, ref, created_at, size, status, ciphertext) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(crypto.randomUUID(), r, at, m.length, 'active', m)
    .run();

  const adminUrl = new URL(req.url).origin + '/admin/';
  ctx.waitUntil(
    Promise.all([
      notify(env, r, at, adminUrl).catch((e) => console.log('notify failed', e && e.message)),
      env.DB.prepare('DELETE FROM hits WHERE d < ?1').bind(day).run(),
    ]),
  );
  return json(h, { ok: true, ref: r });
}

async function unsubscribe(req, env, h) {
  const body = await readJson(req);
  const r = typeof body?.ref === 'string' ? body.ref.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (r.length !== 8) return json(h, { error: 'That reference code does not look right.' }, 400);
  const code = r.slice(0, 4) + '-' + r.slice(4);
  const res = await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE ref = ?1 AND status = 'active'")
    .bind(code)
    .run();
  return json(h, { ok: res.meta.changes === 1 });
}

async function notify(env, r, at, adminUrl) {
  const lines = [
    `From: Douglas Mining newsletter <${env.NOTIFY_FROM}>`,
    `To: ${env.NOTIFY_TO}`,
    `Subject: New newsletter subscriber (${r})`,
    `Date: ${new Date(at).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@douglasmining.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Someone joined the Douglas Mining newsletter (reference ${r}).`,
    '',
    `Open ${adminUrl} and unlock the list with your key to see the address.`,
    'This email never contains the address itself.',
  ];
  await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, lines.join('\r\n')));
}

async function session(req, env) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [exp, mac] = t.split('.');
  return !!exp && Number(exp) > now() && same(mac, await hmac(env.SESSION_SECRET, 'session:' + exp));
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env);
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    try {
      if (p === '/' || p === '/health') return json(h, { ok: true, service: 'Douglas Mining newsletter' });

      // The signup page fetches the key it should encrypt to.
      if (p === '/key' && req.method === 'GET')
        return new Response(PUBLIC_KEY, {
          headers: { ...h, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        });

      if (p === '/subscribe' && req.method === 'POST') return await subscribe(req, env, h, ctx);
      if (p === '/unsubscribe' && req.method === 'POST') return await unsubscribe(req, env, h);

      // Admin login: prove you hold the private key by signing a short-lived challenge.
      if (p === '/admin/challenge' && req.method === 'GET') {
        const challenge = `Douglas Mining newsletter login ${now()} ${b64u(crypto.getRandomValues(new Uint8Array(16)))}`;
        return json(h, { challenge, mac: await hmac(env.SESSION_SECRET, 'challenge:' + challenge) });
      }
      if (p === '/admin/login' && req.method === 'POST') {
        const { challenge, mac, signature } = (await readJson(req)) || {};
        const ts = Number(String(challenge || '').split(' ')[4]);
        if (!same(mac, await hmac(env.SESSION_SECRET, 'challenge:' + challenge)) || !(now() - ts < CHALLENGE_TTL))
          return json(h, { error: 'Challenge expired. Try again.' }, 401);
        try {
          const v = await openpgp.verify({
            message: await openpgp.createMessage({ text: challenge }),
            signature: await openpgp.readSignature({ armoredSignature: signature }),
            verificationKeys: await publicKey(),
            expectSigned: true,
          });
          await v.signatures[0].verified;
        } catch {
          return json(h, { error: 'That key is not the list key.' }, 401);
        }
        const exp = now() + SESSION_TTL;
        return json(h, { token: exp + '.' + (await hmac(env.SESSION_SECRET, 'session:' + exp)), expires: exp });
      }

      if (p.startsWith('/admin/')) {
        if (!(await session(req, env))) return json(h, { error: 'Locked.' }, 401);
        if (p === '/admin/subscribers' && req.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT id, ref, created_at, size, status, ciphertext FROM subscribers ORDER BY created_at DESC LIMIT 5000',
          ).all();
          return json(h, { subscribers: results });
        }
        const m = p.match(/^\/admin\/subscribers\/([0-9a-f-]{36})$/);
        if (m && req.method === 'POST') {
          const { status } = (await readJson(req)) || {};
          if (!['active', 'unsubscribed'].includes(status)) return json(h, { error: 'Bad status.' }, 400);
          const r = await env.DB.prepare('UPDATE subscribers SET status = ?1 WHERE id = ?2').bind(status, m[1]).run();
          return json(h, { ok: r.meta.changes === 1 });
        }
        if (m && req.method === 'DELETE') {
          const r = await env.DB.prepare('DELETE FROM subscribers WHERE id = ?1').bind(m[1]).run();
          return json(h, { ok: r.meta.changes === 1 });
        }
      }

      return json(h, { error: 'Not found.' }, 404);
    } catch (e) {
      console.log('error', e && e.stack);
      return json(h, { error: 'Something went wrong.' }, 500);
    }
  },
};
