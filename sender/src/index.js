// AlmaED WhatsApp sender: runs gowa on this machine, sends from the queue in Supabase,
// handles replies, and carries out jobs the Vercel dashboard asks for.
'use strict';
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`\nThis needs Node.js 22 or newer (you have ${process.version}). Install the LTS version from https://nodejs.org, then start again.\n`);
  process.exit(1);
}
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const R = require('./rules');
const { Gowa, GowaProcess } = require('./gowa');

const VERSION = '2.0.0';
const ROOT = process.env.SENDER_ROOT || path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const FAST = !!process.env.SENDER_FAST;          // tests only: shrink waits
const scale = (ms) => (FAST ? Math.max(1, ms / 1000) : ms);

// ---------------------------------------------------------------- config
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJson(file, obj) { fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2)); fs.renameSync(file + '.tmp', file); }

function stop(msg) { console.error('\n' + msg + '\n'); process.exit(1); }
const HOW = 'Open config.json in this folder (Notepad / TextEdit), paste your Supabase Project URL and secret key\n' +
  '(Supabase -> Project Settings -> API Keys / Data API), save it, then start the sender again.';
if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(CONFIG_FILE.replace(/config\.json$/, 'config.example.json'))) {
  fs.copyFileSync(CONFIG_FILE.replace(/config\.json$/, 'config.example.json'), CONFIG_FILE);
  stop('Created config.json.\n' + HOW);
}
const cfg = readJson(CONFIG_FILE);
if (!cfg) stop('config.json is missing or is not valid JSON (check for a missing quote or comma).');
cfg.supabaseUrl = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
cfg.supabaseServiceKey = String(cfg.supabaseServiceKey || '').trim();
cfg.gowa = cfg.gowa || {};
if (!cfg.supabaseUrl || !cfg.supabaseServiceKey || /PASTE/i.test(cfg.supabaseUrl + cfg.supabaseServiceKey)) stop(HOW);
if (!/^https?:\/\/[^\s/]+$/.test(cfg.supabaseUrl)) stop('supabaseUrl in config.json should look like https://abcdefgh.supabase.co');
{
  let role = '';
  try { role = JSON.parse(Buffer.from(cfg.supabaseServiceKey.split('.')[1], 'base64url').toString()).role || ''; } catch (_) { /* sb_secret_ keys are not JWTs */ }
  if (/^sb_publishable_/.test(cfg.supabaseServiceKey) || role === 'anon') {
    stop('supabaseServiceKey in config.json is the public (anon / publishable) key. The sender needs the SECRET key:\n' +
      'Supabase -> Project Settings -> API Keys -> "secret" key (or the legacy "service_role" key).');
  }
}
let changed = false;
if (!cfg.gowa.password) { cfg.gowa.password = crypto.randomBytes(9).toString('base64url'); changed = true; }
if (!cfg.gowa.webhookSecret) { cfg.gowa.webhookSecret = crypto.randomBytes(18).toString('hex'); changed = true; }
if (!cfg.instanceId) { cfg.instanceId = crypto.randomUUID(); changed = true; }
if (changed) writeJson(CONFIG_FILE, cfg);
const WEBHOOK_PORT = cfg.webhookPort || 4000;

const db = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const nowIso = () => new Date(Date.now()).toISOString();

async function q(promise, what) {
  const { data, error, count } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return count !== undefined && count !== null && data === null ? count : (data ?? count);
}

async function log(text, kind = 'info') {
  console.log(`[${new Date().toLocaleTimeString()}] ${text}`);
  try { await db.from('activity').insert({ text, kind }); } catch (_) { /* best effort */ }
}

