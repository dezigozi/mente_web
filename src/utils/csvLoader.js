/**
 * CSV ローダー (mente_web)
 *
 * パフォーマンスのコア設計:
 *  1. master_data.csv の fetch + パースは Web Worker に委譲（メインスレッドを止めない）
 *  2. ETag による条件付きGET → 内容に変更がなければ 304 で通信短絡
 *  3. パース済みデータを IndexedDB にキャッシュ → 2回目以降は瞬時表示
 *
 * tab_data.csv は小さく (~112KB) 変更頻度が高いため、毎回メインスレッドで取得する。
 *
 * 既存の App.jsx は `loadCsvData`、`generateFullDataCsvContent`、`loadTabData` を import する。
 * 他コードのために、csvParse.js のヘルパー関数を re-export して既存のインポートパスを温存する。
 */
import CsvWorker from './csvWorker.js?worker';
import { getCache, setCache } from './db.js';
import { deliveryDateCalendarParts } from './deliveryDateParts.js';
import {
  parseCSVLine as _parseCSVLine,
  normalizeTextLabel as _normalizeTextLabel,
  textGroupKey as _textGroupKey,
  companyFromBranchName as _companyFromBranchName,
  toSurnameFromFullName as _toSurnameFromFullName,
  extractNameFromBranchRaw as _extractNameFromBranchRaw,
  phoneDigitsKey as _phoneDigitsKey,
  normalizeJapanPhoneDigits as _normalizeJapanPhoneDigits,
} from './csvParse.js';

// 後方互換: 旧コードからこの名前で参照される可能性があるため re-export
export const parseCSVLine = _parseCSVLine;
export const normalizeTextLabel = _normalizeTextLabel;
export const textGroupKey = _textGroupKey;
export const companyFromBranchName = _companyFromBranchName;
export const toSurnameFromFullName = _toSurnameFromFullName;
export const extractNameFromBranchRaw = _extractNameFromBranchRaw;
export const phoneDigitsKey = _phoneDigitsKey;
export const normalizeJapanPhoneDigits = _normalizeJapanPhoneDigits;

const CACHE_KEY_DATA = 'csv_parsed_v1';
const CACHE_KEY_ETAG = 'csv_etag_v1';

/** public/data 以下の CSV への URL（先頭が // にならないよう正規化） */
function publicDataUrl(filename) {
  let base = import.meta.env.BASE_URL ?? '/';
  if (typeof base !== 'string' || base === '') base = '/';
  if (!base.endsWith('/')) base = `${base}/`;
  return `${base}data/${filename}`;
}

export async function loadCsvData(onProgress) {
  const notify = (msg) => { try { onProgress?.(msg); } catch { /* noop */ } };
  const url = publicDataUrl('master_data.csv');

  let cachedData = null;
  let cachedEtag = null;
  try {
    [cachedData, cachedEtag] = await Promise.all([
      getCache(CACHE_KEY_DATA),
      getCache(CACHE_KEY_ETAG),
    ]);
  } catch (err) {
    console.warn('IndexedDB 読み込みに失敗:', err);
  }

  if (cachedData) {
    notify('キャッシュを確認中...');
  } else {
    notify('初回ロード中（少し時間がかかります）...');
  }

  let workerResult;
  try {
    workerResult = await runCsvWorker({ url, etag: cachedEtag, onProgress: notify });
  } catch (err) {
    if (cachedData) {
      console.warn('CSV取得失敗のためキャッシュを使用:', err);
      notify('オフライン: 保存済みデータを表示');
      return cachedData;
    }
    throw err;
  }

  if (workerResult.notModified) {
    if (cachedData) {
      notify('更新なし: キャッシュから読み込み完了');
      return cachedData;
    }
    console.warn('304 だがキャッシュなし。再フェッチします');
    workerResult = await runCsvWorker({ url, etag: null, onProgress: notify });
  }

  const { result, etag } = workerResult;
  if (!result) {
    throw new Error('Worker からデータが返りませんでした');
  }

  notify('データを保存中...');
  try {
    await setCache(CACHE_KEY_DATA, result);
    if (etag) await setCache(CACHE_KEY_ETAG, etag);
  } catch (err) {
    console.warn('IndexedDB 書き込みに失敗（キャッシュ無効化）:', err);
  }

  return result;
}

