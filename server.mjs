import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb, getAllLatest, getLatest, getHistory, lastRun } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

let config = loadConfig();
let configChangeDebounce = null;
const CONFIG_DEBOUNCE_MS = 800; // debounce file watcher for rapid saves

const app = express();
app.use(express.json());

// API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), tickers: config.tickers });
});

app.get('/api/overview', (_req, res) => {
  const db = openDb();
  try {
    const tickers = config.tickers.map(t => {
      const all = getAllLatest(db, t);
      return {
        ticker: t,
        quote: all.quote?.data,
        ta_latest: all.ta?.data,
        intraday_ohlcv: all.intraday_ohlcv?.data,
        data_perspective: all.data_perspective?.data,
        decision: all.decision?.data,
        pipeline_status: all._pipeline_status?.data,
        last_quote_ts: all.intraday_ohlcv?.ts || all.quote?.ts || null,
        last_decision_ts: all.decision?.ts || null,
      };
    });
    const review = db.prepare(`SELECT ts, payload FROM latest WHERE ticker='_MARKET' AND kind='review'`).get();
    res.json({
      tickers,
      market_review: review ? { ts: review.ts, data: JSON.parse(review.payload) } : null,
      pipeline: {
        last_intraday: lastRun(db, 'intraday'),
        last_eod: lastRun(db, 'eod'),
      }
    });
  } finally {
    db.close();
  }
});

app.get('/api/stock/:ticker', (req, res) => {
  const t = req.params.ticker.toUpperCase();
  if (!config.tickers.includes(t)) return res.status(404).json({ error: 'unknown ticker' });
  const db = openDb();
  try {
    res.json({
      ticker: t,
      ...getAllLatest(db, t)
    });
  } finally {
    db.close();
  }
});

app.get('/api/stock/:ticker/history/:kind', (req, res) => {
  const t = req.params.ticker.toUpperCase();
  if (!config.tickers.includes(t)) return res.status(404).json({ error: 'unknown ticker' });
  const limit = Math.min(parseInt(req.query.limit) || 60, 500);
  const db = openDb();
  try {
    res.json({ history: getHistory(db, t, req.params.kind, limit) });
  } finally {
    db.close();
  }
});

let refreshing = false;
function startPipeline(mode) {
  if (refreshing) return false;
  refreshing = true;
  const child = spawn('node', [path.join(__dirname, 'pipeline.mjs'), mode], {
    cwd: __dirname,
    stdio: 'ignore',
    detached: true
  });
  child.unref();
  child.on('exit', () => { refreshing = false; });
  console.log(`[scheduler] started pipeline: ${mode}`);
  return true;
}

app.post('/api/refresh', (req, res) => {
  const mode = (req.body?.mode || 'intraday').toLowerCase();
  if (!['intraday', 'eod', 'all'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  if (!startPipeline(mode)) return res.status(429).json({ error: 'refresh already running' });
  res.json({ ok: true, mode, started: true });
});

// --- Auto-refresh scheduler (timezone-aware, no external deps) ---
const TZ = config.eodTimezone || 'Asia/Saigon';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function tzNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    weekday: get('weekday'),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`
  };
}

// Parse "m h * * dow" — only minute+hour are honored (matches config format)
function parseEodCron(expr) {
  const f = (expr || '0 16 * * 1-5').trim().split(/\s+/);
  return { minute: parseInt(f[0], 10) || 0, hour: parseInt(f[1], 10) || 16 };
}
const eodTime = parseEodCron(config.eodCronExpr);
const intradayMs = config.intradayIntervalMs || 300000;

function isMarketHours(n) {
  if (!WEEKDAYS.includes(n.weekday)) return false;
  const mins = n.hour * 60 + n.minute;
  return mins >= 9 * 60 && mins <= 15 * 60; // 09:00–15:00 VN
}

// Intraday refresh during market hours
setInterval(() => {
  const n = tzNow();
  if (isMarketHours(n)) startPipeline('intraday');
}, intradayMs);

// EOD refresh: fire once when local time hits the configured weekday cron slot
let lastEodDate = null;
setInterval(() => {
  const n = tzNow();
  if (!WEEKDAYS.includes(n.weekday)) return;
  if (n.hour === eodTime.hour && n.minute === eodTime.minute && lastEodDate !== n.dateKey) {
    lastEodDate = n.dateKey;
    startPipeline('eod');
  }
}, 60000);

console.log(`[scheduler] intraday every ${Math.round(intradayMs / 1000)}s during market hours; EOD ${String(eodTime.hour).padStart(2, '0')}:${String(eodTime.minute).padStart(2, '0')} ${TZ} on weekdays`);

// Static dashboard (no cache for dev)
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}}));

const port = process.env.PORT || config.port || 7878;
const host = process.env.HOST || config.host || '0.0.0.0';

// ── Config hot-reload ──
// Watches config.json for changes; on change, diffs ticker list and auto-triggers
// pipeline for newly added tickers (intraday + eod data). Dashboard API picks up
// the new config immediately without server restart.

function diffTickers(oldList, newList) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  const added = [...newSet].filter(t => !oldSet.has(t));
  const removed = [...oldSet].filter(t => !newSet.has(t));
  return { added, removed };
}

function spawnPipeline(tickers, mode) {
  const child = spawn('node', [
    path.join(__dirname, 'pipeline.mjs'),
    mode,
    '--tickers', tickers.join(',')
  ], {
    cwd: __dirname,
    stdio: 'inherit',
    detached: true
  });
  child.unref();
  child.on('error', (err) => {
    console.error(`[config-watch] pipeline spawn error:`, err.message);
  });
  child.on('exit', (code) => {
    console.log(`[config-watch] pipeline for ${tickers.join(',')} (${mode}) exited code=${code}`);
  });
}

function onConfigChanged() {
  let newConfig;
  try {
    newConfig = loadConfig();
  } catch (e) {
    console.error('[config-watch] failed to parse config.json:', e.message);
    return;
  }

  const oldTickers = config.tickers || [];
  const newTickers = newConfig.tickers || [];
  const { added, removed } = diffTickers(oldTickers, newTickers);

  if (added.length === 0 && removed.length === 0) {
    console.log('[config-watch] config changed but tickers unchanged, reloading config');
    config = newConfig;
    return;
  }

  console.log(`[config-watch] tickers changed | added: [${added.join(',')}] | removed: [${removed.join(',')}]`);
  config = newConfig;

  if (added.length > 0) {
    console.log(`[config-watch] auto-triggering pipeline (all) for new tickers: ${added.join(',')}`);
    spawnPipeline(added, 'all');
  }
}

// Use fs.watch with debounce (macOS fires multiple events per save)
fs.watch(configPath, (eventType) => {
  if (eventType !== 'change') return;
  clearTimeout(configChangeDebounce);
  configChangeDebounce = setTimeout(onConfigChanged, CONFIG_DEBOUNCE_MS);
});

console.log('[config-watch] watching config.json for changes');

app.listen(port, host, () => {
  console.log(`stock-dashboard server: http://${host}:${port}`);
});