function zoned(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
/** Start of today in the given time zone, as an ISO string. */
function startOfDay(tz) {
  const now = Date.now();
  const { day } = zoned(now, tz);
  // find the UTC instant when that local day began (search back up to 26 h in 15-min steps)
  let t = now - (now % (15 * 60000));
  while (zoned(t - 15 * 60000, tz).day === day) t -= 15 * 60000;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------- state from Supabase
async function getSettings() {
  const rows = await q(db.from('settings').select('*').eq('id', 1), 'read settings');
  return rows[0];
}
async function saveSettings(patch) {
  await q(db.from('settings').update({ ...patch, updated_at: nowIso() }).eq('id', 1), 'save settings');
}
async function sentToday(s) {
  const { count, error } = await db.from('contacts').select('phone', { count: 'exact', head: true }).gte('sent_at', startOfDay(s.timezone));
  if (error) throw new Error('count sent today: ' + error.message);
  return count || 0;
}
function todaysLimit(s) {
  const day = zoned(Date.now(), s.timezone).day;
  let idx = (s.days_active || []).indexOf(day);
  if (idx < 0) idx = (s.days_active || []).length;
  const warm = s.warmup || [];
  return Math.min(s.daily_limit, idx < warm.length ? warm[idx] : s.daily_limit);
}
function inHours(s) {
  const h = zoned(Date.now(), s.timezone).hour;
  return h >= s.send_from_hour && h < s.send_until_hour;
}

// ---------------------------------------------------------------- gowa
const gowa = new Gowa(cfg.gowa);
let gowaProc = null;
let gowaStatus = { reachable: false, loggedIn: false, jid: '', error: '' };
async function isOurGowa(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/devices`, { headers: gowa.headers(), signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    return r.ok && d.code === 'SUCCESS';
  } catch (_) { return false; }
}
async function refreshGowa() {
  const was = gowaStatus.loggedIn;
  gowaStatus = await gowa.status();
  if (gowaStatus.reachable && gowaProc) gowaProc.markRunning();
  if (was && !gowaStatus.loggedIn) await log('WhatsApp disconnected. Check the spare phone. If WhatsApp says the number is banned, stop here.', 'error');
  if (!was && gowaStatus.loggedIn) await log(`WhatsApp connected (${gowaStatus.jid.split('@')[0]}).`, 'good');
  return gowaStatus;
}

const recentOut = new Map();      // phone -> [{text, at}] so webhook echoes of our own sends are ignored
const ourIds = new Set();
async function sendHuman(phone, text, typing) {
  const list = (recentOut.get(phone) || []).filter((x) => Date.now() - x.at < 5 * 60000);
  list.push({ text, at: Date.now() });
  recentOut.set(phone, list);
  if (typing) {
    await gowa.typing(phone, true);
    await sleep(scale(Math.min(9000, 1500 + text.length * 12)));
    await gowa.typing(phone, false);
  }
  const id = await gowa.sendText(phone, text);
  if (id) ourIds.add(id);
  return id;
}
async function addMessage(phone, direction, body) {
  try { await db.from('messages').insert({ phone, direction, body }); } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------- sending
async function sendOpener(s, c) {
  const text = R.renderMessage(s.opener, c);
  try {
    const id = await sendHuman(c.phone, text, s.typing_indicator);
    await q(db.from('contacts').update({ status: 'sent', sent_at: nowIso(), message_id: id || null }).eq('phone', c.phone), 'mark sent');
    await addMessage(c.phone, 'us', text);
    const day = zoned(Date.now(), s.timezone).day;
    const days = s.days_active || [];
    await saveSettings({
      days_active: days.includes(day) ? days : [...days, day],
      next_send_at: new Date(Date.now() + scale(rand(s.min_gap_seconds, s.max_gap_seconds) * 1000)).toISOString(),
      consecutive_errors: 0, last_error: '',
    });
    await log(`Sent opener to ${c.name || c.phone} (${c.region}).`, 'sent');
  } catch (e) {
    if (/not on whatsapp|not registered|invalid jid/i.test(e.message)) {
      await q(db.from('contacts').update({ status: 'not_on_whatsapp' }).eq('phone', c.phone), 'mark not on wa');
      await saveSettings({ next_send_at: new Date(Date.now() + scale(15000)).toISOString() });
      await log(`${c.name || c.phone} is not on WhatsApp, skipped.`, 'muted');
    } else {
      const n = (s.consecutive_errors || 0) + 1;
      const patch = { consecutive_errors: n, last_error: e.message, next_send_at: new Date(Date.now() + scale(5 * 60000)).toISOString() };
      if (n >= 3) patch.running = false;
      await saveSettings(patch);
      await log(`Could not send to ${c.name || c.phone}: ${e.message}. Will retry in 5 minutes.`, 'error');
      if (n >= 3) await log('Paused after 3 errors in a row. Check WhatsApp, then press Start on the dashboard.', 'error');
    }
  }
}

async function sendDetails(s, c) {
  const text = R.renderMessage(s.details, c);
  try {
    await sendHuman(c.phone, text, s.typing_indicator);
    await q(db.from('contacts').update({ status: 'details_sent', details_at: nowIso(), pending_details_at: null, needs_you: false }).eq('phone', c.phone), 'mark details');
    await addMessage(c.phone, 'us', text);
    await log(`Sent details + demo link to ${c.name || c.phone}.`, 'good');
  } catch (e) {
    await q(db.from('contacts').update({ pending_details_at: new Date(Date.now() + scale(10 * 60000)).toISOString() }).eq('phone', c.phone), 'retry details');
    await log(`Could not send details to ${c.name || c.phone}: ${e.message}. Will retry in 10 minutes.`, 'error');
  }
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await getSettings();
    // 1. details for people who said yes go out any time, even when paused
    const due = await q(db.from('contacts').select('*').lte('pending_details_at', nowIso()).order('pending_details_at').limit(1), 'due details');
    if (due.length) {
      if ((await refreshGowa()).loggedIn) await sendDetails(s, due[0]);
      return;
    }
    // 2. new openers, paced
    if (!s.running || !inHours(s)) return;
    if (s.next_send_at && Date.now() < Date.parse(s.next_send_at)) return;
    if ((await sentToday(s)) >= todaysLimit(s)) return;
    if (!(await refreshGowa()).loggedIn) { if (s.last_error !== 'WhatsApp is not connected.') await saveSettings({ last_error: 'WhatsApp is not connected.' }); return; }
    const next = await q(db.from('contacts').select('*').eq('status', 'pending').order('seq').limit(1), 'next contact');
    if (!next.length) {
      await saveSettings({ running: false });
      await log('Everyone on the list has been messaged. Sending stopped.', 'good');
      return;
    }
    await sendOpener(s, next[0]);
  } catch (e) {
    console.error('tick:', e.message);
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- replies (gowa webhook)
const jidUser = (jid) => String(jid || '').split('@')[0].split(':')[0];

async function handleWebhook(raw, signature) {
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.gowa.webhookSecret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 401;
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return 400; }
  const p = body.payload || {};
  const chat = String(p.chat_id || '');
  if (!/@s\.whatsapp\.net$|@lid$/.test(chat)) return 200;

  const phones = [...new Set([jidUser(chat), jidUser(p.from)].filter(Boolean))];
  let rows = await q(db.from('contacts').select('*').in('phone', phones).limit(1), 'find contact');
  if (!rows.length && p.replied_to_id) rows = await q(db.from('contacts').select('*').eq('message_id', p.replied_to_id).limit(1), 'find by reply');
  const c = rows[0];
  if (!c) return 200;
  const who = c.name || c.phone;

  if (body.event === 'message.reaction') {
    if (p.is_from_me) return 200;
    await addMessage(c.phone, 'them', `reacted ${p.reaction || ''}`);
    await q(db.from('contacts').update({ needs_you: true, status: c.status === 'sent' ? 'replied' : c.status, last_reply: `reacted ${p.reaction || ''}`, last_reply_at: nowIso() }).eq('phone', c.phone), 'reaction');
    await log(`${who} reacted ${p.reaction || ''} to your message.`, 'reply');
    return 200;
  }
  if (body.event !== 'message') return 200;

  const text = String(p.body || p.text || (p.image && p.image.caption) || (p.video && p.video.caption) || '').trim() || '[media]';
  if (p.is_from_me) {
    if (ourIds.has(p.id)) return 200;
    if ((recentOut.get(c.phone) || []).some((x) => x.text.trim() === text && Date.now() - x.at < 5 * 60000)) return 200;
    await addMessage(c.phone, 'us', text);
    if (c.needs_you) {
      await q(db.from('contacts').update({ needs_you: false }).eq('phone', c.phone), 'clear needs');
      await log(`You replied to ${who} from your phone.`, 'muted');
    }
    return 200;
  }

  await addMessage(c.phone, 'them', text);
  const patch = { last_reply: text, last_reply_at: nowIso() };
  const s = await getSettings();
  if (c.status === 'sent') {
    const kind = R.classifyReply(text);
    if (kind === 'positive') {
      patch.status = 'interested';
      patch.pending_details_at = new Date(Date.now() + scale(rand(s.details_delay_seconds[0], s.details_delay_seconds[1]) * 1000)).toISOString();
      await log(`${who} replied "${text.slice(0, 60)}" → sending details shortly.`, 'reply');
    } else if (kind === 'negative') {
      patch.status = 'not_interested';
      await log(`${who} replied "${text.slice(0, 60)}" → marked not interested.`, 'muted');
      const bye = (s.not_interested_reply || '').trim();
      if (bye && !/\bstop\b|unsubscribe|block|spam/i.test(text)) {
        const t = R.renderMessage(bye, c);
        sendHuman(c.phone, t, false).then(() => addMessage(c.phone, 'us', t)).catch(() => {});
      }
    } else {
      patch.status = 'replied';
      patch.needs_you = true;
      await log(`${who} replied "${text.slice(0, 60)}" → needs your reply.`, 'reply');
    }
  } else {
    patch.needs_you = true;
    await log(`New message from ${who}: "${text.slice(0, 60)}"`, 'reply');
  }
  await q(db.from('contacts').update(patch).eq('phone', c.phone), 'save reply');
  return 200;
}

// ---------------------------------------------------------------- jobs from the dashboard
async function runCommand(cmd) {
  const s = await getSettings();
  switch (cmd.type) {
    case 'login': {
      let r;
      try { r = await gowa.loginQr(); } catch (e) {
        throw new Error(/reconnect|dial|websocket|handshake/i.test(e.message)
          ? "Couldn't reach WhatsApp's servers. If this laptop is on campus Wi-Fi/LAN, switch it to a mobile hotspot and try again." : e.message);
      }
      const until = new Date(Date.now() + r.seconds * 1000).toISOString();
      await q(db.from('worker_status').update({ qr_png: r.qrPng.toString('base64'), qr_until: until }).eq('id', 1), 'save qr');
      return { seconds: r.seconds };
    }
    case 'paircode': {
      const num = R.normalisePhone(cmd.payload.phone);
      if (!num) throw new Error('Enter the outreach phone number (10 digits).');
      return { code: await gowa.loginCode(num) };
    }
    case 'test': {
      const num = R.normalisePhone(s.test_number);
      if (!num) throw new Error('Add your own number under Settings → "Your number for tests" first.');
      const sample = (await q(db.from('contacts').select('first,name').eq('status', 'pending').not('first', 'is', null).neq('first', '').order('seq').limit(1), 'sample'))[0]
        || { first: 'Kesav', name: 'Kesav Krishna K' };
      await sendHuman(num, R.renderMessage(s.opener, sample), s.typing_indicator);
      await sleep(scale(1500));
      await sendHuman(num, R.renderMessage(s.details, sample), s.typing_indicator);
      await log(`Test: sent the opener and details (as if to ${sample.first}) to your number.`, 'good');
      return { sentTo: num };
    }
    case 'reply': {
      const text = String(cmd.payload.text || '').trim();
      if (!text) throw new Error('Type a message first.');
      const c = (await q(db.from('contacts').select('phone,name').eq('phone', cmd.payload.phone), 'find'))[0];
      if (!c) throw new Error('Unknown contact');
      await sendHuman(c.phone, text, s.typing_indicator);
      await addMessage(c.phone, 'us', text);
      await q(db.from('contacts').update({ needs_you: false }).eq('phone', c.phone), 'clear needs');
      await log(`You replied to ${c.name || c.phone} from the dashboard.`, 'muted');
      return { ok: true };
    }
    case 'restartgowa': {
      if (!gowaProc) gowaProc = new GowaProcess(cfg.gowa, ROOT, WEBHOOK_PORT, (t, k) => log(t, k));
      await log('Restarting gowa…', 'muted');
      const port = await gowaProc.restart(isOurGowa);
      gowa.setPort(port);
      for (let i = 0; i < 45 && gowaProc.state === 'starting'; i++) { await sleep(1000); await refreshGowa(); if (gowaStatus.reachable) break; }
      return { state: gowaProc.state };
    }
    default: throw new Error('Unknown job ' + cmd.type);
  }
}

let cmdBusy = false;
async function pollCommands() {
  if (cmdBusy) return;
  cmdBusy = true;
  try {
    const queued = await q(db.from('commands').select('*').eq('status', 'queued').order('id').limit(5), 'read jobs');
    for (const cmd of queued) {
      // claim it (only one sender may run a job)
      const claimed = await q(db.from('commands').update({ status: 'running' }).eq('id', cmd.id).eq('status', 'queued').select('id'), 'claim job');
      if (!claimed.length) continue;
      if (Date.now() - Date.parse(cmd.created_at) > 10 * 60000) {
        await db.from('commands').update({ status: 'failed', error: 'Expired: the sender was offline when you asked.', done_at: nowIso() }).eq('id', cmd.id);
        continue;
      }
      try {
        const result = await runCommand(cmd);
        await db.from('commands').update({ status: 'done', result, done_at: nowIso() }).eq('id', cmd.id);
      } catch (e) {
        await db.from('commands').update({ status: 'failed', error: e.message, done_at: nowIso() }).eq('id', cmd.id);
      }
    }
  } catch (e) {
    console.error('jobs:', e.message);
  } finally {
    cmdBusy = false;
  }
}

// ---------------------------------------------------------------- heartbeat
async function heartbeat() {
  try {
    await refreshGowa();
    const info = gowaProc ? gowaProc.info() : { state: cfg.gowa.autoStart === false ? 'manual' : 'idle', reason: '', tail: '' };
    const patch = {
      instance_id: cfg.instanceId, heartbeat_at: nowIso(), version: VERSION, platform: process.platform,
      gowa_reachable: gowaStatus.reachable, logged_in: gowaStatus.loggedIn, number: jidUser(gowaStatus.jid) || null,
      proc_state: gowaStatus.reachable ? 'running' : info.state, proc_reason: gowaStatus.reachable ? '' : (info.reason || gowaStatus.error || ''),
      proc_tail: gowaStatus.reachable ? '' : (info.tail || ''),
    };
    if (gowaStatus.loggedIn) { patch.qr_png = null; patch.qr_until = null; }
    await db.from('worker_status').update(patch).eq('id', 1);
  } catch (e) {
    console.error('heartbeat:', e.message);
  }
}

// ---------------------------------------------------------------- start
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      let code = 500;
      try { code = await handleWebhook(Buffer.concat(chunks), req.headers['x-hub-signature-256']); } catch (e) { console.error('webhook:', e.message); }
      res.writeHead(code); res.end();
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('AlmaED sender is running. Use your dashboard on Vercel to control it.');
});

async function main() {
  // only one sender at a time
  const ws = (await q(db.from('worker_status').select('instance_id,heartbeat_at').eq('id', 1), 'read worker status'))[0];
  if (ws && ws.instance_id && ws.instance_id !== cfg.instanceId && ws.heartbeat_at && Date.now() - Date.parse(ws.heartbeat_at) < 60000) {
    console.error('\nAnother sender is already running on a different computer. Stop that one first (or wait a minute), then start this again.\n');
    process.exit(1);
  }
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${WEBHOOK_PORT} is busy. Is the sender already running in another window?`) : e));
    server.listen(WEBHOOK_PORT, '127.0.0.1', resolve);
  });
  console.log(`\nAlmaED sender v${VERSION} is running. Keep this window open; control everything from your dashboard.\n`);

  await refreshGowa();
  if (!gowaStatus.reachable && cfg.gowa.autoStart !== false) {
    gowaProc = new GowaProcess(cfg.gowa, ROOT, WEBHOOK_PORT, (t, k) => log(t, k));
    const port = await gowaProc.start(isOurGowa);
    gowa.setPort(port);
    if (gowaProc.state === 'starting') await log('Starting gowa (the WhatsApp connector). The first start can take up to a minute.', 'muted');
  }
  await heartbeat();
  for (let i = 0; i < 60 && !gowaStatus.reachable && (!gowaProc || gowaProc.state === 'starting'); i++) { await sleep(1000); await refreshGowa(); }
  if (gowaStatus.reachable) await log(gowaStatus.loggedIn ? 'Sender is online and WhatsApp is connected.' : 'Sender is online. Link WhatsApp from the dashboard ("Show QR code").', 'good');

  setInterval(heartbeat, Number(process.env.SENDER_HEARTBEAT_MS || 10000));
  setInterval(pollCommands, Number(process.env.SENDER_POLL_MS || 3000));
  setInterval(tick, Number(process.env.SENDER_TICK_MS || 10000));
}

async function shutdown() {
  if (gowaProc) gowaProc.stop();
  try { await db.from('worker_status').update({ heartbeat_at: null, gowa_reachable: false, logged_in: false }).eq('id', 1); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function explain(e) {
  const m = String(e && e.message || e);
  if (/invalid api key|jwt|unauthorized|no api key/i.test(m)) return 'Supabase did not accept the key in config.json. Copy the secret (service_role) key again, with nothing missing at the ends.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(m)) return 'Could not reach Supabase. Check the internet connection and the supabaseUrl in config.json.\n(' + m + ')';
  if (/does not exist|schema cache|Could not find the table/i.test(m)) return 'The database tables are missing. In Supabase, open SQL Editor and run supabase/schema.sql, then start the sender again.';
  return m;
}
if (require.main === module) main().catch((e) => { console.error('\n' + explain(e) + '\n'); process.exit(1); });
module.exports = { main, tick, pollCommands, heartbeat, handleWebhook, startOfDay, todaysLimit };
