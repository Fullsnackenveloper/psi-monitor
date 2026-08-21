# PSI Monitor

A self-hosted uptime-style monitor for web performance. It scans a list of sites against the Google PageSpeed Insights API on a schedule, stores every measurement, and serves a live dashboard with current scores, alert states, and a score-trend chart.

Live demo: **https://psi.msschermer.us**

Built with Node.js, Express, and SQLite. Containerized with Docker, built and published by GitHub Actions, and deployed behind Caddy with automatic HTTPS.

---

## Why this exists

This started as an internal tool I built in Google Apps Script to watch page-speed scores across a set of client sites and alert when any dropped below a threshold. It worked, but it was welded to Google's platform: a Spreadsheet as the database, time-based triggers as the scheduler, `MailApp` for alerts, and `HtmlService` for the UI. None of that runs anywhere except inside Google.

I rebuilt it from scratch as a standalone service so it could run on any server, be version-controlled, and deploy through a real pipeline. The scan logic and the dashboard carried over; everything underneath was replaced. The result is a small, dependency-light app that demonstrates the full path from code to a live, HTTPS-served, continuously-deployed service.

---

## What it does

- Scans each configured site for both **mobile** and **desktop** performance scores.
- Stores **every** measurement, so history is real data rather than a running average.
- Serves a dashboard with a sortable, filterable table, summary stats, configurable trend ranges, and a score-trend chart.
- Opens an on-demand per-site history view from any dashboard row, including current scores and change from the prior measurement.
- Flags any site scoring below a configurable threshold as an **alert**, and surfaces the reason when a scan fails.
- Runs scans automatically on a cron schedule, unattended.
- Reports its own health at `/healthz` for the container runtime and reverse proxy.

---

## Architecture

```
                       GitHub Actions (build + push image)
                                     |
                                     v
   Browser  --HTTPS-->  Caddy  -->  psi-monitor container  -->  PageSpeed Insights API
                       (reverse       |            ^
                        proxy,        |            |
                        auto-TLS)     v            |
                                   SQLite      node-cron
                                  (volume)    (scheduler)
```

Two repositories, by design:

- **psi-monitor** (this repo) | the application. It *builds an image*.
- **portfolio-infra** | the deployment config (Docker Compose + Caddy). It *runs images*. Its compose file references this app's published image by tag; it contains no application code.

That split keeps "build the thing" separate from "run the things," which is why a change here flows out as: push to `main` → GitHub Actions builds and publishes the image → the server pulls it.

---

## Tech choices

**Node.js + Express.** The original logic was already JavaScript, so the port kept the fetch/retry/scoring code largely intact. Express serves both the static dashboard and the JSON API.

**SQLite via Node's built-in `node:sqlite`.** SQLite fits this workload exactly, a single small app with modest, periodic writes, and it needs no separate database container. Using Node's built-in driver means the data layer has **zero third-party dependencies** and no native compilation step. The whole app depends on just two packages: `express` and `node-cron`.

**node-cron** replaces the platform's time-based triggers, with a guard so scans can't overlap.

**Caddy** (in the infra repo) terminates TLS and reverse-proxies to the container, fetching and renewing Let's Encrypt certificates automatically.

---

## Data model

Three tables, and the important decision is that measurements are **append-only**:

- `sites` — the list of URLs to monitor.
- `scans` — one row per scan cycle, with timing and error counts.
- `checks` — one row per individual measurement (a given site + strategy at a point in time). Never overwritten.

The original stored one row per site and overwrote it each scan, plus a separate tab of averages, which threw away the underlying data. Here, every check is preserved. The dashboard's "current" view is just *each site's latest check* (a query), the trend chart's averages are *computed from the stored checks* (a query), and per-site history over time is available because the data was never discarded.

The alert **threshold is not stored in the database.** It lives in configuration and is applied at read time. Storing an `ALERT`/`OK` label would freeze one day's threshold into historical rows; keeping only the raw facts (score, or the error) means changing the threshold reinterprets all history correctly and never requires a data migration.

---

## Improvements over the original

This was a rebuild, not a copy, and the QA process at each phase surfaced things worth fixing:

- **Append-only history** instead of overwrite-in-place, so trends and per-site history are real.
- **Errors are stored, not just logged.** A failed check records *why* it failed, and the dashboard shows the reason on hover.
- **A distinct `PENDING` state** for never-scanned sites, so a fresh deploy doesn't misreport unscanned sites as errors.
- **Threshold moved to config**, applied at read time — no hardcoded values, no threshold baked into stored data.
- **Secrets externalized** to environment variables; nothing sensitive is committed or baked into the image.
- **A `/healthz` endpoint**, wired into the container's `HEALTHCHECK` so the runtime reports the app as healthy or not.
- **Rate-limit-aware pacing.** Scans run serially with spacing between calls to stay under the API's per-minute limits, with exponential-backoff retries on transient failures.
- **The batching workaround is gone.** The original processed a few URLs per run to dodge Apps Script's 6-minute execution cap; a real server has no such limit, so a single scan handles the whole list.
- **Dependency-light and container-native**, with a multi-stage Docker build and a non-root runtime user.

---

## Configuration

All settings come from environment variables. A committed `.env.example` documents them; the real `.env` is never committed.

| Variable | Purpose | Default |
|---|---|---|
| `PSI_API_KEY` | Google PageSpeed Insights API key | *(none)* |
| `PORT` | Port the server listens on | `3000` |
| `SCORE_THRESHOLD` | Scores below this are flagged as alerts | `70` |
| `SCAN_CRON` | Cron expression for scheduled scans | `0 */6 * * *` |
| `DB_PATH` | Path to the SQLite database file | `./data/psi.db` |

The list of sites to monitor is seeded from `config/sites.seed.json` on first run, when the database is empty, so the dashboard has data to show immediately.

---

## Running it locally

Requires Node.js 24+ (for the built-in SQLite support).

```bash
npm install
cp .env.example .env      # then add your API key
npm start                 # starts the server + scheduler
npm run dev               # local server with automatic restarts
npm test                  # quick pre-push syntax check
npm run scan              # trigger a scan manually
```

Then open `http://localhost:3000`.

## Running it with Docker

```bash
docker build -t psi-monitor .
docker run -d \
  --name psi-monitor \
  --env-file .env \
  -p 3000:3000 \
  -v psi_data:/app/data \
  psi-monitor
```

The SQLite file lives on a named volume, so data survives container replacement.

---

## Deployment

Pushing to `main` triggers a GitHub Actions workflow that builds the image and publishes it to the GitHub Container Registry, tagged `latest` and with the commit SHA. The server then pulls the new image and recreates the container. The database persists across deploys on its volume; TLS is handled by Caddy in front.

---

## Project layout

```
src/
  config.js      # reads and validates environment configuration
  db.js          # SQLite schema, seeding, and queries
  scanner.js     # PageSpeed fetch, retry/backoff, scan loop
  scheduler.js   # node-cron wiring with an overlap guard
  routes.js      # /api/data, /api/history, /api/sites/:id/history, /healthz
  server.js      # Express entry point
public/          # dashboard (HTML, CSS, client JS)
config/
  sites.seed.json  # sites loaded on first run
Dockerfile
.github/workflows/build.yml
```

---

## Notes

A key that authorizes the PageSpeed Insights API is required. The API is free within a generous daily quota; scanning a handful of sites a few times a day stays comfortably inside it. The app treats API failures as data, recording them and moving on, rather than letting one bad response stop a scan.