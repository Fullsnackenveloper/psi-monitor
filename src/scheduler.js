const cron = require('node-cron');
const config = require('./config');
const { runScan } = require('./scanner');

let scanInProgress = false;

function startScheduler() {
  if (!cron.validate(config.scanCron)) {
    console.error(`Invalid SCAN_CRON expression: "${config.scanCron}" — scheduler not started`);
    return;
  }

  cron.schedule(config.scanCron, async () => {
    if (scanInProgress) {
      console.log('Scheduled scan skipped — previous scan still running');
      return;
    }
    scanInProgress = true;
    try {
      await runScan();
    } catch (e) {
      console.error('Scheduled scan failed:', e);
    } finally {
      scanInProgress = false;
    }
  });

  console.log(`Scheduler started — cron "${config.scanCron}"`);
}

module.exports = { startScheduler };