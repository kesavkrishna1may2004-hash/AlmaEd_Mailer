// Vercel build step: copies the static files to dist/ and writes dist/config.js from the
// project's environment variables. No packages needed.
//   SUPABASE_URL       e.g. https://abcdefgh.supabase.co
//   SUPABASE_ANON_KEY  the "anon public" or "publishable" key (NEVER the service_role / secret key)
const fs = require('fs');
const path = require('path');

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();

function fail(msg) {
  console.error('\n  BUILD STOPPED: ' + msg + '\n');
  process.exit(1);
}
if (!url || !key) fail('Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel -> Project -> Settings -> Environment Variables, then redeploy.');
if (!/^https?:\/\/[^\s/]+$/.test(url)) fail('SUPABASE_URL should look like https://abcdefgh.supabase.co (no path after it).');
if (/^sb_secret_/.test(key)) fail('SUPABASE_ANON_KEY is a SECRET key. Use the "publishable" (or "anon public") key here; the secret key goes only in the sender\'s config.json.');
try {
  const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
  if (claims.role === 'service_role') fail('SUPABASE_ANON_KEY is the service_role key. Use the "anon public" key here; the service_role key goes only in the sender\'s config.json.');
} catch (_) { /* new-style sb_publishable_ keys are not JWTs */ }

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of ['index.html', 'app.js', 'rules.js']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'config.js'),
  `window.ALMA_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key })};\n`);
console.log('Dashboard built for ' + url);
