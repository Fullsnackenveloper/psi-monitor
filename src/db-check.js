const db = require('./db');

console.log('Seeded this run:', db.seedSitesIfEmpty());
console.log('Active sites:', db.getActiveSites());
console.log('Current data:', db.getCurrentData());
console.log('History:', db.getHistoryData());