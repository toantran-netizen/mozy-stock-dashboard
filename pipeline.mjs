#!/usr/bin/env node
// Pipeline worker for stock dashboard (DSA-style decision dashboard)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, saveLatest, recordRun, finishRun, getLatest } from './db.mjs';
import { safeFetch } from './mozyfin.mjs';
import { buildDataPerspective } from './technicals.mjs';
import { generateDecisionDashboard } from './analyzer.mjs';
import { generateMarketReview } from './market-review.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const mode = (process.argv[2] || 'intraday').toLowerCase();

// Parse --tickers flag for targeted runs (comma-separated, e.g. --tickers VCB,FPT)
const tickersArgIdx = process.argv.indexOf('--tickers');
const targetTickers = tickersArgIdx >= 0 && process.argv[tickersArgIdx + 1]
  ? process.argv[tickersArgIdx + 1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : null;
const tickers = targetTickers || config.tickers;
const isTargeted = !!targetTickers;

async function fetchIntraday(db, ticker) {
  const sym = `${ticker}.VN`;
  console.log(`[intraday] ${ticker}: quote + ohlcv + ta`);
  saveLatest(db, ticker, 'quote', await safeFetch(['quote', sym, '--limit', '1']));
  saveLatest(db, ticker, 'intraday_ohlcv', await safeFetch(['ohlcv', sym, '--timeframe', '1d', '--limit', '5']));
  saveLatest(db, ticker, 'ta', await safeFetch(['ta', sym, '--rsi', '14', '--macd', '--sma', '5,10,20']));
}

async function fetchEod(db, ticker) {
  const sym = `${ticker}.VN`;
  console.log(`[eod] ${ticker}: stats + ohlcv + news + risk`);
  saveLatest(db, ticker, 'stats', await safeFetch(['stats', sym]));
  saveLatest(db, ticker, 'ohlcv', await safeFetch(['ohlcv', sym, '--timeframe', '1d', '--limit', '90']));
  saveLatest(db, ticker, 'news', await safeFetch(['news', '--query', sym, '--limit', '15']));
  saveLatest(db, ticker, 'risk', await safeFetch(['risk', sym]));
}

function getRows(node) {
  return node?.data?.rows || node?.rows || [];
}

async function generateDecision(db, ticker) {
  console.log(`[eod] ${ticker}: building Decision Dashboard via Mozy AI`);
  const quoteRows = getRows(getLatest(db, ticker, 'quote'));
  const ohlcvRows = getRows(getLatest(db, ticker, 'ohlcv'));
  const newsRows = getRows(getLatest(db, ticker, 'news'));
  const statsRows = getRows(getLatest(db, ticker, 'stats'));
  const riskRows = getRows(getLatest(db, ticker, 'risk'));

  const today = quoteRows[quoteRows.length - 1] || {};
  const stats = statsRows[0] || {};

  const dataPerspective = buildDataPerspective(ohlcvRows);
  saveLatest(db, ticker, 'data_perspective', dataPerspective || { error: 'insufficient ohlcv' });

  const ohlcvTail = ohlcvRows.slice(-10);
  if (today.close == null && ohlcvTail.length) today.close = ohlcvTail[ohlcvTail.length - 1].close;

  try {
    const dashboard = await generateDecisionDashboard({
      ticker,
      name: ticker,
      today,
      dataPerspective,
      ohlcvTail,
      stats,
      news: newsRows,
      riskRows
    });
    saveLatest(db, ticker, 'decision', dashboard);
    console.log(`[eod] ${ticker}: dashboard score=${dashboard.sentiment_score} advice=${dashboard.operation_advice}`);
  } catch (e) {
    console.error(`[eod] ${ticker} decision failed:`, e.message);
    saveLatest(db, ticker, 'decision', { error: e.message });
  }
}

async function runMarketReview(db) {
  console.log('[eod] generating market review');
  try {
    const review = await generateMarketReview();
    db.prepare(`
      INSERT INTO latest (ticker, kind, ts, payload)
      VALUES ('_MARKET', 'review', ?, ?)
      ON CONFLICT(ticker, kind) DO UPDATE SET ts=excluded.ts, payload=excluded.payload
    `).run(Date.now(), JSON.stringify(review));
  } catch (e) {
    console.error('[eod] market review failed:', e.message);
    db.prepare(`
      INSERT INTO latest (ticker, kind, ts, payload)
      VALUES ('_MARKET', 'review', ?, ?)
      ON CONFLICT(ticker, kind) DO UPDATE SET ts=excluded.ts, payload=excluded.payload
    `).run(Date.now(), JSON.stringify({ error: e.message }));
  }
}

async function run() {
  const db = openDb();
  const runId = recordRun(db, mode);
  let status = 'ok';
  let message = '';
  try {
    for (const ticker of tickers) {
      try {
        if (mode === 'intraday' || mode === 'all') await fetchIntraday(db, ticker);
        if (mode === 'eod' || mode === 'all') {
          await fetchEod(db, ticker);
          await generateDecision(db, ticker);
        }
      } catch (e) {
        console.error(`[${mode}] ${ticker} error:`, e.message);
        message += `${ticker}:${e.message}; `;
      }
    }
    if ((mode === 'eod' || mode === 'all') && !isTargeted) {
      await runMarketReview(db);
    }
  } catch (e) {
    status = 'error';
    message = e.message;
  } finally {
    finishRun(db, runId, status, message || null);
    db.close();
    console.log(`[${mode}] done: ${status}`);
  }
}

run().catch(err => { console.error('pipeline crashed:', err); process.exit(1); });
