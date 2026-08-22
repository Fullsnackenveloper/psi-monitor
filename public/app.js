let ALL = [], filtered = [], THRESHOLD = 70, LATEST_SCAN = null, SCAN_CRON = '';
let sortKey = 'mobile', sortDir = 1, selectedSiteId = null;
const PAGE_SIZE = 5;
let visibleSiteCount = PAGE_SIZE;
const SITE_HISTORY_CACHE = new Map();
const mobileListQuery = window.matchMedia('(max-width: 620px)');
const compactLayoutQuery = window.matchMedia('(max-width: 820px)');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseUtc(v) {
  if (!v) return null;
  const normalized = v.includes('T') ? v : v.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(v, includeTime = true) {
  const d = parseUtc(v);
  if (!d) return '—';
  return d.toLocaleString([], includeTime
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' });
}

function relativeTime(v) {
  const d = parseUtc(v);
  if (!d) return 'not scanned';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return hrs + ' hr' + (hrs === 1 ? '' : 's') + ' ago';
  const days = Math.round(hrs / 24);
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}


function siteState(r) {
  if (r.mobileStatus === 'ERROR' || r.desktopStatus === 'ERROR') return 'ERROR';
  if (r.mobileStatus === 'ALERT' || r.desktopStatus === 'ALERT') return 'ALERT';
  if (r.mobileStatus === 'PENDING' || r.desktopStatus === 'PENDING') return 'PENDING';
  return 'OK';
}

function scanIntervalHours(cron) {
  if (cron === '0 * * * *') return 1;
  if (cron === '0 0 * * *') return 24;
  const everyHours = /^0 \*\/(\d+) \* \* \*$/.exec(cron || '');
  return everyHours ? Number(everyHours[1]) : null;
}

function snapshotIsStale(scan, cron) {
  const finished = parseUtc(scan?.finishedAt);
  const intervalHours = scanIntervalHours(cron);
  if (!finished || !intervalHours) return false;
  return Date.now() - finished.getTime() > intervalHours * 2.25 * 60 * 60 * 1000;
}

function friendlyError(error) {
  if (!error) return 'Check failed';
  if (error === 'RATE_LIMITED') return 'PageSpeed API rate limit reached';
  if (error === 'REQUEST_TIMEOUT') return 'PageSpeed request timed out';
  if (error === 'NO_SCORE_IN_RESPONSE') return 'PageSpeed returned no performance score';
  if (error.startsWith('FETCH_FAILED')) return 'Network request failed';
  const http = /^HTTP_(\d{3})/.exec(error);
  if (http) return `PageSpeed API returned HTTP ${http[1]}`;
  return 'PageSpeed check failed';
}


function scoreClass(s) {
  if (typeof s !== 'number') return 'text-app-text-faint';
  if (s >= THRESHOLD) return 'text-good';
  if (s >= THRESHOLD - 20) return 'text-warn';
  return 'text-bad';
}

function statusRank(r) {
  const state = siteState(r);
  return { ERROR: 0, ALERT: 1, OK: 2, PENDING: 3 }[state] ?? 4;
}

function badge(r) {
  const base = 'inline-flex items-center rounded-full border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em]';
  const state = siteState(r);

  if (state === 'ERROR') {
    const error = r.mobileError || r.desktopError || 'Unknown error';
    return `<span class="${base} border-warn-border bg-warn-soft text-warn" title="${esc(error)}">Error</span>`;
  }
  if (state === 'ALERT') {
    return `<span class="${base} border-bad-border bg-bad-soft text-bad">Alert</span>`;
  }
  if (state === 'PENDING') {
    return `<span class="${base} border-pending-border bg-pending-soft text-pending">Pending</span>`;
  }
  return `<span class="${base} border-good-border bg-good-soft text-good">OK</span>`;
}

function updateSummary() {
  const alerts = ALL.filter(r => siteState(r) === 'ALERT').length;
  const errors = ALL.filter(r => siteState(r) === 'ERROR').length;
  const pending = ALL.filter(r => siteState(r) === 'PENDING').length;

  const state = document.getElementById('runtime-state');
  const dot = document.getElementById('snapshot-dot');
  const meta = document.getElementById('snapshot-meta');
  const stale = snapshotIsStale(LATEST_SCAN, SCAN_CRON);

  dot.className = 'h-2 w-2 shrink-0 rounded-full';
  state.className = 'font-medium';

  const secondary = [];
  if (LATEST_SCAN?.finishedAt) secondary.push(`Last scan ${relativeTime(LATEST_SCAN.finishedAt)}`);
  else secondary.push('No completed scan yet');
  if (alerts) secondary.push(`${alerts} below target`);
  if (errors) secondary.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (pending) secondary.push(`${pending} pending`);
  meta.textContent = secondary.join(' · ');

  if (!LATEST_SCAN) {
    state.textContent = 'Awaiting first scan';
    state.classList.add('text-pending');
    dot.classList.add('bg-pending-dot');
  } else if (stale) {
    state.textContent = 'Data is stale';
    state.classList.add('text-warn');
    dot.classList.add('bg-warn-dot');
  } else if (errors) {
    state.textContent = `${errors} scan issue${errors === 1 ? '' : 's'}`;
    state.classList.add('text-warn');
    dot.classList.add('bg-warn-dot');
  } else if (alerts) {
    state.textContent = `${alerts} site${alerts === 1 ? '' : 's'} below target`;
    state.classList.add('text-bad');
    dot.classList.add('bg-bad-dot');
  } else if (pending) {
    state.textContent = `${pending} site${pending === 1 ? '' : 's'} pending`;
    state.classList.add('text-pending');
    dot.classList.add('bg-pending-dot');
  } else {
    state.textContent = 'All sites within target';
    state.classList.add('text-good');
    dot.classList.add('bg-good-dot');
  }
}

function sortBy(key) {
  if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = 1; }

  document.querySelectorAll('.sort-arrow').forEach(el => {
    el.textContent = '';
    el.classList.remove('text-accent');
    el.classList.add('text-app-text-faint');
  });
  document.querySelectorAll('th.sortable').forEach(el => el.setAttribute('aria-sort', 'none'));

  const arr = document.getElementById('arr-' + key);
  if (arr) {
    arr.textContent = sortDir === 1 ? '▲' : '▼';
    arr.classList.remove('text-app-text-faint');
    arr.classList.add('text-accent');
  }

  const header = document.querySelector(`th.sortable[data-sort="${key}"]`);
  if (header) header.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
  renderTable();
}

function sortKeydown(event, key) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    sortBy(key);
  }
}

