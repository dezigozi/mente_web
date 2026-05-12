import { inferPrefectureFromAddress1 } from './jpPrefecture.js';
import { deliveryDateCalendarParts } from './deliveryDateParts.js';

/**
 * CSVローダー
 * master_data.csv（日本語ヘッダー）を読み込み、内部フィールド名にマッピング
 *
 * 列マッピング:
 *   B列: 納品日 → date
 *   K列: 注文者名（ヘッダー名）→ orderer（＋M列送り先から補完可）
 *   宅配先電話→送り先: 行の正規化
 *   M列相当: 送り先名 → branch（工場/部店）
 *   AH列(分析名(大)): 分析        → item（集計用・ダッシュ分析名）
 *   数量・粗利・メンテ: 列名マップ（Excel例: 数量=AN, 粗利=AO, メンテ=AQ=42）
 *   得意先名: 注文社名（注文元） → orderClient
 *
 * 送り先名・注文社名:
 *   NFKC・全半角スペース等を統一し、同一キー（スペース除去＋同表示）で集約。
 *   漢字とカタカナ等の表記違いは同じ扱いにしない（要マスタ等）。
 *   同一の宅配先電話番号（数字のみ比較）は、先に出た送り先名表記に合わせる。
 *
 * 注文者（K列: 注文者名、M列: 送り先名から補完）:
 *   注文者名に値があれば優先（正規化・同一表記合流）
 *   空のとき送り先名の空白区切り最後のトークンを「名前候補」として利用（例: 会社名 秋本 → 秋本）
 *
 * 工場＝社名: 送り先の最後のトークンを除いた表記（例: モービル(株) 秋本 → モービル(株)）
 * 注文者: 名字に短縮 + 下記 ORDERER_SAME_* の手動同一化（漢字とかなの完全自動照合は行っていない）
 * 住所１: 都道府県（絞り込み用）
 * 宅配先電話: 0欠落9〜10桁補完・+81正規化（比較用 phoneSearchStr）
 */

const ORDERER_NONE_LABEL = '(注文者未登録)';

/**
 * 表示用: 半角全角・曖昧スペース等を整える（NFKC + 空白の統一）
 * @param {string|null|undefined} s
 */
