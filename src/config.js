const path = require('node:path');

// Load .env if present (local dev). In Docker, env vars come from the
// environment directly, so a missing .env file is fine.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — use real environment variables */
}

module.exports = {
  apiKey: process.env.PSI_API_KEY || '',
  port: Number(process.env.PORT) || 3000,
  threshold: Number(process.env.SCORE_THRESHOLD) || 70,
  scanCron: process.env.SCAN_CRON || '0 */6 * * *',
  dbPath: process.env.DB_PATH || './data/psi.db',
};