function applyFilters() {
  visibleSiteCount = PAGE_SIZE;
  const q = document.getElementById('search').value.trim().toLowerCase();
  const sf = document.getElementById('status-filter').value;

  filtered = ALL.filter(r => {
    if (q && !(`${r.url} ${r.label || ''}`.toLowerCase().includes(q))) return false;
    const state = siteState(r);

    if (sf === 'alert' && state !== 'ALERT') return false;
    if (sf === 'ok' && state !== 'OK') return false;
    if (sf === 'error' && state !== 'ERROR') return false;
    if (sf === 'pending' && state !== 'PENDING') return false;
    return true;
  });

  if (selectedSiteId && !filtered.some(r => r.id === selectedSiteId)) {
    selectedSiteId = null;
  }

  if (mobileListQuery.matches && selectedSiteId) {
    const selectedIndex = filtered.findIndex(r => r.id === selectedSiteId);
    if (selectedIndex >= 0) visibleSiteCount = Math.max(PAGE_SIZE, selectedIndex + 1);
  }

  document.getElementById('clear-btn').hidden = !q && sf === 'all';
  renderTable();
}

function clearFilters() {
  document.getElementById('search').value = '';
  document.getElementById('status-filter').value = 'all';
  applyFilters();
}

function deltaMarkup(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return '<span class="text-app-text-faint">—</span>';
  const d = current - previous;
  if (d === 0) return '<span class="text-app-text-faint">0</span>';
  return `<span class="${d > 0 ? 'text-good' : 'text-bad'}">${d > 0 ? '+' : ''}${d}</span>`;
}

