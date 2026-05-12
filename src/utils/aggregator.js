import { deliveryDateCalendarParts } from './csvLoader.js';

/**
 * データ集計ユーティリティ（メンテ実績レポート用）
 * profit（粗利）・quantity（受注数）・sales（売上）を集計。粗利率は UI 側で profit/sales
 *
 * 月範囲の判定: rowInFiscalMonthRange / filterRowsInMonthRange は、UI 側で
 * 期間の全行1周だけに使う。filterRows() は従来どおり併用可（挙動は同じ月ロジック）。
 */

/**
 * 会計期間上の月範囲（跨年度: start>end）に行が入るか。月なし行は従来どおり月フィルタ外。
 * @param {{ month?: number }} row
 * @param {string|number|undefined} startMonth
 * @param {string|number|undefined} endMonth
 */
export function rowInFiscalMonthRange(row, startMonth, endMonth) {
  if (!startMonth || !endMonth) return true;
  if (!row?.month) return true;
  const sm = parseInt(String(startMonth), 10);
  const em = parseInt(String(endMonth), 10);
  const m = row.month;
  if (sm <= em) {
    if (m < sm || m > em) return false;
  } else {
    if (m < sm && m > em) return false;
  }
  return true;
}

/**
 * 月範囲だけを適用（期間1回走査用に App から利用）
 */
export function filterRowsInMonthRange(rows, startMonth, endMonth) {
  if (!startMonth || !endMonth) return rows;
  return rows.filter((row) => rowInFiscalMonthRange(row, startMonth, endMonth));
}

/**
 * @param {object} p
 * @param {string} [p.leaseCompany] 単一（従来）。'ALL' は未指定扱い
 * @param {string[]} [p.leaseCompanies] 複数メンテ（OR）。空 or 未指定＝全件
 * @param {string[]} [p.orderClients] 得意先名(列E)。空 or 未指定＝全件
 */
export function filterRows(rows, { leaseCompany, leaseCompanies, orderClients, startMonth, endMonth } = {}) {
  return rows.filter((row) => {
    if (leaseCompanies && leaseCompanies.length) {
      const lc = row.leaseCompany ?? '';
      if (!leaseCompanies.includes(lc)) return false;
    } else if (leaseCompany && leaseCompany !== 'ALL') {
      if (row.leaseCompany !== leaseCompany) return false;
    }
    if (orderClients && orderClients.length) {
      const o = row.orderClient ?? '(未分類)';
      if (!orderClients.includes(o)) return false;
    }
    if (!rowInFiscalMonthRange(row, startMonth, endMonth)) return false;
    return true;
  });
}

// ===== 新階層集計関数 =====

function aggregateByField(rows, years, keyFn, { sortBy = 'profit' } = {}) {
  const map = {};
  rows.forEach(row => {
    const key = keyFn(row) || '(未分類)';
    if (!map[key]) {
      map[key] = { name: key, profit: {}, quantity: {}, sales: {} };
      years.forEach(y => {
        map[key].profit[y] = 0;
        map[key].quantity[y] = 0;
        map[key].sales[y] = 0;
      });
    }
    if (row.fiscalYear && years.includes(row.fiscalYear)) {
      const fy = row.fiscalYear;
      map[key].profit[fy]   += row.profit   || 0;
      map[key].quantity[fy] += row.quantity || 0;
      map[key].sales[fy]    += row.sales     || 0;
    }
  });
  return Object.values(map).sort((a, b) => {
    const latestYear = years[years.length - 1];
    if (sortBy === 'quantity') {
      return (b.quantity[latestYear] || 0) - (a.quantity[latestYear] || 0);
    }
    return (b.profit[latestYear] || 0) - (a.profit[latestYear] || 0);
  });
}

/** Level 1 (両パターン共通): リース会社別 */
export function aggregateByLease(rows, years) {
  return aggregateByField(rows, years, r => r.leaseCompany);
}