export function normalizeTextLabel(s) {
  if (s == null) return '';
  const t = String(s).trim().normalize('NFKC');
  if (!t) return '';
  return t
    .replace(/[\s\u3000\u00A0\u2000-\u200B\ufeff]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * 集計・合流用: 上記のうち空白を全除去したキー（スペース違いを同一扱い）
 * @param {string|null|undefined} s
 */
export function textGroupKey(s) {
  return normalizeTextLabel(s).replace(/\s/g, '');
}

/**
 * 送り先名を工場＝社名表示用に（最後の空白区切り1トークンを除く。1語のみはそのまま）
 */
export function companyFromBranchName(branchStr) {
  if (branchStr == null) return '';
  const t = normalizeTextLabel(String(branchStr));
  if (!t) return t;
  const parts = t.split(/[\s\u3000]+/).filter(Boolean);
  if (parts.length < 2) return t;
  return parts.slice(0, -1).join(' ');
}

/**
 * 氏名風の文字列 → 名字。スペースがあれば先頭、連続4字以上は先頭2字を姓とみなす
 */
export function toSurnameFromFullName(s) {
  if (s == null || s === ORDERER_NONE_LABEL) return s || '';
  const t = normalizeTextLabel(String(s));
  if (!t) return t;
  const p = t.split(/[\s\u3000]+/).filter(Boolean);
  if (p.length > 1) return p[0];
  const one = p[0];
  if (one.length <= 2) return one;
  if (one.length === 3) {
    const kana = /^[\u30A0-\u30FF\u3040-\u309F\u3000\u30FC]+$/u.test(one.replace(/\s/g, ''));
    if (kana) return one;
    return one.slice(0, 2);
  }
  if (one.length >= 4) return one.slice(0, 2);
  return one;
}

/** 名字表記揺れ → 内部同一キー（要望に応じて拡張） */
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

/**
 * 送り先名の空白区切り最後のトークン（注文者名が空のときの補完。例: 会社 秋本 → 秋本）
 * @param {string} branchStr
 */
export function extractNameFromBranchRaw(branchStr) {
  if (branchStr == null || !String(branchStr).trim()) return '';
  const t = normalizeTextLabel(String(branchStr));
  if (!t) return '';
  const parts = t.split(/[\s\u3000]+/).filter(Boolean);
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1];
  if (last.length > 32) return '';
  if (/(?:御|ご)?担当|社長|部長/.test(last) && last.length < 5) return '';
  return last;
}

/** 電話番号の揺れ吸収: 比較は数字列のみ */
export function phoneDigitsKey(phone) {
  if (phone == null) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * 国内向け: マスタに先頭0がない9〜10桁を補完。+81…は 0… に寄せる（絞り込み・候補用）
 * @param {string|null|undefined} phone
 */
export function normalizeJapanPhoneDigits(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('81') && d.length >= 11) d = `0${d.slice(2)}`;
  else if (!d.startsWith('0') && d.length >= 9 && d.length <= 10) d = `0${d}`;
  return d;
}

/**
 * 現在の表示フィルタに合致した行を、元CSVのヘッダー＋全列のまま出力。
 * 末尾に「年」「月」「年月」（納品日ベース・マスタ読込時と同じ暦年／月）を付与する。
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

/** public/data 以下の CSV への URL（先頭が // にならないよう正規化） */
function publicDataUrl(filename) {
  let base = import.meta.env.BASE_URL ?? '/';
  if (typeof base !== 'string' || base === '') base = '/';
  if (!base.endsWith('/')) base = `${base}/`;
  return `${base}data/${filename}`;
}

/** 同一オリジン: prebuild（MASTER_CSV_BUNDLE_URL）で public/data に置いた CSV がビルドに含まれる */
function masterCsvPathRel() {
  return publicDataUrl('master_data.csv');
}

export async function loadCsvData() {
  const p = masterCsvPathRel();
  const response = await fetch(p);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}（${p}）`);
  }
  const csv = await response.text();
  return parseCsv(csv);
}

function parseCsv(csv) {
  const lines = csv.trim().split('\n').filter(line => line.trim());
  if (lines.length === 0) throw new Error('CSVファイルが空です');

  const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^\uFEFF/, ''));

  // ヘッダー名→インデックスマップ（日本語列名に対応）
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

  // 第1パス: 送り先名・注文先の「初出表記」を key に紐づけ（同じ文字＝スペース違いなどで一つにまとめる）
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

  // 第2パス: 電話番号（数字のみ＋0補完）→ 送り先の初出正規化表記
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
      /** 住所１列（都道府県＋以降。工場名横表示用） */
      address1: address1 || '',
      /** 送り先の宅配先電話（表示・絞り込み用。数字正規化は phoneSearchStr） */
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
      /** 元CSV1行分（全列。ダウンロード用） */
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
    /** 元ファイル1行目の全ヘッダー名（列順） */
    csvHeaders: headers,
    years: Array.from(yearsSet).sort((a, b) => a - b),
    leaseCompanies: Array.from(leaseSet).sort(),
  };
}

/**
 * カレンダー年月 → 会計年度用の { fiscalYear, month, year }（4月始まりの基準年度、月は 1〜12）
 * 1–3 月は fiscalYear = 前年度。year は常に暦の西暦年（UI で年度開始月を変えるときの再分類に使用）。
 * @param {number} y 西暦
 * @param {number} m 月
 */
function fiscalYearMonthFromCalendar(y, m) {
  if (m < 1 || m > 12 || y < 1000 || y > 3000) return null;
  return { fiscalYear: m >= 4 ? y : y - 1, month: m, year: y };
}

/**
 * 納品日（B列想定）を { fiscalYear, month } に変換する。
 *
 * 【不具合の例】以前は文字列 "2023" だけのセルが、後段で `parseFloat` され
 * 数値 2023 = Excel 日目（1900-01-01 から 2023 日後）と解釈され、画面上に
 * 「1905年度」のような偽の年度列が出ていた（マスタ上は B 列に 1900年代が無いのに
 * 集計される）。
 *
 * 【方針】
 * 1) 4桁の年単独・"2023.0" 風の表記は「会計上の年」として 4 月扱いで採用。
 * 2) YYYY/M/D および M/D/YYYY を分岐。
 * 3) どうしても純粋数値の Excel シリアルにする場合のみ 1900 年起点計算。変換後の
 *    西暦が 1980 未満なら不採用（上記誤解釈の 1900年代を落とす）。納品実務上の下限。
 */
function parseDate(dateValue) {
  if (dateValue == null || String(dateValue).trim() === '') return null;

  if (typeof dateValue === 'string' && dateValue) {
    const datePart = dateValue.split(' ')[0].trim();
    // CSV が年だけ "2023" のとき: Excel 日目扱いに回さない（＝ 1900年代年度バグの根）
    if (/^\d{4}$/.test(datePart)) {
      const y = Number(datePart);
      if (y >= 1980 && y <= 2100) {
        // 月不明のため会計上「その年の 4 月」扱い（4 月始まり会計用の代表月）
        return fiscalYearMonthFromCalendar(y, 4);
      }
    }
    const parts = datePart.split(/[-\/]/).map(Number);
    if (parts.length === 3) {
      const [a, b, c] = parts;
      if (a > 1900 && a < 3000 && b >= 1 && b <= 12) {
        // 日本式: 2023/4/1 または 2023-4-1
        return fiscalYearMonthFromCalendar(a, b);
      }
      if (c > 1900 && c < 3000 && a >= 1 && a <= 12 && b >= 1 && b <= 31) {
        // 4/1/2023 形式（英ロケのエクスポート用）
        return fiscalYearMonthFromCalendar(c, a);
      }
    }
  }

  const asStr = typeof dateValue === 'string' ? dateValue.trim() : null;
  const num = typeof dateValue === 'number' ? dateValue : parseFloat(String(dateValue));
  if (isNaN(num) || num <= 0) return null;

  // Excel 数値セルが 2023 のように「年だけ」来たとき（".0" 付き含む）も日目扱いしない
  if (asStr && /^\d{4}(?:\.0+)?$/.test(asStr.trim())) {
    const intY = Math.round(num);
    if (intY >= 1980 && intY <= 2100 && Math.abs(num - intY) < 1e-6) {
      return fiscalYearMonthFromCalendar(intY, 4);
    }
  }

  // ここまで来た純粋数値は Excel シリアル（例: エクスポートで日付が数値のみ）とみなす
  const excelEpoch = new Date(1900, 0, -1);
  const date = new Date(excelEpoch.getTime() + num * 86400000);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  if (m < 1 || m > 12) return null;
  if (y < 1980 || y > 2100) return null; // 誤パースで出た 1900年代を捨てる
  return fiscalYearMonthFromCalendar(y, m);
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

/**
 * tab_data.csv を読み込み、タブ価格マップと適用日マップを返す。
 * - tabMap        : Map<リース会社, Map<品番, TAB価格>>
 * - applicableDates: Map<リース会社, {year, month, day}> — リース会社ごとの最新適用日
 * 同じ（リース会社, 品番）が複数行ある場合は後勝ち（CSV末尾が最新想定）。
 * @returns {Promise<{ tabMap: Map<string, Map<string, number>>, applicableDates: Map<string, {year:number,month:number,day:number}> }>}
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

  const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^\uFEFF/, ''));
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  const COL_LEASE      = idx['メンテ']      ?? 0;
  const COL_CODE       = idx['品番']        ?? 1;
  const COL_MAKER_CODE = idx['メーカーコード'] ?? 2;
  const COL_PRICE      = idx['TAB価格']     ?? 3;
  const COL_DATE       = idx['適用日']      ?? 4;

  /**
   * tabMap: Map<lease, Map<code, { price: number, makerCode: string, dateStr: string }>>
   * applicableDates: Map<lease, { year, month, day }> — リース会社ごとの最新適用日
   */
  const tabMap = new Map();
  /** @type {Map<string, {year:number,month:number,day:number}>} */
  const applicableDates = new Map();

  for (let i = 1; i < lines.length; i++) {
    const vals      = parseCSVLine(lines[i]);
    const lease     = vals[COL_LEASE]?.trim()      || '';
    const code      = vals[COL_CODE]?.trim()       || '';
    const makerCode = vals[COL_MAKER_CODE]?.trim() || '';
    const price     = parseFloat(vals[COL_PRICE]?.trim()) || 0;
    const dateStr   = vals[COL_DATE]?.trim()       || '';
    if (!lease || !code) continue;

    if (!tabMap.has(lease)) tabMap.set(lease, new Map());
    tabMap.get(lease).set(code, { price, makerCode, dateStr });

    // 適用日 "2026年4月2日" をパース → リース会社ごとの最新日を保持
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