function buildHistoryWindow(history) {
  const sortedHistory = [...history].sort((a, b) => {
    const at = parseUtc(a.checkedAt)?.getTime() ?? 0;
    const bt = parseUtc(b.checkedAt)?.getTime() ?? 0;
    return at - bt;
  });

  const groups = [];
  const byScanId = new Map();
  const LEGACY_PAIR_WINDOW_MS = 15 * 60 * 1000;

  for (const check of sortedHistory) {
    const checkedMs = parseUtc(check.checkedAt)?.getTime() ?? 0;
    let point = null;

    if (check.scanId != null) {
      if (!byScanId.has(check.scanId)) {
        point = {
          scanId: check.scanId,
          checkedAt: check.checkedAt,
          checkedMs,
          mobile: null,
          desktop: null,
          mobileError: null,
          desktopError: null
        };
        byScanId.set(check.scanId, point);
        groups.push(point);
      } else {
        point = byScanId.get(check.scanId);
      }
    } else {
      const previous = groups.at(-1);
      const canPairWithPrevious =
        previous &&
        previous.scanId == null &&
        Math.abs(checkedMs - previous.checkedMs) <= LEGACY_PAIR_WINDOW_MS &&
        previous[check.strategy] == null &&
        previous[`${check.strategy}Error`] == null;

      if (canPairWithPrevious) {
        point = previous;
      } else {
        point = {
          scanId: null,
          checkedAt: check.checkedAt,
          checkedMs,
          mobile: null,
          desktop: null,
          mobileError: null,
          desktopError: null
        };
        groups.push(point);
      }
    }

    if (checkedMs && (!point.checkedMs || checkedMs < point.checkedMs)) {
      point.checkedMs = checkedMs;
      point.checkedAt = check.checkedAt;
    }

    if (check.strategy === 'mobile') {
      point.mobile = Number.isFinite(check.score) ? check.score : null;
      point.mobileError = check.errorMessage || null;
    }

    if (check.strategy === 'desktop') {
      point.desktop = Number.isFinite(check.score) ? check.score : null;
      point.desktopError = check.errorMessage || null;
    }
  }

  const allScans = groups.sort((a, b) => a.checkedMs - b.checkedMs);
  if (!allScans.length) {
    return {
      scans: [],
      scanIssueCount: 0,
      hasScanIssues: false,
      rangeLabel: 'Recent history'
    };
  }

  const latestMs = allScans.at(-1).checkedMs;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  let scans = allScans.filter(scan => latestMs - scan.checkedMs <= SEVEN_DAYS_MS);
  let rangeLabel = '7-day history';

  // Sparse older data can still render a useful trend, but don't call it a
  // seven-day view if we had to reach further back to get enough points.
  if (scans.length < 2) {
    scans = allScans.slice(-30);
    rangeLabel = 'Recent history';
  } else {
    scans = scans.slice(-30);
  }

  // One scheduled cycle = one issue marker/count, even when both strategies fail.
  const scanIssueCount = scans.filter(scan => scan.mobileError || scan.desktopError).length;

  return {
    scans,
    scanIssueCount,
    hasScanIssues: scanIssueCount > 0,
    rangeLabel
  };
}

