/**
 * CSV パース純粋関数 + 関連ヘルパー
 *
 * メインスレッドと Web Worker の両方から利用するため、外部依存は jpPrefecture.js のみ。
 * 仕様変更時はこのファイルを修正すれば両者に反映される。
 *
 * 列マッピングや表記揺れ吸収の意図は元の csvLoader.js のコメント（同等内容）参照。
 */
import { inferPrefectureFromAddress1 } from './jpPrefecture.js';

const ORDERER_NONE_LABEL = '(注文者未登録)';

export function normalizeTextLabel(s) {
  if (s == null) return '';
  const t = String(s).trim().normalize('NFKC');
  if (!t) return '';
  return t
    .replace(/[\s　  -​﻿]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export function textGroupKey(s) {
  return normalizeTextLabel(s).replace(/\s/g, '');
}

export function companyFromBranchName(branchStr) {
  if (branchStr == null) return '';
  const t = normalizeTextLabel(String(branchStr));
  if (!t) return t;
  const parts = t.split(/[\s　]+/).filter(Boolean);
  if (parts.length < 2) return t;
  return parts.slice(0, -1).join(' ');
}

export function toSurnameFromFullName(s) {
  if (s == null || s === ORDERER_NONE_LABEL) return s || '';
  const t = normalizeTextLabel(String(s));
  if (!t) return t;
  const p = t.split(/[\s　]+/).filter(Boolean);
  if (p.length > 1) return p[0];
  const one = p[0];
  if (one.length <= 2) return one;
  if (one.length === 3) {
    const kana = /^[゠-ヿ぀-ゟ　ー]+$/u.test(one.replace(/\s/g, ''));
    if (kana) return one;
    return one.slice(0, 2);
  }
  if (one.length >= 4) return one.slice(0, 2);
  return one;
}

const _ORDERER_SAME = (() => {
  const m = new Map();
  const reg = (arr, key) => { arr.forEach((x) => m.set(textGroupKey(x), key)); };
  reg(['金子', 'カネコ', 'かねこ', 'ｶﾈｺ'], 'OS_kane');
  reg(['中嶋', '中島', '仲島', 'ナカジマ', 'なかじま', 'ﾅｶｼﾞﾏ'], 'OS_naka');
  return m;
})();

const ORDERER_SAME_PREFERRED = { OS_kane: '金子', OS_naka: '中嶋' };

function ordererStableKeyFromSurname(surname) {
  if (!surname || surname === ORDERER_NONE_LABEL) return '___NO_ORDERER___';
  const g = textGroupKey(surname);
  return _ORDERER_SAME.get(g) || g;
}

export function extractNameFromBranchRaw(branchStr) {
  if (branchStr == null || !String(branchStr).trim()) return '';
  const t = normalizeTextLabel(String(branchStr));
  if (!t) return '';
  const parts = t.split(/[\s　]+/).filter(Boolean);
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1];
  if (last.length > 32) return '';
  if (/(?:御|ご)?担当|社長|部長/.test(last) && last.length < 5) return '';
  return last;
}

export function phoneDigitsKey(phone) {
  if (phone == null) return '';
  return String(phone).replace(/\D/g, '');
}

export function normalizeJapanPhoneDigits(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('81') && d.length >= 11) d = `0${d.slice(2)}`;
  else if (!d.startsWith('0') && d.length >= 9 && d.length <= 10) d = `0${d}`;
  return d;
}

export function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function fiscalYearMonthFromCalendar(y, m) {
  if (m < 1 || m > 12 || y < 1000 || y > 3000) return null;
  // year は常に暦の西暦年（UIで年度開始月を変えるときの再分類用）
  return { fiscalYear: m >= 4 ? y : y - 1, month: m, year: y };
}

function parseDate(dateValue) {
  if (dateValue == null || String(dateValue).trim() === '') return null;

  if (typeof dateValue === 'string' && dateValue) {
    const datePart = dateValue.split(' ')[0].trim();
    if (/^\d{4}$/.test(datePart)) {
      const y = Number(datePart);
      if (y >= 1980 && y <= 2100) {
        return fiscalYearMonthFromCalendar(y, 4);
      }
    }
    const parts = datePart.split(/[-\/]/).map(Number);
    if (parts.length === 3) {
      const [a, b, c] = parts;
      if (a > 1900 && a < 3000 && b >= 1 && b <= 12) {
        return fiscalYearMonthFromCalendar(a, b);
      }
      if (c > 1900 && c < 3000 && a >= 1 && a <= 12 && b >= 1 && b <= 31) {
        return fiscalYearMonthFromCalendar(c, a);
      }
    }
  }

  const asStr = typeof dateValue === 'string' ? dateValue.trim() : null;
  const num = typeof dateValue === 'number' ? dateValue : parseFloat(String(dateValue));
  if (isNaN(num) || num <= 0) return null;

  if (asStr && /^\d{4}(?:\.0+)?$/.test(asStr.trim())) {
    const intY = Math.round(num);
    if (intY >= 1980 && intY <= 2100 && Math.abs(num - intY) < 1e-6) {
      return fiscalYearMonthFromCalendar(intY, 4);
    }
  }

  const excelEpoch = new Date(1900, 0, -1);
  const date = new Date(excelEpoch.getTime() + num * 86400000);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  if (m < 1 || m > 12) return null;
  if (y < 1980 || y > 2100) return null;
  return fiscalYearMonthFromCalendar(y, m);
}

