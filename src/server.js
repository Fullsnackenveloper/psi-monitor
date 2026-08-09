const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const routes = require('./routes');
const { startScheduler } = require('./scheduler');

const app = express();

// API + health routes
app.use(routes);

// Dashboard — static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Startup
if (db.seedSitesIfEmpty()) {
  console.log('Seeded demo sites (database was empty)');
}

app.listen(config.port, () => {
  console.log(`PSI Monitor listening on http://localhost:${config.port}`);
  startScheduler();
});