function renderSiteChart(historyWindow) {
  const scans = historyWindow.scans;
  if (!scans.length) {
    return '<div class="chart-empty">No score history available yet.</div>';
  }

  const successful = scans.flatMap(s => [s.mobile, s.desktop]).filter(Number.isFinite);
  if (scans.length < 2 || successful.length < 2) {
    return '<div class="chart-empty">Not enough successful checks for a site trend yet.</div>';
  }

  const compactChart = compactLayoutQuery.matches;
  const W = compactChart ? 520 : 900;
  const H = compactChart ? 170 : 156;
  const PAD = compactChart
    ? { top: 16, right: 18, bottom: 30, left: 36 }
    : { top: 16, right: 38, bottom: 27, left: 34 };
  const axisFont = compactChart ? 10 : 9;
  const pointRadius = compactChart ? 2.6 : 2.15;
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  // PageSpeed scores have a meaningful fixed 0–100 scale.
  const sy = value => PAD.top + ch - (Math.max(0, Math.min(100, value)) / 100) * ch;

  const firstMs = scans[0].checkedMs;
  const lastMs = scans.at(-1).checkedMs;
  const timeSpan = Math.max(1, lastMs - firstMs);
  const sx = scan => PAD.left + ((scan.checkedMs - firstMs) / timeSpan) * cw;

  // Keep successful measurements visually continuous. Intervals containing an
  // unavailable check are bridged with a faint dashed line.
  const segmentsFor = key => {
    const segments = [];
    let previousSuccess = null;
    let interrupted = false;

    for (const scan of scans) {
      const value = scan[key];
      const failed = Boolean(scan[`${key}Error`]);
      const success = Number.isFinite(value) && !failed;

      if (!success) {
        if (previousSuccess) interrupted = true;
        continue;
      }

      if (previousSuccess) {
        segments.push({
          from: previousSuccess,
          to: scan,
          bridged: interrupted
        });
      }

      previousSuccess = scan;
      interrupted = false;
    }

    return segments;
  };

  const target = Math.max(0, Math.min(100, THRESHOLD));
  const plotBottom = PAD.top + ch;
  const failureY = plotBottom + (compactChart ? 8 : 7);
  const mobileColor = '#2563EB';
  const desktopColor = '#078A57';

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block" role="img" aria-label="${esc(historyWindow.rangeLabel)} PageSpeed score history for the selected site">`;

  [0, 50, 100].forEach(value => {
    svg += `<line x1="${PAD.left}" y1="${sy(value)}" x2="${W - PAD.right}" y2="${sy(value)}" stroke="#E5E7EB" stroke-width="1"/>`;
    svg += `<text x="${PAD.left - 7}" y="${sy(value) + 3}" font-size="${axisFont}" fill="#8B8D98" text-anchor="end" font-family="IBM Plex Mono, monospace">${value}</text>`;
  });

  svg += `<line x1="${PAD.left}" y1="${sy(target)}" x2="${W - PAD.right}" y2="${sy(target)}" stroke="#8B8D98" stroke-width="1" stroke-dasharray="4,3"/>`;
  svg += `<text x="${W - PAD.right}" y="${sy(target) - 6}" font-size="${axisFont}" fill="#6B7280" text-anchor="end" font-family="IBM Plex Mono, monospace">Target ${target}</text>`;

  const renderSegments = (key, color) => {
    segmentsFor(key).forEach(segment => {
      const dash = segment.bridged ? ' stroke-dasharray="4,4" opacity="0.45"' : '';
      svg += `<line x1="${sx(segment.from)}" y1="${sy(segment.from[key])}" x2="${sx(segment.to)}" y2="${sy(segment.to[key])}" stroke="${color}" stroke-width="1.75" stroke-linecap="round"${dash}/>`;
    });
  };

  renderSegments('desktop', desktopColor);
  renderSegments('mobile', mobileColor);

  scans.forEach(scan => {
    if (Number.isFinite(scan.desktop) && !scan.desktopError) {
      svg += `<circle cx="${sx(scan)}" cy="${sy(scan.desktop)}" r="${pointRadius}" fill="${desktopColor}"><title>${esc(fmtDate(scan.checkedAt))} · Desktop ${scan.desktop}</title></circle>`;
    }

    if (Number.isFinite(scan.mobile) && !scan.mobileError) {
      svg += `<circle cx="${sx(scan)}" cy="${sy(scan.mobile)}" r="${pointRadius}" fill="${mobileColor}"><title>${esc(fmtDate(scan.checkedAt))} · Mobile ${scan.mobile}</title></circle>`;
    }

    const failures = [
      scan.mobileError ? `Mobile: ${friendlyError(scan.mobileError)}` : null,
      scan.desktopError ? `Desktop: ${friendlyError(scan.desktopError)}` : null
    ].filter(Boolean);

    if (failures.length) {
      const x = sx(scan);
      const half = failures.length > 1 ? 2.8 : 2;
      svg += `<line x1="${x}" y1="${failureY - half}" x2="${x}" y2="${failureY + half}" stroke="#D92D20" stroke-width="1.35" stroke-linecap="round"><title>${esc(fmtDate(scan.checkedAt))} · ${esc(failures.join(' · '))}</title></line>`;
    }
  });

  const firstDate = scans[0]?.checkedAt ? fmtDate(scans[0].checkedAt, false) : '';
  const lastDate = scans.at(-1)?.checkedAt ? fmtDate(scans.at(-1).checkedAt, false) : '';
  svg += `<text x="${PAD.left}" y="${H - 3}" font-size="${axisFont}" fill="#8B8D98" font-family="IBM Plex Mono, monospace">${esc(firstDate)}</text>`;
  svg += `<text x="${W - PAD.right}" y="${H - 3}" font-size="${axisFont}" fill="#8B8D98" text-anchor="end" font-family="IBM Plex Mono, monospace">${esc(lastDate)}</text>`;
  svg += '</svg>';

  return svg;
}

