/**
 * CSVローダー
 * master_data.csv（日本語ヘッダー）を読み込み、内部フィールド名にマッピング
 *
 * 列マッピング:
 *   B列(idx1):  納品日       → date / fiscalYear / month
 *   K列(idx10): 宅配先電話番号 → branchPhone（部店名の正規化キー）
 *   L列(idx11): 送り先名      → branch（部店）
 *   AG列(idx32): 分析名(大)   → item（アイテム）
 *   AN列(idx39): 数量         → quantity（受注数）
 *   AO列(idx40): 粗利         → profit（金額）
 *   AP列(idx41): メンテ        → leaseCompany（リース会社）
 */

export async function loadCsvData() {
  const response = await fetch('/data/master_data.csv');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
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

  const COL_DATE   = idx['納品日']        ?? 1;
  const COL_PHONE  = idx['宅配先電話番号'] ?? 10;
  const COL_BRANCH = idx['送り先名']      ?? 11;
  const COL_CODE   = idx['品番']          ?? 30;
  const COL_NAME   = idx['商品名']        ?? 31;
  const COL_ITEM   = idx['分析名(大)']    ?? 32;
  const COL_PRICE  = idx['単価']          ?? 38;
  const COL_QTY    = idx['数量']          ?? 39;
  const COL_PROFIT = idx['粗利']          ?? 40;
  const COL_LEASE  = idx['メンテ']        ?? 41;

  // 第1パス: 電話番号→送り先名の正規化マップを構築
  const phoneBranchMap = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const phone  = vals[COL_PHONE]?.trim();
    const branch = vals[COL_BRANCH]?.trim();
    if (phone && branch && !phoneBranchMap[phone]) {
      phoneBranchMap[phone] = branch;
    }
  }

  // 第2パス: 行データを構築
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);

    const dateVal     = vals[COL_DATE]?.trim();
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

    // 電話番号で正規化した部店名（同一電話番号は同じ部店として扱う）
    const branch = (phone && phoneBranchMap[phone]) || branchRaw || '(未分類)';

    const dateInfo = parseDate(dateVal);
    if (!dateInfo) continue;

    rows.push({
      date: dateVal,
      fiscalYear: dateInfo.fiscalYear,
      month: dateInfo.month,
      leaseCompany: lease,
      branch,
      productCode,
      productName,
      item: item || '(未分類)',
      quantity: qty,
      sales,
      profit,
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
    years: Array.from(yearsSet).sort((a, b) => a - b),
    leaseCompanies: Array.from(leaseSet).sort(),
  };
}

/**
 * 日付パース: テキスト形式 or Excelシリアル番号 → { fiscalYear, month }
 */
function parseDate(dateValue) {
  if (typeof dateValue === 'string' && dateValue) {
    const datePart = dateValue.split(' ')[0];
    const parts = datePart.split(/[-\/]/).map(Number);
    if (parts.length === 3) {
      const [year, month] = parts;
      if (year > 1900 && month >= 1 && month <= 12) {
        return { fiscalYear: month >= 4 ? year : year - 1, month };
      }
    }
  }

  const num = typeof dateValue === 'number' ? dateValue : parseFloat(dateValue);
  if (!isNaN(num) && num > 0) {
    const excelEpoch = new Date(1900, 0, -1);
    const date = new Date(excelEpoch.getTime() + num * 86400000);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (month >= 1 && month <= 12) {
      return { fiscalYear: month >= 4 ? year : year - 1, month };
    }
  }

  return null;
}

function parseCSVLine(line) {
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
