import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb, getAllLatest, getLatest, getHistory, lastRun } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

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
app.post('/api/refresh', (req, res) => {
  if (refreshing) return res.status(429).json({ error: 'refresh already running' });
  const mode = (req.body?.mode || 'intraday').toLowerCase();
  if (!['intraday', 'eod', 'all'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  refreshing = true;
  const child = spawn('node', [path.join(__dirname, 'pipeline.mjs'), mode], {
    cwd: __dirname,
    stdio: 'ignore',
    detached: true
  });
  child.unref();
  child.on('exit', () => { refreshing = false; });
  res.json({ ok: true, mode, started: true });
});

// Static dashboard (no cache for dev)
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}}));

const port = process.env.PORT || config.port || 7878;
const host = process.env.HOST || config.host || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`stock-dashboard server: http://${host}:${port}`);
});
