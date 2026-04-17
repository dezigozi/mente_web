/**
 * データ集計ユーティリティ（メンテ実績レポート用）
 * profit（粗利）と quantity（受注数）のみ集計
 */

export function filterRows(rows, { leaseCompany, startMonth, endMonth }) {
  return rows.filter(row => {
    if (leaseCompany && leaseCompany !== 'ALL') {
      if (row.leaseCompany !== leaseCompany) return false;
    }
    if (startMonth && endMonth && row.month) {
      const sm = parseInt(startMonth);
      const em = parseInt(endMonth);
      const m = row.month;
      if (sm <= em) {
        if (m < sm || m > em) return false;
      } else {
        if (m < sm && m > em) return false;
      }
    }
    return true;
  });
}

/**
 * 第1階層: 部店別集計
 */
export function aggregateByBranch(rows, years) {
  const map = {};
  rows.forEach(row => {
    const key = row.branch || '(未分類)';
    if (!map[key]) {
      map[key] = { name: key, profit: {}, quantity: {} };
      years.forEach(y => { map[key].profit[y] = 0; map[key].quantity[y] = 0; });
    }
    if (row.fiscalYear && years.includes(row.fiscalYear)) {
      map[key].profit[row.fiscalYear]   += row.profit   || 0;
      map[key].quantity[row.fiscalYear] += row.quantity || 0;
    }
  });
  return Object.values(map).sort((a, b) => {
    const latestYear = years[years.length - 1];
    return (b.profit[latestYear] || 0) - (a.profit[latestYear] || 0);
  });
}

/**
 * 第2階層（リーフ）: アイテム別集計（指定部店内）
 */
export function aggregateByItem(rows, years, branchName) {
  const filtered = rows.filter(r => r.branch === branchName);
  const map = {};
  filtered.forEach(row => {
    const key = row.item || '(未分類)';
    if (!map[key]) {
      map[key] = { name: key, profit: {}, quantity: {} };
      years.forEach(y => { map[key].profit[y] = 0; map[key].quantity[y] = 0; });
    }
    if (row.fiscalYear && years.includes(row.fiscalYear)) {
      map[key].profit[row.fiscalYear]   += row.profit   || 0;
      map[key].quantity[row.fiscalYear] += row.quantity || 0;
    }
  });
  return Object.values(map).sort((a, b) => {
    const latestYear = years[years.length - 1];
    return (b.profit[latestYear] || 0) - (a.profit[latestYear] || 0);
  });
}

/**
 * 明細CSV生成
 */
export function generateDetailCsvContent(rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = ['メンテ', '部店', 'アイテム', '日付', '受注数', '粗利'];
  const lines = [headers.map(q).join(',')];
  rows.forEach(row => {
    lines.push([
      q(row.leaseCompany ?? ''),
      q(row.branch ?? ''),
      q(row.item ?? ''),
      q(row.date ?? ''),
      row.quantity ?? 0,
      row.profit ?? 0,
    ].join(','));
  });
  return lines.join('\r\n');
}

/**
 * 前年比計算
 */
export function calcYoY(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev) * 100).toFixed(1);
}

/**
 * 金額フォーマット（短縮）
 */
export function formatCurrency(val) {
  if (val === 0 || val === null || val === undefined) return '¥0';
  const absVal = Math.abs(val);
  if (absVal >= 100000000) return `¥${(val / 100000000).toFixed(1)}億`;
  if (absVal >= 10000) return `¥${(val / 10000).toFixed(0)}万`;
  return `¥${val.toLocaleString()}`;
}

/**
 * 金額フォーマット（詳細）
 */
export function formatCurrencyFull(val) {
  if (val === 0 || val === null || val === undefined) return '¥0';
  return `¥${Math.round(val).toLocaleString()}`;
}