function strategySummary(strategy, site, history) {
  const label = strategy === 'mobile' ? 'Mobile' : 'Desktop';
  const score = site[strategy];
  const status = site[`${strategy}Status`];
  const error = site[`${strategy}Error`];
  const checkedAt = site[`${strategy}CheckedAt`];

  const successful = history.filter(h => h.strategy === strategy && Number.isFinite(h.score));
  const latestSuccessful = successful.at(-1)?.score;
  const previousSuccessful = successful.at(-2)?.score;

  const stateText = status === 'ERROR' ? 'Check failed'
    : status === 'PENDING' ? 'Pending'
    : status === 'ALERT' ? 'Below target'
    : 'Within target';

  const stateColor = status === 'ERROR' ? 'text-warn'
    : status === 'PENDING' ? 'text-pending'
    : status === 'ALERT' ? 'text-bad'
    : 'text-good';

  const dotColor = status === 'ERROR' ? 'bg-warn-dot'
    : status === 'PENDING' ? 'bg-pending-dot'
    : status === 'ALERT' ? 'bg-bad-dot'
    : 'bg-good-dot';

  let primary = '—';
  let secondary = 'Awaiting first successful check';
  let change = '';

  if (status === 'ERROR') {
    secondary = Number.isFinite(latestSuccessful)
      ? `Last successful <strong class="font-mono font-semibold text-app-text">${latestSuccessful}</strong>`
      : 'No successful score recorded';
  } else if (status !== 'PENDING' && Number.isFinite(score)) {
    primary = score;
    secondary = `Target ≥ ${THRESHOLD}`;
    if (Number.isFinite(previousSuccessful)) {
      change = deltaMarkup(score, previousSuccessful);
    }
  }

  const primaryClass = status === 'ERROR' || status === 'PENDING'
    ? 'text-app-text-faint'
    : scoreClass(score);

  const checkedLabel = checkedAt
    ? `${status === 'ERROR' ? 'Failed' : 'Checked'} ${relativeTime(checkedAt)}`
    : 'Not checked';

  return `
    <section class="strategy-summary">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <span class="font-mono text-[8px] font-semibold uppercase tracking-[0.14em] text-app-text-faint">${label}</span>
        <span class="inline-flex min-w-0 items-center gap-1.5 text-[8px] font-medium ${stateColor}">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}" aria-hidden="true"></span>
          <span class="truncate">${stateText}</span>
        </span>
      </div>
      <div class="mt-2 flex items-baseline gap-2">
        <span class="font-mono text-[22px] font-semibold leading-none ${primaryClass}">${primary}</span>
        ${change ? `<span class="strategy-change">${change} <span class="text-app-text-faint">vs previous</span></span>` : ''}
      </div>
      <div class="mt-1.5 text-[9.5px] leading-4 text-app-text-faint">
        <span>${secondary}</span>
        <span class="mx-1 text-app-border-strong" aria-hidden="true">·</span>
        <span class="font-mono">${esc(checkedLabel)}</span>
      </div>
      ${status === 'ERROR' && error ? `<div class="mt-2 truncate border-t border-app-border pt-2 text-[9px] text-warn" title="${esc(error)}">${esc(friendlyError(error))}</div>` : ''}
    </section>`;
}

function detailBodyMarkup(history, site) {
  const historyWindow = buildHistoryWindow(history);

  return `
    <div class="strategy-summary-group">
      ${strategySummary('mobile', site, history)}
      ${strategySummary('desktop', site, history)}
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[9px] text-app-text-faint sm:mt-4 sm:gap-4 sm:text-[10px]" aria-label="Site history chart legend">
      <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-accent"></span>Mobile</span>
      <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-good"></span>Desktop</span>
      ${historyWindow.hasScanIssues ? '<span class="inline-flex items-center gap-1.5"><span class="h-2 w-px rounded-full bg-bad"></span>Scan issue</span>' : ''}
    </div>

    <div class="mt-2 min-h-32 rounded-md border border-app-border bg-app-surface p-1.5 sm:min-h-36 sm:p-3">${renderSiteChart(historyWindow)}</div>
    <p class="mt-2.5 text-[10px] leading-4 text-app-text-faint sm:mt-3 sm:text-[11px] sm:leading-5">
      ${historyWindow.rangeLabel}${historyWindow.hasScanIssues ? ` · ${historyWindow.scanIssueCount} scan issue${historyWindow.scanIssueCount === 1 ? '' : 's'}` : ''}
    </p>`;
}

