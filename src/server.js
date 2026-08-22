const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const routes = require('./routes');
const { startScheduler } = require('./scheduler');

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

// API + health routes
app.use(routes);

// Dashboard — static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Startup
if (db.seedSitesIfEmpty()) {
  console.log('Seeded demo sites (database was empty)');
}

app.listen(config.port, () => {
  console.log(`Performance Monitor listening on http://localhost:${config.port}`);
  startScheduler();
});
