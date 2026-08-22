const config = require('./config');
const db = require('./db');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;
const CONCURRENCY = 1; // sites scanned in parallel

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res) {
  const value = res.headers.get('retry-after');
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function fetchPSI(url, strategy) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', strategy);
  endpoint.searchParams.set('category', 'performance');
  if (config.apiKey) endpoint.searchParams.set('key', config.apiKey);

  let res;
  try {
    res = await fetch(endpoint, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      score: null,
      error: timedOut ? 'REQUEST_TIMEOUT' : `FETCH_FAILED: ${error.message}`,
      retryable: true,
      retryAfterMs: null,
    };
  }

  if (res.status === 429) {
    return {
      score: null,
      error: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: retryAfterMs(res),
    };
  }

  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
    return {
      score: null,
      error: `HTTP_${res.status}${body ? `: ${body}` : ''}`,
      retryable: res.status >= 500,
      retryAfterMs: null,
    };
  }

  const json = await res.json();
  const raw = json?.lighthouseResult?.categories?.performance?.score;

  if (raw === undefined || raw === null) {
    return {
      score: null,
      error: 'NO_SCORE_IN_RESPONSE',
      retryable: false,
      retryAfterMs: null,
    };
  }

  return {
    score: Math.round(raw * 100),
    error: null,
    retryable: false,
    retryAfterMs: null,
  };
}

async function fetchPSIWithRetry(url, strategy) {
  let delay = RETRY_DELAY_MS;
  let last = { score: null, error: 'UNKNOWN', retryable: true, retryAfterMs: null };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    last = await fetchPSI(url, strategy);

    if (last.score !== null) {
      if (attempt > 1) {
        console.log(`  ✓ ${url} [${strategy}] succeeded on attempt ${attempt}`);
      }
      return last;
    }

    if (!last.retryable || attempt === MAX_RETRIES) break;

    const waitMs = Math.max(delay, last.retryAfterMs || 0);
    console.log(
      `  ↻ ${url} [${strategy}] attempt ${attempt} failed (${last.error}). ` +
      `Retrying in ${waitMs}ms`
    );
    await sleep(waitMs);
    delay *= 2;
  }

  console.log(`  ✗ ${url} [${strategy}] failed: ${last.error}`);
  return last;
}

async function checkSite(site, scanId) {
  console.log(`Checking ${site.url}`);
  let hadError = false;

  for (const strategy of ['mobile', 'desktop']) {
    const { score, error } = await fetchPSIWithRetry(site.url, strategy);
    db.insertCheck({
      siteId: site.id,
      scanId,
      strategy,
      score,
      errorMessage: error,
    });

    if (score === null) hadError = true;

    // Gentle pacing to stay comfortably below PSI request-rate limits.
    await sleep(1500);
  }

  return hadError;
}

async function runScan() {
  const sites = db.getActiveSites();
  if (sites.length === 0) {
    console.log('No active sites to scan.');
    return;
  }

  const scanId = db.createScan();
  const startedAt = Date.now();
  console.log(`Scan #${scanId} started — ${sites.length} sites, concurrency ${CONCURRENCY}`);

  let errorCount = 0;
  let sitesChecked = 0;
  const queue = [...sites];

  async function worker() {
    while (queue.length > 0) {
      const site = queue.shift();
      if (!site) continue;

      try {
        const hadError = await checkSite(site, scanId);
        if (hadError) errorCount++;
      } catch (error) {
        errorCount++;
        console.error(`  ✗ ${site.url} scan failed unexpectedly:`, error);
      } finally {
        sitesChecked++;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    db.finishScan(scanId, sitesChecked, errorCount);
  }

  console.log(
    `Scan #${scanId} finished in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
    `${sitesChecked} sites, ${errorCount} with errors`
  );
}

if (require.main === module) {
  runScan()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Scan failed:', error);
      process.exit(1);
    });
}

module.exports = { runScan };