function runCsvWorker({ url, etag, onProgress }) {
  return new Promise((resolve, reject) => {
    const worker = new CsvWorker();
    let settled = false;

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'progress') {
        onProgress?.(msg.message);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (msg.ok) {
        resolve(msg);
      } else {
        reject(new Error(msg.error || 'Worker error'));
      }
    };

    worker.onerror = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(err.message || 'Worker crashed'));
    };

    worker.postMessage({ url, etag });
  });
}

/**
 * 現在の表示フィルタに合致した行を、元CSVのヘッダー＋全列のまま出力。
 * 末尾に「年」「月」「年月」（納品日ベース・暦年／月。年月は「2026年3月」形式で Excel の日付化を避ける）を付与する。
 * @param {string[]} headers
 * @param {Array<{ rawRow?: string[], month?: number, year?: number, fiscalYear?: number }>} rows
 */
export function generateFullDataCsvContent(headers, rows) {
  if (!headers?.length) return '';
  const escapeCell = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const extraHeaders = ['年', '月', '年月'];
  const out = [[...headers, ...extraHeaders].map(escapeCell).join(',')];
  const n = headers.length;
  for (const row of rows) {
    const vals = row?.rawRow;
    if (!vals) continue;
    const { year, month, yearMonth } = deliveryDateCalendarParts(row);
    const cells = Array.from({ length: n }, (_, i) => escapeCell(vals[i] ?? ''));
    cells.push(escapeCell(year), escapeCell(month), escapeCell(yearMonth));
    out.push(cells.join(','));
  }
  return out.join('\r\n');
}

/**
 * tab_data.csv を読み込み、タブ価格マップと適用日マップを返す。
 * tab_data は小さく (~112KB) 変更頻度が高いため、IndexedDB キャッシュせずメインスレッドで都度取得する。
 * - tabMap        : Map<リース会社, Map<品番, { price, makerCode, dateStr }>>
 * - applicableDates: Map<リース会社, {year, month, day}>
 */
export async function loadTabData() {
  const p = publicDataUrl('tab_data.csv');
  const response = await fetch(p);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}（${p}）`);
  }
  const csv = await response.text();
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return { tabMap: new Map(), applicableDates: new Map() };

  const headers = _parseCSVLine(lines[0]).map(h => h.trim().replace(/^﻿/, ''));
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  const COL_LEASE      = idx['メンテ']      ?? 0;
  const COL_CODE       = idx['品番']        ?? 1;
  const COL_MAKER_CODE = idx['メーカーコード'] ?? 2;
  const COL_PRICE      = idx['TAB価格']     ?? 3;
  const COL_DATE       = idx['適用日']      ?? 4;

  const tabMap = new Map();
  const applicableDates = new Map();

  for (let i = 1; i < lines.length; i++) {
    const vals      = _parseCSVLine(lines[i]);
    const lease     = vals[COL_LEASE]?.trim()      || '';
    const code      = vals[COL_CODE]?.trim()       || '';
    const makerCode = vals[COL_MAKER_CODE]?.trim() || '';
    const price     = parseFloat(vals[COL_PRICE]?.trim()) || 0;
    const dateStr   = vals[COL_DATE]?.trim()       || '';
    if (!lease || !code) continue;

    if (!tabMap.has(lease)) tabMap.set(lease, new Map());
    tabMap.get(lease).set(code, { price, makerCode, dateStr });

    const dm = dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (dm) {
      const d   = { year: +dm[1], month: +dm[2], day: +dm[3] };
      const val = d.year * 10000 + d.month * 100 + d.day;
      const ex  = applicableDates.get(lease);
      const exV = ex ? ex.year * 10000 + ex.month * 100 + ex.day : 0;
      if (val > exV) applicableDates.set(lease, d);
    }
  }
  return { tabMap, applicableDates };
}