/** Pattern A Level 2: 分類別（リース会社内） */
export function aggregateByItemForLease(rows, years, leaseCo) {
  return aggregateByField(
    rows.filter(r => (r.leaseCompany || '(未分類)') === leaseCo),
    years, r => r.item
  );
}

/** パターンBの工場キー（送り先から社名。送り先末尾の拠点・担当者名相当を除いたもの） */
function factoryKeyB(row) {
  return (row.branchCompany || row.branch || '(未分類)');
}

/**
 * パターンB Level1: 工場別
 */
export function aggregateByBranchB(rows, years) {
  return aggregateByField(rows, years, factoryKeyB, { sortBy: 'quantity' });
}

/**
 * パターンB（工場→注文者）: 工場内の注文者別
 */
export function aggregateByOrdererForFactory(rows, years, factory) {
  return aggregateByField(
    rows.filter(r => factoryKeyB(r) === factory),
    years, r => r.orderer, { sortBy: 'quantity' }
  );
}

/**
 * パターンB（工場→メンテ→分析名(大)）: 工場内のメンテ列（AQ＝leaseCompany）別
 */
export function aggregateByMenteUnderFactory(rows, years, factory) {
  return aggregateByField(
    rows.filter(r => factoryKeyB(r) === factory),
    years, r => r.leaseCompany, { sortBy: 'quantity' }
  );
}

/**
 * パターンB 工場＋メンテ内: 分析名(大) 別
 */
export function aggregateByItemUnderFactoryMente(rows, years, factory, mente) {
  return aggregateByField(
    rows.filter(
      r =>
        factoryKeyB(r) === factory &&
        (r.leaseCompany || '(未分類)') === mente
    ),
    years,
    r => r.item,
    { sortBy: 'quantity' }
  );
}

/**
 * @deprecated 旧「工場→注文者→…」4階層用。新パターンは aggregateByMenteUnderFactory を使用
 * パターンB: 工場+注文者内のメンテ列（AQ）別
 */
export function aggregateByMenteForFactoryOrderer(rows, years, factory, orderer) {
  return aggregateByField(
    rows.filter(r =>
      factoryKeyB(r) === factory &&
      (r.orderer  || '(注文者未登録)') === orderer
    ),
    years, r => r.leaseCompany, { sortBy: 'quantity' }
  );
}

/**
 * @deprecated 旧4階層用。新は aggregateByItemUnderFactoryMente
 * 工場+注文者+メンテ内の分析名(大)別
 */
export function aggregateByItemForFactoryMente(rows, years, factory, orderer, mente) {
  return aggregateByField(
    rows.filter(r =>
      factoryKeyB(r) === factory &&
      (r.orderer        || '(注文者未登録)') === orderer &&
      (r.leaseCompany   || '(未分類)') === mente
    ),
    years, r => r.item, { sortBy: 'quantity' }
  );
}

/** Leaf (両パターン共通): 品番別 */
export function aggregateByProductCode(rows, years, { leaseCo, branch, item }) {
  let filtered = rows;
  if (leaseCo) filtered = filtered.filter(r => (r.leaseCompany || '(未分類)') === leaseCo);
  if (branch)  filtered = filtered.filter(r => (r.branch       || '(未分類)') === branch);
  if (item)    filtered = filtered.filter(r => (r.item         || '(未分類)') === item);
  return aggregateByField(filtered, years, r => r.productCode);
}

// ===== 旧集計関数（後方互換） =====

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
 * 明細CSV生成（日付の次に納品日由来の年・月・年月を付与）
 */
export function generateDetailCsvContent(rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = ['メンテ', '部店', '注文者', 'アイテム', '日付', '年', '月', '年月', '受注数', '粗利'];
  const lines = [headers.map(q).join(',')];
  rows.forEach(row => {
    const { year, month, yearMonth } = deliveryDateCalendarParts(row);
    lines.push([
      q(row.leaseCompany ?? ''),
      q(row.branchCompany || row.branch || ''),
      q(row.orderer ?? ''),
      q(row.item ?? ''),
      q(row.date ?? ''),
      q(year),
      q(month),
      q(yearMonth),
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
