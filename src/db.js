const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Make sure the data directory exists before SQLite opens the file
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL UNIQUE,
    label      TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT,
    sites_checked INTEGER NOT NULL DEFAULT 0,
    error_count   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS checks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       INTEGER NOT NULL REFERENCES sites(id),
    scan_id       INTEGER NOT NULL REFERENCES scans(id),
    strategy      TEXT NOT NULL CHECK (strategy IN ('mobile','desktop')),
    score         INTEGER,
    error_message TEXT,
    checked_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_checks_site ON checks(site_id, checked_at);
  CREATE INDEX IF NOT EXISTS idx_checks_scan ON checks(scan_id);
`);

// ── Seeding ───────────────────────────────────────────────────────
function seedSitesIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM sites').get();
  if (n > 0) return false;

  const seedPath = path.join(__dirname, '..', 'config', 'sites.seed.json');
  if (!fs.existsSync(seedPath)) return false;

  const sites = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const insert = db.prepare('INSERT OR IGNORE INTO sites (url, label) VALUES (?, ?)');
  for (const s of sites) insert.run(s.url, s.label ?? null);
  return true;
}

// ── Writes (used by the scanner) ──────────────────────────────────
function createScan() {
  const r = db.prepare('INSERT INTO scans DEFAULT VALUES').run();
  return Number(r.lastInsertRowid);
}

function finishScan(scanId, sitesChecked, errorCount) {
  db.prepare(
    `UPDATE scans SET finished_at = datetime('now'),
     sites_checked = ?, error_count = ? WHERE id = ?`
  ).run(sitesChecked, errorCount, scanId);
}

function insertCheck({ siteId, scanId, strategy, score, errorMessage }) {
  db.prepare(
    `INSERT INTO checks (site_id, scan_id, strategy, score, error_message)
     VALUES (?, ?, ?, ?, ?)`
  ).run(siteId, scanId, strategy, score ?? null, errorMessage ?? null);
}

// ── Reads (used by the API) ───────────────────────────────────────
function getActiveSites() {
  return db.prepare('SELECT * FROM sites WHERE active = 1 ORDER BY id').all();
}

// Latest mobile + desktop check per site — the dashboard's main table
function getCurrentData() {
  return db.prepare(`
    SELECT
      s.id, s.url, s.label,
      cm.score AS mobile,  cm.error_message AS mobileError,  cm.checked_at AS mobileCheckedAt,
      cd.score AS desktop, cd.error_message AS desktopError, cd.checked_at AS desktopCheckedAt
    FROM sites s
    LEFT JOIN checks cm ON cm.id = (
      SELECT id FROM checks
      WHERE site_id = s.id AND strategy = 'mobile'
      ORDER BY checked_at DESC, id DESC LIMIT 1
    )
    LEFT JOIN checks cd ON cd.id = (
      SELECT id FROM checks
      WHERE site_id = s.id AND strategy = 'desktop'
      ORDER BY checked_at DESC, id DESC LIMIT 1
    )
    WHERE s.active = 1
    ORDER BY s.id
  `).all();
}

// Per-scan averages — the trend chart
function getHistoryData() {
  return db.prepare(`
    SELECT
      sc.id, sc.started_at AS startedAt, sc.finished_at AS finishedAt,
      sc.sites_checked AS sitesChecked, sc.error_count AS errorCount,
      CAST(ROUND(AVG(CASE WHEN c.strategy = 'mobile'  THEN c.score END)) AS INTEGER) AS avgMobile,
      CAST(ROUND(AVG(CASE WHEN c.strategy = 'desktop' THEN c.score END)) AS INTEGER) AS avgDesktop
    FROM scans sc
    JOIN checks c ON c.scan_id = sc.id
    WHERE c.score IS NOT NULL AND sc.finished_at IS NOT NULL
    GROUP BY sc.id
    ORDER BY sc.started_at
  `).all();
}

// Full score history for one site — new capability the Sheet couldn't do
function getSiteHistory(siteId) {
  return db.prepare(`
    SELECT scan_id AS scanId, strategy, score, error_message AS errorMessage, checked_at AS checkedAt
    FROM checks WHERE site_id = ? ORDER BY checked_at, id
  `).all(siteId);
}

module.exports = {
  seedSitesIfEmpty, createScan, finishScan, insertCheck,
  getActiveSites, getCurrentData, getHistoryData, getSiteHistory,
};