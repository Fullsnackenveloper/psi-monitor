const path = require('node:path');

// Load .env if present (local dev). In Docker, environment variables are
// injected directly, so a missing .env file is expected.
try {
  process.loadEnvFile();
} catch {
  /* no local .env file */
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

module.exports = {
  apiKey: process.env.PSI_API_KEY || '',
  port: boundedNumber(process.env.PORT, 3000, 1, 65535),
  threshold: boundedNumber(process.env.SCORE_THRESHOLD, 70, 0, 100),
  scanCron: process.env.SCAN_CRON || '0 */6 * * *',
  dbPath: path.resolve(process.env.DB_PATH || './data/psi.db'),
};
