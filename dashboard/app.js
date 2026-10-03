// AlmaED outreach dashboard (static page on Vercel). Data lives in Supabase; the sender on the
// laptop does the WhatsApp work and picks up jobs from the "commands" table.
(function () {
  'use strict';
  const cfg = window.ALMA_CONFIG || {};
  const R = window.AlmaRules;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtPhone = (p) => String(p || '').replace(/^91(\d{5})(\d{5})$/, '+91 $1 $2');
  const fmtTime = (t) => {
    const d = new Date(t);
    const sameDay = new Date().toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hm;
  };
  function toast(t, ms = 3500) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => (el.style.display = 'none'), ms); }

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    document.body.innerHTML = '<p style="padding:24px">Setup incomplete: set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in Vercel → Project → Settings → Environment Variables, then redeploy.</p>';
    return;
  }
  if (!window.supabase || !R) {
    document.body.innerHTML = '<p style="padding:24px">Could not load the page\'s scripts. Check your internet connection, turn off any ad-blocker for this site, and reload.</p>';
    return;
  }
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // ---------------------------------------------------------------- time helpers (IST by default)
  function zoned(ts, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  }
  function startOfDay(tz) {
    const now = Date.now(), { day } = zoned(now, tz);
    let t = now - (now % (15 * 60000));
    while (zoned(t - 15 * 60000, tz).day === day) t -= 15 * 60000;
    return new Date(t).toISOString();
  }
  function todaysLimit(s) {
    const day = zoned(Date.now(), s.timezone).day;
    let idx = (s.days_active || []).indexOf(day);
    if (idx < 0) idx = (s.days_active || []).length;
    const w = s.warmup || [];
    return Math.min(s.daily_limit, idx < w.length ? w[idx] : s.daily_limit);
  }

  // ---------------------------------------------------------------- auth
  let session = null, timer = null, S = {};
  async function boot() {
    const { data } = await db.auth.getSession();
    session = data.session;
    if (!session) return showLogin();
    $('signout').hidden = false;
    const { data: ok, error } = await db.rpc('is_admin');
    if (error || !ok) return showNotAdmin(session.user.email, error);
    $('login').hidden = true; $('notAdmin').hidden = true; $('app').hidden = false; $('pill').hidden = false;
    await refresh(true);
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, 8000);   // no polling while the tab is in the background
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) refresh(); });
  function showLogin() { $('app').hidden = true; $('pill').hidden = true; $('signout').hidden = true; $('notAdmin').hidden = true; $('login').hidden = false; }
  function showNotAdmin(email, error) {
    $('app').hidden = true; $('login').hidden = true; $('notAdmin').hidden = false;
    $('notAdmin').innerHTML = error
      ? `<h2>Can't reach the database</h2><p>${esc(error.message)}</p><p class="sub">Did you run <code>supabase/schema.sql</code> in Supabase → SQL Editor?</p>`
      : `<h2>This account isn't allowed yet</h2><p>You're signed in as <b>${esc(email)}</b>, but this email isn't on the admin list.</p>
         <p>In Supabase, open <b>SQL Editor</b>, run this, then reload this page:</p><pre>insert into public.admins (email) values ('${esc(email)}');</pre>`;
  }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginMsg').textContent = 'Signing in…';
    const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    $('loginMsg').textContent = error ? error.message : '';
    if (!error) boot();
  });
  $('signout').onclick = async () => { clearInterval(timer); await db.auth.signOut(); location.reload(); };

  // ---------------------------------------------------------------- data
  async function must(p, what) { const r = await p; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r; }

  async function load() {
    // After the first load, skip the long message texts to keep Supabase egress low.
    const cols = settingsLoaded ? 'running,daily_limit,warmup,send_from_hour,send_until_hour,timezone,days_active,next_send_at,last_error' : '*';
    const [settings, worker, counts, needs, activity] = await Promise.all([
      must(db.from('settings').select(cols).eq('id', 1).single(), 'settings'),
      must(db.from('worker_status').select('*').eq('id', 1).single(), 'sender status'),
      must(db.from('contact_counts').select('*'), 'counts'),
      must(db.from('contacts').select('phone,name,region,status,last_reply_at').eq('needs_you', true).order('last_reply_at', { ascending: false, nullsFirst: false }).limit(25), 'replies'),
      must(db.from('activity').select('*').order('at', { ascending: false }).limit(40), 'activity'),
    ]);
    const s = settings.data;
    const t = await must(db.from('contacts').select('phone', { count: 'exact', head: true }).gte('sent_at', startOfDay(s.timezone)), 'sent today');
    const phones = needs.data.map((n) => n.phone);
    let msgs = [];
    if (phones.length) msgs = (await must(db.from('messages').select('phone,direction,body,at').in('phone', phones).order('at', { ascending: true }).limit(500), 'messages')).data;
    const k = { pending: 0, sent: 0, replied: 0, interested: 0, details_sent: 0, not_interested: 0, not_on_whatsapp: 0, skipped: 0 };
    counts.data.forEach((r) => { k[r.status] = r.n; });
    return { s, w: worker.data, k, today: t.count || 0, needs: needs.data.map((n) => ({ ...n, thread: msgs.filter((m) => m.phone === n.phone).slice(-6) })), activity: activity.data };
  }

  let lastNeedsKey = '', settingsLoaded = false, alertKey = '', importNote = '';
  const drafts = {};
  async function refresh(first) {
    try {
      S = await load();
    } catch (e) {
      if (/JWT|auth|401/i.test(e.message)) { const { data } = await db.auth.getSession(); if (!data.session) return location.reload(); }
      $('waiting').textContent = 'Could not load data: ' + e.message;
      return;
    }
    render(first);
  }

  function render() {
    const { s, w, k, today } = S;
    const online = w.heartbeat_at && Date.now() - Date.parse(w.heartbeat_at) < 45000;
    const linked = online && w.logged_in;
    const total = Object.values(k).reduce((a, b) => a + b, 0);
    const win = w.platform === 'win32';

    // header pill
    $('dot').className = 'dot ' + (linked ? 'on' : online ? 'wait' : 'off');
    $('pilltext').textContent = linked ? 'WhatsApp connected · ' + fmtPhone(w.number) : online ? (w.gowa_reachable ? 'WhatsApp not linked' : 'Sender online · gowa not running') : 'Sender offline';

    // alert
    let html = '', cls = '';
    if (!online) {
      cls = 'warn';
      html = `<b>The sender on your laptop is offline.</b> Double-click <b>Start AlmaED Sender</b> on the laptop (or server) and keep its window open. ` +
        (w.heartbeat_at ? `Last seen ${fmtTime(w.heartbeat_at)}.` : 'It has never connected yet. Check its config.json has your Supabase URL and service key.');
    } else if (!w.gowa_reachable) {
      const restart = ' <button class="btn" data-job="restartgowa">Restart gowa</button>';
      if (w.proc_state === 'starting') { cls = 'warn'; html = '<b>Starting gowa, the WhatsApp connector…</b> The first start can take up to a minute.'; }
      else if (w.proc_state === 'missing' || w.proc_state === 'blocked') {
        cls = 'bad';
        html = `<b>gowa could not start on the laptop.</b> ${esc(w.proc_reason)}<br><br>` + (win
          ? '<b>Fix:</b> on the laptop open <b>Windows Security → Virus &amp; threat protection → Protection history</b>, click the item for <code>windows-amd64.exe</code> → <b>Actions → Restore</b> (or <b>Allow on device</b>). If it isn\'t listed, copy <code>gowa\\windows-amd64.exe</code> from the zip back into the sender\'s <code>gowa</code> folder. Then click' + restart
          : '<b>Fix:</b> on the Mac open <b>System Settings → Privacy &amp; Security</b>, scroll down, click <b>Allow Anyway</b> for gowa. Then click' + restart);
      } else { cls = 'bad'; html = `<b>gowa stopped.</b> ${esc(w.proc_reason || '')}${restart}` + (w.proc_tail ? `<pre>${esc(w.proc_tail)}</pre>` : ''); }
    } else if (total === 0) {
      cls = 'warn'; html = '<b>No contacts yet.</b> Download your alumni Sheet as .xlsx and import it in the <b>Contacts</b> box below.';
    } else if (s.last_error && !s.running && s.last_error !== 'WhatsApp is not connected.') {
      cls = 'bad'; html = '<b>Last problem:</b> ' + esc(s.last_error);
    }
    const key = cls + html;
    if (key !== alertKey) {
      alertKey = key;
      $('alert').hidden = !html; $('alert').className = 'card full alert ' + cls; $('alert').innerHTML = html;
      $('alert').querySelectorAll('[data-job]').forEach((b) => (b.onclick = () => runJob(b.dataset.job, {}, b)));
    }

    // QR panel
    $('linkPanel').hidden = !(online && w.gowa_reachable && !w.logged_in);
    const qrLive = w.qr_png && w.qr_until && Date.parse(w.qr_until) > Date.now();
    $('qrImg').hidden = !qrLive; $('qrPlaceholder').hidden = !!qrLive;
    if (qrLive) {
      const src = 'data:image/png;base64,' + w.qr_png;
      if ($('qrImg').getAttribute('src') !== src) $('qrImg').src = src;
      $('qrInfo').textContent = `Scan within ${Math.max(0, Math.round((Date.parse(w.qr_until) - Date.now()) / 1000))}s`;
    } else if ($('qrInfo').dataset.busy !== '1') $('qrInfo').textContent = '';

    // control
    const limit = todaysLimit(s);
    const h = zoned(Date.now(), s.timezone).hour;
    let waiting;
    if (!s.running) waiting = 'Paused';
    else if (!online) waiting = 'Waiting for the sender on your laptop';
    else if (!linked) waiting = 'Waiting for WhatsApp to be linked';
    else if (h < s.send_from_hour || h >= s.send_until_hour) waiting = `Outside sending hours (${s.send_from_hour}:00–${s.send_until_hour}:00)`;
    else if (today >= limit) waiting = "Today's limit reached; continues tomorrow";
    else if (s.next_send_at && Date.parse(s.next_send_at) > Date.now()) waiting = `Next message in ${Math.ceil((Date.parse(s.next_send_at) - Date.now()) / 1000)}s`;
    else waiting = 'Sending…';
    $('waiting').textContent = waiting;
    $('toggle').textContent = s.running ? 'Pause sending' : 'Start sending';
    $('toggle').className = 'big' + (s.running ? ' pause' : '');
    $('toggle').disabled = !s.running && k.pending === 0;
    $('todaybar').style.width = Math.min(100, (100 * today) / Math.max(1, limit)) + '%';
    $('todaytext').textContent = `Today: ${today} of ${limit} sent` + (limit < s.daily_limit ? ` (warm-up; goes up to ${s.daily_limit}/day)` : '') +
      ` · ${s.send_from_hour}:00–${s.send_until_hour}:00 IST` + (k.pending ? ` · about ${Math.ceil(k.pending / Math.max(1, s.daily_limit))} day(s) left` : '');

    // stats
    const items = [
      ['Left to send', k.pending], ['Openers sent', k.sent + k.replied + k.interested + k.details_sent + k.not_interested],
      ['Details sent', k.details_sent + k.interested], ['Needs your reply', S.needs.length, true],
      ['Not interested', k.not_interested], ['Not on WhatsApp', k.not_on_whatsapp], ['Skipped (call notes)', k.skipped],
    ];
    $('stats').innerHTML = items.map(([l, v, hl]) => `<div class="stat${hl && v ? ' hl' : ''}"><b>${v}</b><span>${l}</span></div>`).join('');

    // needs you
    const nk = JSON.stringify(S.needs.map((n) => [n.phone, n.thread.length]));
    if (nk !== lastNeedsKey) {
      lastNeedsKey = nk;
      $('needs').innerHTML = S.needs.length ? S.needs.map((n) => `
        <div class="rcard" data-phone="${esc(n.phone)}">
          <h3>${esc(n.name || fmtPhone(n.phone))}</h3>
          <div class="meta">${esc(fmtPhone(n.phone))} · ${esc(n.region || '')}</div>
          <div class="thread">${n.thread.map((m) => `<div class="msg ${m.direction}">${esc(m.body)}</div>`).join('')}</div>
          <textarea placeholder="Type a reply… (sends from the outreach number)">${esc(drafts[n.phone] || '')}</textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn primary" data-r="reply">Send reply</button>
            <button class="btn" data-r="details">Send details + demo link</button>
            <button class="btn" data-r="notinterested">Not interested</button>
            <button class="btn ghost" data-r="done">Done</button>
          </div>
        </div>`).join('') : '<div class="empty">No replies waiting. Positive replies get the details and demo link automatically.</div>';
      document.querySelectorAll('.rcard .thread').forEach((t) => (t.scrollTop = t.scrollHeight));
    }

    // activity
    $('feed').innerHTML = S.activity.map((a) => `<li><time>${fmtTime(a.at)}</time><span class="${esc(a.kind)}">${esc(a.text)}</span></li>`).join('') || '<li class="empty">Nothing yet.</li>';
    if (!importNote) $('importInfo').textContent = total ? `${total} contacts in the database.` : '';

    // settings form (fill once, so typing isn't overwritten)
    if (!settingsLoaded) {
      settingsLoaded = true;
      $('sOpener').value = s.opener; $('sDetails').value = s.details; $('sBye').value = s.not_interested_reply || '';
      $('sTest').value = s.test_number || ''; $('sLimit').value = s.daily_limit; $('sFrom').value = s.send_from_hour; $('sUntil').value = s.send_until_hour;
      $('sMin').value = s.min_gap_seconds; $('sMax').value = s.max_gap_seconds;
    }
  }

  // ---------------------------------------------------------------- jobs for the sender
  async function runJob(type, payload, btn) {
    if (!(S.w && S.w.heartbeat_at && Date.now() - Date.parse(S.w.heartbeat_at) < 45000)) { toast('The sender on your laptop is offline. Start it first.', 5000); return null; }
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await db.from('commands').insert({ type, payload }).select('id').single();
      if (error) throw error;
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data: c } = await db.from('commands').select('status,result,error').eq('id', data.id).single();
        if (c && c.status === 'done') return c.result || {};
        if (c && c.status === 'failed') { toast(c.error || 'That did not work.', 7000); return null; }
      }
      toast('The sender did not answer in time. Is its window still open on the laptop?', 6000);
      return null;
    } catch (e) { toast(e.message, 6000); return null; }
    finally { if (btn) btn.disabled = false; refresh(); }
  }

  $('toggle').onclick = async () => {
    const running = !S.s.running;
    const patch = running ? { running, consecutive_errors: 0, last_error: '' } : { running };
    const { error } = await db.from('settings').update(patch).eq('id', 1);
    if (error) return toast(error.message);
    await db.from('activity').insert({ text: running ? 'Sending started from the dashboard.' : 'Sending paused from the dashboard.', kind: running ? 'good' : 'muted' });
    refresh();
  };
  $('qrBtn').onclick = async () => {
    $('qrInfo').dataset.busy = '1'; $('qrInfo').textContent = 'Asking the laptop for a QR code…';
    const r = await runJob('login', {}, $('qrBtn'));
    $('qrInfo').dataset.busy = '';
    if (r) toast('Scan the QR code with the spare phone.');
  };
  $('pairBtn').onclick = async () => {
    const r = await runJob('paircode', { phone: $('pairPhone').value }, $('pairBtn'));
    if (r && r.code) $('pairCode').textContent = r.code;
  };
  $('testBtn').onclick = async () => {
    await saveSettings(true);
    const r = await runJob('test', {}, $('testBtn'));
    if (r) toast('Test sent. Check WhatsApp on your own number.');
  };
  $('restartBtn').onclick = () => runJob('restartgowa', {}, $('restartBtn'));

  $('needs').addEventListener('input', (e) => { const c = e.target.closest('.rcard'); if (c) drafts[c.dataset.phone] = e.target.value; });
  $('needs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    const phone = b.closest('.rcard').dataset.phone;
    const action = b.dataset.r;
    if (action === 'reply') {
      const text = b.closest('.rcard').querySelector('textarea').value.trim();
      if (!text) return toast('Type a message first.');
      if (await runJob('reply', { phone, text }, b)) { delete drafts[phone]; lastNeedsKey = ''; toast('Reply sent.'); }
      return;
    }
    const patch = action === 'details' ? { status: 'interested', pending_details_at: new Date().toISOString(), needs_you: false }
      : action === 'notinterested' ? { status: 'not_interested', pending_details_at: null, needs_you: false }
        : { needs_you: false };
    b.disabled = true;
    const { error } = await db.from('contacts').update(patch).eq('phone', phone);
    b.disabled = false;
    if (error) return toast(error.message);
    if (action === 'details') toast('The details message will go out in a moment.');
    lastNeedsKey = ''; refresh();
  });

  // ---------------------------------------------------------------- settings
  async function saveSettings(quiet) {
    const num = (id, lo, hi) => { const v = Number($(id).value); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${$(id).previousElementSibling.textContent}: enter a number from ${lo} to ${hi}.`); return Math.round(v); };
    try {
      const patch = {
        opener: $('sOpener').value, details: $('sDetails').value, not_interested_reply: $('sBye').value,
        test_number: $('sTest').value.trim(), daily_limit: num('sLimit', 1, 500), send_from_hour: num('sFrom', 0, 23), send_until_hour: num('sUntil', 1, 24),
        min_gap_seconds: num('sMin', 30, 3600), max_gap_seconds: num('sMax', 30, 3600), updated_at: new Date().toISOString(),
      };
      if (patch.max_gap_seconds < patch.min_gap_seconds) throw new Error('Max gap must be at least the min gap.');
      if (patch.send_until_hour <= patch.send_from_hour) throw new Error('"Send until" must be later than "Send from".');
      if (!patch.opener.trim() || !patch.details.trim()) throw new Error('The messages cannot be empty.');
      if (patch.test_number && !R.normalisePhone(patch.test_number)) throw new Error('Test number: enter a 10-digit Indian mobile number.');
      const { error } = await db.from('settings').update(patch).eq('id', 1);
      if (error) throw error;
      if (!quiet) toast(patch.daily_limit > 80 ? 'Saved. Note: more than 80 a day raises the risk of a ban.' : 'Saved.', 5000);
      return true;
    } catch (e) { toast(e.message, 6000); throw e; }
  }
  $('saveBtn').onclick = () => saveSettings(false).catch(() => {});

  // ---------------------------------------------------------------- import (.xlsx parsed in the browser)
  const NOT_REGION_TABS = ['distribution', 'whatsapp message', 'email list', 'email template'];
  function parseWorkbook(wb, skipEmailed) {
    const rowsOf = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }).map((r) => r.map((x) => String(x).trim()));
    const emailed = new Set();
    const et = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'email list');
    if (et) {
      const rows = rowsOf(et), hd = (rows[0] || []).map((x) => x.toLowerCase());
      const ce = hd.indexOf('email'), cs = hd.indexOf('status');
      if (ce >= 0 && cs >= 0) rows.slice(1).forEach((r) => { if (r[cs] === 'Sent' && r[ce]) emailed.add(r[ce].toLowerCase()); });
    }
    const seen = new Set(), out = [], stats = { tabs: 0, duplicates: 0, skipped: {} };
    for (const name of wb.SheetNames) {
      const tab = name.trim();
      if (NOT_REGION_TABS.includes(tab.toLowerCase()) || /^email/i.test(tab)) continue;
      stats.tabs++;
      const rows = rowsOf(name);
      if (!rows.length) continue;
      const header = rows[0].map((x) => x.toLowerCase());
      const waCol = header.indexOf('wa number') >= 0 ? header.indexOf('wa number') : 1;
      const statusCol = header.indexOf('almaed status');
      const notesFrom = statusCol >= 0 ? statusCol + 1 : 7;
      for (const row of rows) {
        if (String(row[waCol] || '').toLowerCase() === 'wa number' || !row.some((x) => x)) continue;
        const phone = R.normalisePhone(row[waCol]);           // only the WA number column (other cells hold landlines)
        if (!phone) continue;
        if (seen.has(phone)) { stats.duplicates++; continue; }
        seen.add(phone);
        const email = R.pickEmail(row);
        let skip = R.skipReason(row, notesFrom);
        if (!skip && statusCol >= 0 && row[statusCol]) skip = 'already contacted on WhatsApp (' + row[statusCol] + ')';
        if (!skip && skipEmailed && email && emailed.has(email)) skip = 'already emailed';
        if (skip) { const kk = skip.replace(/ \(.*/, ''); stats.skipped[kk] = (stats.skipped[kk] || 0) + 1; }
        out.push({ phone, region: tab, name: R.fullName(row[0]) || null, first: R.firstName(row[0]) || null, email: email || null, status: skip ? 'skipped' : 'pending', skip_reason: skip || null });
      }
    }
    return { contacts: out, stats };
  }
  $('importBtn').onclick = async () => {
    const f = $('file').files[0];
    if (!f) return toast('Choose the .xlsx file first.');
    const btn = $('importBtn'); btn.disabled = true;
    const note = (t) => { importNote = t; $('importInfo').textContent = t; };
    try {
      note('Reading the file…');
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const { contacts, stats } = parseWorkbook(wb, $('skipEmailed').checked);
      if (!contacts.length) throw new Error('No WhatsApp numbers found. Is this the alumni Sheet with a "WA number" column?');
      let added = 0;
      for (let i = 0; i < contacts.length; i += 500) {
        note(`Uploading ${Math.min(i + 500, contacts.length)} of ${contacts.length}…`);
        const { data, error } = await db.from('contacts').upsert(contacts.slice(i, i + 500), { onConflict: 'phone', ignoreDuplicates: true }).select('phone');
        if (error) throw error;
        added += data.length;
      }
      const sk = Object.entries(stats.skipped).map(([kk, v]) => `${v} ${kk}`).join(', ');
      const msg = `Imported ${f.name}: ${added} new contacts from ${stats.tabs} tabs (${stats.duplicates} duplicate numbers merged${sk ? '; skipped from call notes: ' + sk : ''}).`;
      await db.from('activity').insert({ text: msg, kind: 'good' });
      note(msg); toast(`Imported ${added} new contacts.`);
    } catch (e) { note(''); toast(e.message, 7000); }
    finally { btn.disabled = false; refresh(); }
  };

  // ---------------------------------------------------------------- export
  $('exportBtn').onclick = async () => {
    const btn = $('exportBtn'); btn.disabled = true;
    try {
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('contacts').select('phone,name,first,region,email,status,skip_reason,sent_at,last_reply,last_reply_at,details_at').order('seq').range(from, from + 999);
        if (error) throw error;
        all.push(...data);
        if (data.length < 1000) break;
      }
      const t = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');
      const cell = (v) => { const x = String(v == null ? '' : v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
      const lines = [['Phone', 'Name', 'First name', 'Region', 'Email', 'Status', 'Skip reason', 'Opener sent', 'Last reply', 'Reply time', 'Details sent']]
        .concat(all.map((c) => [c.phone, c.name, c.first, c.region, c.email, c.status, c.skip_reason, t(c.sent_at), c.last_reply, t(c.last_reply_at), t(c.details_at)]));
      const blob = new Blob(['\uFEFF' + lines.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'almaed-whatsapp-status.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message, 6000); }
    finally { btn.disabled = false; }
  };

  boot();
})();
