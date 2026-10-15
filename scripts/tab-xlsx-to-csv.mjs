/**
 * タブ価格の登録用Excel → public/data/tab_data.csv 変換
 * 使い方: node scripts/tab-xlsx-to-csv.mjs <xlsxのパス>
 * シートは「tab_data」（無ければ1枚目）。列は見出し名で拾う。適用日は "YYYY年M月D日" に揃える
 */
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COLS = ['メンテ', '品番', 'メーカーコード', 'TAB価格', '適用日'];
const OUT = fileURLToPath(new URL('../public/data/tab_data.csv', import.meta.url));

const src = process.argv[2];
if (!src) {
  console.error('[ERROR] xlsx path is required');
  process.exit(1);
}

/** セル値 → 素の値（数式は結果、リッチテキストは文字列） */
function plain(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}

/** 適用日 → "YYYY年M月D日"（Excelシリアル値 / Date / 文字列に対応） */
function toJpDate(v) {
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number') d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
  else if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(s)) return s;
    const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (m) return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
    return s;
  }
  if (!d || isNaN(d)) return '';
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function csvCell(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(src);
const ws = wb.getWorksheet('tab_data') ?? wb.worksheets[0];

const colIdx = {};
ws.getRow(1).eachCell((cell, c) => { colIdx[String(plain(cell.value) ?? '').trim()] = c; });
const missing = COLS.filter(h => !colIdx[h]);
if (missing.length) {
  console.error(`[ERROR] missing columns: ${missing.join(', ')}`);
  process.exit(1);
}

const lines = [COLS.join(',')];
let noDate = 0;
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r);
  const get = h => plain(row.getCell(colIdx[h]).value);
  const lease = String(get('メンテ') ?? '').trim();
  const code = String(get('品番') ?? '').trim();
  if (!lease || !code) continue;
  const date = toJpDate(get('適用日'));
  if (!date) noDate++;
  const vals = [lease, code, String(get('メーカーコード') ?? '').trim(), String(get('TAB価格') ?? '').trim(), date];
  lines.push(vals.map(csvCell).join(','));
}

writeFileSync(OUT, '﻿' + lines.join('\n') + '\n', 'utf8');
console.log(`[OK] ${lines.length - 1} rows -> public/data/tab_data.csv (sheet: ${ws.name})`);
if (noDate) console.log(`[WARN] ${noDate} rows have no date`);
