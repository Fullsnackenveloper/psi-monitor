const config = require('./config');
const db = require('./db');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CONCURRENCY = 1; // sites scanned in parallel

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Single PSI call ───────────────────────────────────────────────
async function fetchPSI(url, strategy) {
  const endpoint =
    'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
    `?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${config.apiKey}`;

  const res = await fetch(endpoint);

  if (res.status === 429) {
    return { score: null, error: 'RATE_LIMITED' };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { score: null, error: `HTTP_${res.status}: ${body}` };
  }

  const json = await res.json();
  const raw = json?.lighthouseResult?.categories?.performance?.score;
  if (raw === undefined || raw === null) {
    return { score: null, error: 'NO_SCORE_IN_RESPONSE' };
  }
  return { score: Math.round(raw * 100), error: null };
}

// ── Retry wrapper — your original exponential backoff, ported ─────
async function fetchPSIWithRetry(url, strategy) {
  let delay = RETRY_DELAY_MS;
  let last = { score: null, error: 'UNKNOWN' };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      last = await fetchPSI(url, strategy);
    } catch (e) {
      last = { score: null, error: `FETCH_FAILED: ${e.message}` };
    }

    if (last.score !== null) {
      if (attempt > 1) console.log(`  ✓ ${url} [${strategy}] succeeded on attempt ${attempt}`);
      return last;
    }

    if (attempt < MAX_RETRIES) {
      console.log(`  ↻ ${url} [${strategy}] attempt ${attempt} failed (${last.error}). Retrying in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }

  console.log(`  ✗ ${url} [${strategy}] failed after ${MAX_RETRIES} attempts: ${last.error}`);
  return last;
}

// ── Scan one site (mobile + desktop) ──────────────────────────────
async function checkSite(site, scanId) {
  console.log(`Checking ${site.url}`);
  let hadError = false;

  for (const strategy of ['mobile', 'desktop']) {
    const { score, error } = await fetchPSIWithRetry(site.url, strategy);
    db.insertCheck({ siteId: site.id, scanId, strategy, score, errorMessage: error });
    if (score === null) hadError = true;
    await sleep(1500); // gentle pacing to stay under PSI's rate limit
  }
  return hadError;
}

// ── Full scan with a simple concurrency pool ──────────────────────
async function runScan() {
  const sites = db.getActiveSites();
  if (sites.length === 0) {
    console.log('No active sites to scan.');
    return;
  }

  const scanId = db.createScan();
  console.log(`Scan #${scanId} started — ${sites.length} sites, concurrency ${CONCURRENCY}`);
  const t0 = Date.now();

  let errorCount = 0;
  const queue = [...sites];

  async function worker() {
    while (queue.length > 0) {
      const site = queue.shift();
      const hadError = await checkSite(site, scanId);
      if (hadError) errorCount++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  db.finishScan(scanId, sites.length, errorCount);
  console.log(
    `Scan #${scanId} finished in ${Math.round((Date.now() - t0) / 1000)}s — ` +
    `${sites.length} sites, ${errorCount} with errors`
  );
}

// Run directly (npm run scan) vs. required by the scheduler
if (require.main === module) {
  runScan()
    .then(() => process.exit(0))
    .catch((e) => { console.error('Scan failed:', e); process.exit(1); });
}

module.exports = { runScan };