export function parseCsv(csv) {
  const lines = csv.trim().split('\n').filter(line => line.trim());
  if (lines.length === 0) throw new Error('CSVファイルが空です');

  const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^﻿/, ''));

  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  const COL_SLIP      = idx['売上伝票ＮＯ'] ?? idx['売上伝票NO'] ?? 0;
  const COL_DATE      = idx['納品日']        ?? 1;
  const COL_SLIP_TYPE = idx['伝票区分']      ?? 2;
  const COL_CUST      = idx['得意先名']      ?? 4;
  const COL_RECV_NAME = idx['受注者名']      ?? 6;
  const COL_ORDER     = idx['注文者名']      ?? 9;
  const COL_PHONE  = idx['宅配先電話番号'] ?? 11;
  const COL_BRANCH = idx['送り先名']      ?? 12;
  const COL_ADDR1  = idx['住所１']        ?? 14;
  const COL_MAKER  = idx['メーカーコード'] ?? 17;
  const COL_CODE   = idx['品番']          ?? 31;
  const COL_NAME   = idx['商品名']        ?? 32;
  const COL_ITEM   = idx['分析名(大)']    ?? 33;
  const COL_PRICE  = idx['単価']          ?? 39;
  const COL_QTY    = idx['数量']          ?? 40;
  const COL_PROFIT = idx['粗利']          ?? 41;
  const COL_LEASE  = idx['メンテ']        ?? 42;

  // 第1パス: 送り先名・注文先の「初出表記」を key に紐づけ
  const branchKeyToLabel = new Map();
  const orderKeyToLabel  = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const bRaw  = vals[COL_BRANCH]?.trim();
    const oRaw  = vals[COL_CUST]?.trim();
    if (bRaw) {
      const bKey = textGroupKey(bRaw);
      if (bKey && !branchKeyToLabel.has(bKey)) {
        branchKeyToLabel.set(bKey, normalizeTextLabel(bRaw) || bRaw);
      }
    }
    if (oRaw) {
      const oKey = textGroupKey(oRaw);
      if (oKey && !orderKeyToLabel.has(oKey)) {
        orderKeyToLabel.set(oKey, normalizeTextLabel(oRaw) || oRaw);
      }
    }
  }

  // 注文者: 名字 + 手動揺れ同一化の集計用ラベル
  const ordererStableToLabel = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const oRaw = (vals[COL_ORDER] && vals[COL_ORDER].trim()) || '';
    const bRaw = (vals[COL_BRANCH] && vals[COL_BRANCH].trim()) || '';
    let full = '';
    if (oRaw) {
      full = normalizeTextLabel(oRaw) || oRaw;
    } else {
      const ex = extractNameFromBranchRaw(bRaw);
      if (ex) full = normalizeTextLabel(ex) || ex;
    }
    if (!full) {
      if (!ordererStableToLabel.has('___NO_ORDERER___')) {
        ordererStableToLabel.set('___NO_ORDERER___', ORDERER_NONE_LABEL);
      }
      continue;
    }
    const sur = toSurnameFromFullName(full);
    const stKey = ordererStableKeyFromSurname(sur);
    if (ordererStableToLabel.has(stKey)) continue;
    ordererStableToLabel.set(
      stKey,
      stKey === '___NO_ORDERER___'
        ? ORDERER_NONE_LABEL
        : (ORDERER_SAME_PREFERRED[stKey] || sur)
    );
  }

  // 第2パス: 電話番号 → 送り先の初出正規化表記
  const phoneToBranchLabel = new Map();
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const pRaw   = vals[COL_PHONE]?.trim();
    const bRaw  = vals[COL_BRANCH]?.trim();
    if (!bRaw) continue;
    const bLabel = branchKeyToLabel.get(textGroupKey(bRaw)) || normalizeTextLabel(bRaw) || bRaw;
    const pKey   = phoneDigitsKey(pRaw);
    const pNorm  = normalizeJapanPhoneDigits(pRaw);
    const keys   = new Set([pKey, pNorm].filter(Boolean));
    for (const k of keys) {
      if (!phoneToBranchLabel.has(k)) phoneToBranchLabel.set(k, bLabel);
    }
  }

  // 第3パス: 行データを構築
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);

    const dateVal     = vals[COL_DATE]?.trim();
    const orderClientRaw = vals[COL_CUST]?.trim();
    const phone       = vals[COL_PHONE]?.trim();
    const branchRaw   = vals[COL_BRANCH]?.trim();
    const productCode = vals[COL_CODE]?.trim() || '(品番なし)';
    const productName = vals[COL_NAME]?.trim() || '';
    const item        = vals[COL_ITEM]?.trim();
    const unitPrice   = parseFloat(vals[COL_PRICE]?.trim()) || 0;
    const qty         = parseFloat(vals[COL_QTY]?.trim()) || 0;
    const profit      = parseFloat(vals[COL_PROFIT]?.trim()) || 0;
    const lease       = vals[COL_LEASE]?.trim() || '';
    const sales       = Math.round(unitPrice * qty);

    const pDigits = phoneDigitsKey(phone);
    const pNorm   = normalizeJapanPhoneDigits(phone) || pDigits;
    let branch = '(未分類)';
    if (pDigits && phoneToBranchLabel.has(pDigits)) {
      branch = phoneToBranchLabel.get(pDigits);
    } else if (pNorm && pNorm !== pDigits && phoneToBranchLabel.has(pNorm)) {
      branch = phoneToBranchLabel.get(pNorm);
    } else if (branchRaw) {
      const bk = textGroupKey(branchRaw);
      branch = (bk && branchKeyToLabel.get(bk)) || normalizeTextLabel(branchRaw) || branchRaw;
    }

    const dateInfo = parseDate(dateVal);
    if (!dateInfo) continue;

    const ok = textGroupKey(orderClientRaw);
    const orderClient = ok
      ? (orderKeyToLabel.get(ok) || normalizeTextLabel(orderClientRaw) || orderClientRaw)
      : '(未分類)';

    const oRawForO = (vals[COL_ORDER] && vals[COL_ORDER].trim()) || '';
    const bRawForO = (vals[COL_BRANCH] && vals[COL_BRANCH].trim()) || '';
    let fullO = '';
    if (oRawForO) fullO = normalizeTextLabel(oRawForO) || oRawForO;
    else {
      const ex2 = extractNameFromBranchRaw(bRawForO);
      if (ex2) fullO = normalizeTextLabel(ex2) || ex2;
    }
    let orderer;
    if (!fullO) {
      orderer = ordererStableToLabel.get('___NO_ORDERER___') || ORDERER_NONE_LABEL;
    } else {
      const su = toSurnameFromFullName(fullO);
      const stK = ordererStableKeyFromSurname(su);
      orderer = ordererStableToLabel.get(stK) || ORDERER_SAME_PREFERRED[stK] || su;
    }

    const branchCompany = companyFromBranchName(branch) || branch;

    const address1 = normalizeTextLabel(vals[COL_ADDR1] ?? '') || '';
    const prefecture = inferPrefectureFromAddress1(address1);
    const phoneSearchStr = pNorm || pDigits;

    rows.push({
      date: dateVal,
      fiscalYear: dateInfo.fiscalYear,
      month: dateInfo.month,
      /** 納品日の暦年（年度開始月を変えたときの会計年度キー再計算用） */
      year: dateInfo.year,
      leaseCompany: lease,
      orderer,
      orderClient,
      branch,
      branchCompany,
      address1: address1 || '',
      deliveryPhone: phone || '',
      phoneSearchStr,
      prefecture,
      productCode,
      productName,
      item: item || '(未分類)',
      slipNo:       vals[COL_SLIP]?.trim()      || '',
      slipType:     vals[COL_SLIP_TYPE]?.trim() || '',
      receiverName: vals[COL_RECV_NAME]?.trim() || '',
      makerCode:    vals[COL_MAKER]?.trim()     || '',
      unitPrice,
      quantity: qty,
      sales,
      profit,
      rawRow: [...vals],
    });
  }

  const yearsSet = new Set();
  const leaseSet = new Set();
  rows.forEach(r => {
    if (r.fiscalYear) yearsSet.add(Number(r.fiscalYear));
    if (r.leaseCompany) leaseSet.add(r.leaseCompany);
  });

  return {
    rows,
    csvHeaders: headers,
    years: Array.from(yearsSet).sort((a, b) => a - b),
    leaseCompanies: Array.from(leaseSet).sort(),
  };
}
