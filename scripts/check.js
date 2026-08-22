const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const serverFiles = [
  'src/server.js',
  'src/routes.js',
  'src/db.js',
  'src/scanner.js',
  'src/scheduler.js',
  'src/config.js',
];

for (const file of serverFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const clientFile = 'public/app.js';
if (!fs.existsSync(clientFile)) {
  console.error(`Missing dashboard client: ${clientFile}`);
  process.exit(1);
}

const clientResult = spawnSync(process.execPath, ['--check', clientFile], { stdio: 'inherit' });
if (clientResult.status !== 0) process.exit(clientResult.status || 1);

const html = fs.readFileSync('public/index.html', 'utf8');

if (!html.includes('href="/styles.css"')) {
  console.error('Dashboard does not reference the compiled Tailwind stylesheet.');
  process.exit(1);
}

if (!html.includes('src="/app.js"')) {
  console.error('Dashboard does not reference public/app.js.');
  process.exit(1);
}

const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (!jsonLdMatch) {
  console.error('Dashboard is missing JSON-LD.');
  process.exit(1);
}

try {
  JSON.parse(jsonLdMatch[1]);
} catch (error) {
  console.error(`Dashboard JSON-LD is invalid: ${error.message}`);
  process.exit(1);
}

for (const id of ['runtime-state', 'snapshot-meta', 'sites-title', 'site-list-meta', 'table-body', 'app-version']) {
  if (!html.includes(`id="${id}"`)) {
    console.error(`Dashboard is missing required element #${id}.`);
    process.exit(1);
  }
}

if (!fs.existsSync('src/tailwind.css')) {
  console.error('Missing Tailwind source stylesheet: src/tailwind.css');
  process.exit(1);
}

const builtCss = fs.existsSync('public/styles.css') ? fs.statSync('public/styles.css').size : 0;
if (builtCss < 500) {
  console.error('Compiled Tailwind stylesheet is missing or unexpectedly small. Run npm run build:css.');
  process.exit(1);
}

console.log(
  `Checks passed (${serverFiles.length} server files + dashboard client + markup/JSON-LD + Tailwind build).`
);
