const express = require('express');
const config = require('./config');
const db = require('./db');

const router = express.Router();

// Compute alert status at read time — threshold lives in config, not in data
function statusOf(score, error) {
  if (error) return 'ERROR';
  if (score === null || score === undefined) return 'PENDING';
  return score < config.threshold ? 'ALERT' : 'OK';
}

// Main dashboard data — replaces getDataForDashboard()
router.get('/api/data', (req, res) => {
  const rows = db.getCurrentData().map((r) => ({
    id: r.id,
    url: r.url,
    label: r.label,
    mobile: r.mobile,
    desktop: r.desktop,
    mobileStatus: statusOf(r.mobile, r.mobileError),
    desktopStatus: statusOf(r.desktop, r.desktopError),
    mobileError: r.mobileError,
    desktopError: r.desktopError,
    lastChecked: [r.mobileCheckedAt, r.desktopCheckedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  }));
  res.json({ threshold: config.threshold, scanCron: config.scanCron, sites: rows });
});

// Trend history — replaces getHistoryData()
router.get('/api/history', (req, res) => {
  res.json(db.getHistoryData());
});

// Per-site full history — the new capability
router.get('/api/sites/:id/history', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid site id' });
  }
  res.json(db.getSiteHistory(id));
});

// Health check — for Docker, Caddy, and humans
router.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

module.exports = router;