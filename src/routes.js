const express = require('express');
const config = require('./config');
const db = require('./db');
const { version } = require('../package.json');

const router = express.Router();

router.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function statusOf(score, error) {
  if (error) return 'ERROR';
  if (score === null || score === undefined) return 'PENDING';
  return score < config.threshold ? 'ALERT' : 'OK';
}

router.get('/api/data', (req, res) => {
  const latestScan = db.getLatestCompletedScan();
  const rows = db.getCurrentData(latestScan?.id).map((r) => ({
    id: r.id,
    url: r.url,
    label: r.label,
    mobile: r.mobile,
    desktop: r.desktop,
    mobileStatus: statusOf(r.mobile, r.mobileError),
    desktopStatus: statusOf(r.desktop, r.desktopError),
    mobileError: r.mobileError,
    desktopError: r.desktopError,
    mobileCheckedAt: r.mobileCheckedAt,
    desktopCheckedAt: r.desktopCheckedAt,
    lastChecked: [r.mobileCheckedAt, r.desktopCheckedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  }));

  res.json({
    version,
    threshold: config.threshold,
    scanCron: config.scanCron,
    latestScan,
    sites: rows,
  });
});

router.get('/api/history', (req, res) => {
  res.json(db.getHistoryData());
});

router.get('/api/sites/:id/history', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'invalid site id' });
  }

  res.json(db.getSiteHistory(id, 80));
});

router.get('/healthz', (req, res) => {
  const latestScan = db.getLatestCompletedScan();
  res.json({
    ok: true,
    version,
    uptime: Math.round(process.uptime()),
    lastCompletedScanAt: latestScan?.finishedAt || null,
  });
});

module.exports = router;