function detailRowMarkup(site) {
  const history = SITE_HISTORY_CACHE.get(site.id);
  const label = site.label || (() => {
    try { return new URL(site.url).hostname.replace('www.', ''); }
    catch { return site.url; }
  })();

  return `
    <tr class="site-detail-row" id="detail-row-${site.id}">
      <td colspan="5" class="!p-0">
        <div class="detail-reveal overflow-hidden border-b border-app-border bg-app-bg">
          <section aria-label="${esc(label)} performance history">
            <div class="p-3 sm:p-4" id="detail-body-${site.id}">
              ${history ? detailBodyMarkup(history, site) : '<div class="py-8 text-center font-mono text-[10px] text-app-text-faint sm:py-10 sm:text-[11px]">Loading performance history…</div>'}
            </div>
          </section>
        </div>
      </td>
    </tr>`;
}

function rowTone(r) {
  const state = siteState(r);
  if (state === 'ERROR') return 'row-error';
  if (state === 'ALERT') return 'row-alert';
  if (state === 'PENDING') return 'row-pending';
  return 'row-ok';
}

function renderTable() {
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'url') return sortDir * (a.label || a.url).localeCompare(b.label || b.url);
    if (sortKey === 'status') return sortDir * (statusRank(a) - statusRank(b));
    const av = Number.isFinite(a[sortKey]) ? a[sortKey] : 999;
    const bv = Number.isFinite(b[sortKey]) ? b[sortKey] : 999;
    return sortDir * (av - bv);
  });

  const isMobile = mobileListQuery.matches;
  const visible = isMobile ? sorted.slice(0, visibleSiteCount) : sorted;
  const body = document.getElementById('table-body');

  if (!sorted.length) {
    body.innerHTML = '<tr><td colspan="5" class="py-14 text-center text-sm text-app-text-faint">No sites match that filter.</td></tr>';
  } else {
    body.innerHTML = visible.map(r => {
      const host = (() => {
        try { return new URL(r.url).hostname.replace('www.', ''); }
        catch { return r.url; }
      })();

      const cell = (v, err) => Number.isFinite(v)
        ? `<span class="score-chip ${scoreClass(v)}">${v}</span>`
        : `<span class="font-mono text-[11px] text-app-text-faint" title="${esc(err ? friendlyError(err) : 'No score available')}">—</span>`;

      const selected = selectedSiteId === r.id;
      const row = `<tr
        class="site-row${selected ? ' is-selected' : ''}"
        id="site-row-${r.id}"
        tabindex="0"
        aria-expanded="${selected}"
        ${selected ? `aria-controls="detail-row-${r.id}"` : ''}
        onclick="openSite(${r.id})"
        onkeydown="rowKey(event, ${r.id})">
          <td title="${esc(r.url)}">
            <div class="flex min-w-0 items-start gap-2.5">
              <span class="site-status-dot ${rowTone(r)}" aria-hidden="true"></span>
              <div class="min-w-0">
                <div class="truncate text-[13px] font-semibold text-app-text sm:text-sm">${esc(r.label || host)}</div>
                <div class="mt-0.5 truncate text-[11px] text-app-text-faint">${esc(host)}</div>
              </div>
            </div>
          </td>
          <td data-label="Mobile">${cell(r.mobile, r.mobileError)}</td>
          <td data-label="Desktop">${cell(r.desktop, r.desktopError)}</td>
          <td data-label="Status">${badge(r)}</td>
          <td data-label="Checked" class="font-mono text-[10px] text-app-text-faint sm:text-[11px]" title="${esc(fmtDate(r.lastChecked))}">${esc(relativeTime(r.lastChecked))}</td>
        </tr>`;

      return row + (selected ? detailRowMarkup(r) : '');
    }).join('');
  }

  const moreWrap = document.getElementById('load-more-wrap');
  const moreBtn = document.getElementById('load-more-btn');
  const remaining = isMobile ? Math.max(0, sorted.length - visible.length) : 0;
  moreWrap.hidden = !isMobile || remaining === 0;
  if (remaining) moreBtn.textContent = `Load more (${remaining})`;

  const meta = document.getElementById('site-list-meta');
  if (filtered.length === ALL.length) {
    meta.textContent = `${ALL.length} ${ALL.length === 1 ? 'site' : 'sites'} total`;
  } else {
    meta.textContent = `${filtered.length} ${filtered.length === 1 ? 'match' : 'matches'} · ${ALL.length} total`;
  }
}

