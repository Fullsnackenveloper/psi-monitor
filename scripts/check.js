const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const files = [
  'src/server.js',
  'src/routes.js',
  'src/db.js',
  'src/scanner.js',
  'src/scheduler.js',
  'src/config.js',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const html = fs.readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/type=["']application\/ld\+json["']/i.test(m[1]))
  .map((m) => m[2]);

if (!scripts.length) {
  console.error('No dashboard JavaScript found in public/index.html');
  process.exit(1);
}

const tempFile = path.join(os.tmpdir(), `psi-monitor-client-${process.pid}.js`);
fs.writeFileSync(tempFile, scripts.join('\n'));
const clientResult = spawnSync(process.execPath, ['--check', tempFile], { stdio: 'inherit' });
fs.rmSync(tempFile, { force: true });
if (clientResult.status !== 0) process.exit(clientResult.status || 1);

if (!html.includes('href="/styles.css"')) {
  console.error('Dashboard does not reference the compiled Tailwind stylesheet.');
  process.exit(1);
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

console.log(`Checks passed (${files.length} server files + dashboard client + Tailwind build).`);
