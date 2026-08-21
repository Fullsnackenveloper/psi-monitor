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

// The dashboard is intentionally dependency-free and keeps its JS inline.
// Extract it so npm test catches client-side syntax errors before a push too.
const html = fs.readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (!scripts.length) {
  console.error('No dashboard script found in public/index.html');
  process.exit(1);
}
const tempFile = path.join(os.tmpdir(), `psi-monitor-client-${process.pid}.js`);
fs.writeFileSync(tempFile, scripts.join('\n'));
const clientResult = spawnSync(process.execPath, ['--check', tempFile], { stdio: 'inherit' });
fs.rmSync(tempFile, { force: true });
if (clientResult.status !== 0) process.exit(clientResult.status || 1);

console.log(`Syntax check passed (${files.length} server files + dashboard client).`);