function loadMoreSites() {
  visibleSiteCount += PAGE_SIZE;
  renderTable();
}

function rowKey(event, id) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();

    if (selectedSiteId === id) {
      closeDetail(true);
      return;
    }

    openSite(id);
  }
}

async function openSite(id, forceOpen = false) {
  if (!forceOpen && selectedSiteId === id) {
    closeDetail(false);
    return;
  }

  selectedSiteId = id;

  if (mobileListQuery.matches) {
    const selectedIndex = filtered.findIndex(r => r.id === id);
    if (selectedIndex >= 0) visibleSiteCount = Math.max(visibleSiteCount, selectedIndex + 1);
  }

  renderTable();

  const row = document.getElementById(`site-row-${id}`);
  if (row) {
    requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  if (SITE_HISTORY_CACHE.has(id) && !forceOpen) return;

  const body = document.getElementById(`detail-body-${id}`);
  if (!body) return;

  try {
    const res = await fetch(`/api/sites/${id}/history`);
    if (!res.ok) throw new Error('The API returned ' + res.status);

    const history = await res.json();
    SITE_HISTORY_CACHE.set(id, history);

    const currentBody = document.getElementById(`detail-body-${id}`);
    const site = ALL.find(r => r.id === id);
    if (currentBody && site && selectedSiteId === id) {
      currentBody.innerHTML = detailBodyMarkup(history, site);
    }
  } catch (error) {
    const currentBody = document.getElementById(`detail-body-${id}`);
    if (currentBody && selectedSiteId === id) {
      currentBody.innerHTML = `<div class="rounded-md border border-warn-border bg-warn-soft px-4 py-6 text-center text-sm text-warn">Could not load site history. ${esc(error.message)}</div>`;
    }
  }
}

function closeDetail(restoreFocus = false) {
  const previousId = selectedSiteId;
  selectedSiteId = null;
  renderTable();

  if (restoreFocus && previousId) {
    requestAnimationFrame(() => document.getElementById(`site-row-${previousId}`)?.focus());
  }
}

function handleViewportChange() {
  visibleSiteCount = PAGE_SIZE;

  if (mobileListQuery.matches && selectedSiteId) {
    const selectedIndex = filtered.findIndex(r => r.id === selectedSiteId);
    if (selectedIndex >= 0) visibleSiteCount = Math.max(PAGE_SIZE, selectedIndex + 1);
  }

  renderTable();
}

function addMediaListener(query, handler) {
  if (query.addEventListener) query.addEventListener('change', handler);
  else query.addListener(handler);
}

addMediaListener(mobileListQuery, handleViewportChange);
addMediaListener(compactLayoutQuery, handleViewportChange);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedSiteId) {
    closeDetail(true);
  }
});

async function loadAll() {
  const btn = document.getElementById('refresh-btn');
  const icon = document.getElementById('spin-icon');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  icon.classList.add('spin');

  try {
    const dataRes = await fetch('/api/data', { cache: 'no-store' });
    if (!dataRes.ok) throw new Error('The API returned ' + dataRes.status);

    const payload = await dataRes.json();
    THRESHOLD = payload.threshold ?? 70;
    SCAN_CRON = payload.scanCron || '';
    LATEST_SCAN = payload.latestScan || null;
    ALL = payload.sites || [];
    filtered = [...ALL];
    SITE_HISTORY_CACHE.clear();

    document.getElementById('app-version').textContent = payload.version ? `v${payload.version}` : 'v—';

    updateSummary();
    applyFilters();

    if (selectedSiteId && ALL.some(s => s.id === selectedSiteId)) {
      await openSite(selectedSiteId, true);
    }
  } catch (error) {
    document.getElementById('table-body').innerHTML =
      `<tr><td colspan="5" class="py-14 text-center text-sm text-bad">Could not load monitoring data. ${esc(error.message)}</td></tr>`;
    document.getElementById('site-list-meta').textContent = 'Unavailable';

    const state = document.getElementById('runtime-state');
    const dot = document.getElementById('snapshot-dot');
    const meta = document.getElementById('snapshot-meta');
    state.textContent = 'Monitoring data unavailable';
    state.className = 'font-medium text-warn';
    dot.className = 'h-2 w-2 rounded-full bg-warn-dot';
    meta.textContent = 'Refresh to retry';
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    icon.classList.remove('spin');
  }
}

loadAll();
