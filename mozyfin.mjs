import { execFile } from 'node:child_process';

export function runMozyfin(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('mozyfin', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.toString().trim() || err.message;
        return reject(new Error(`mozyfin ${args.join(' ')} failed: ${msg}`));
      }
      resolve(stdout.toString());
    });
  });
}

// Parse a Markdown pipe-table into [{col: value, ...}]
export function parseMarkdownTable(text) {
  const rawLines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('|') && l.endsWith('|'));
  if (rawLines.length < 2) return [];
  const splitRow = (l) => l.slice(1, -1).split('|').map(c => c.trim());
  const header = splitRow(rawLines[0]);
  // Find separator row (---|---), data rows are everything except header + separator
  const dataLines = rawLines.slice(1).filter(l => !/^\s*\|?\s*[-: ]+\s*(\|\s*[-: ]+\s*)+\|?\s*$/.test(l));
  const rows = dataLines.map(l => {
    const cells = splitRow(l);
    const obj = {};
    header.forEach((h, i) => {
      const v = cells[i];
      obj[h] = autoCast(v);
    });
    return obj;
  });
  return rows;
}

function autoCast(v) {
  if (v == null) return null;
  if (v === '' || v === '—' || v === '-' || v === 'N/A') return null;
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  // Pure number (with optional %)
  const isPct = v.endsWith('%');
  const stripped = v.replace(/[, ]/g, '').replace(/%$/, '');
  if (/^-?\d+(\.\d+)?$/.test(stripped)) {
    const n = Number(stripped);
    return isPct ? n : n;
  }
  return v;
}

export async function mozyfinTable(args, { timeoutMs = 60000 } = {}) {
  const out = await runMozyfin(args, { timeoutMs });
  const rows = parseMarkdownTable(out);
  return { rows, raw: out };
}

export async function safeFetch(args, opts) {
  try {
    return await mozyfinTable(args, opts);
  } catch (e) {
    return { error: e.message, rows: [] };
  }
}
