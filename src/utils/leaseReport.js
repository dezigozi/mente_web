/**
 * リース会社別レポート: 工場別リビルト実績 / 得意先（支店）別 オルタ・スターター・コンプレッサー利用（純関数のみ）
 *
 * - 対象は分析名(大)がオルタネーター・スターター・コンプレッサーの行（MAX・他社リビルト等の分析名(中)は内訳として持つ）
 * - 数字は数量（本数）。年度は4月始まり（2025年度 = 2025/4〜2026/3）
 * - 最新年度がデータ途中なら、前年比は前年の同じ月までと比べる
 * - 工場は送り先から作った社名（branchCompany）で束ねる（NCS訪問管理と同じキー）
 */

export const REBUILD_ITEMS = ['オルタネーター', 'スターター', 'コンプレッサー'];
const REBUILD_ITEM_SET = new Set(REBUILD_ITEMS);

/** オリックスの西日本管轄（得意先名の部分一致） */
export const WEST_ORIX_CLIENT_KEYWORDS = ['大阪', '広島', '高松', '福岡', '名古屋'];
export const ORIX_LEASE = 'OR';

const normText = s => String(s ?? '').normalize('NFKC').trim();
const factoryKeyOf = r => r.branchCompany || r.branch || '(未分類)';

/** 4月始まりの年度 */
export function fiscalYearApr(y, m) {
  return m >= 4 ? y : y - 1;
}

/** 年度内の月の並び（4月=0 … 3月=11） */
export function fiscalMonthIndex(m) {
  return (m + 8) % 12;
}

/** 年度内の月の並び → 暦の月 */
export function monthOfFiscalIndex(fm) {
  return ((fm + 3) % 12) + 1;
}

/**
 * 全行を1回だけ走査して、リース会社ごとに「得意先 × 工場 × 年度 × 月 × 品目 × 分析名(中)」の本数をまとめる
 * @returns {{ leases: Map<string, Map<string, object>>, factories: Map<string, object>, lastFy: number, lastFm: number }}
 */
export function buildLeaseReportIndex(rows) {
  const leases = new Map();
  const factories = new Map();
  let lastYm = 0;
  for (const r of rows) {
    const item = normText(r.item);
    if (!REBUILD_ITEM_SET.has(item)) continue;
    const y = Number(r.year), m = Number(r.month);
    if (!y || !m) continue;
    const q = Number(r.quantity) || 0;
    if (!q) continue;
    const ym = y * 100 + m;
    if (ym > lastYm) lastYm = ym;

    const lease = r.leaseCompany || '(未分類)';
    const client = r.orderClient || '(未分類)';
    const factory = factoryKeyOf(r);
    const mid = normText(r.itemMid) || '(なし)';
    const fy = fiscalYearApr(y, m);
    const fm = fiscalMonthIndex(m);

    let cells = leases.get(lease);
    if (!cells) { cells = new Map(); leases.set(lease, cells); }
    const k = `${client}\t${factory}\t${fy}\t${fm}\t${item}\t${mid}`;
    const c = cells.get(k);
    if (c) c.qty += q;
    else cells.set(k, { client, factory, fy, fm, item, mid, qty: q });

    if (factory !== '(未分類)') {
      let f = factories.get(factory);
      if (!f) { f = { key: factory, pref: '', address: '' }; factories.set(factory, f); }
      if (!f.pref && r.prefecture) f.pref = r.prefecture;
      if (!f.address && r.address1) f.address = String(r.address1).trim();
    }
  }
  const lastY = Math.floor(lastYm / 100), lastM = lastYm % 100;
  return {
    leases,
    factories,
    lastFy: lastYm ? fiscalYearApr(lastY, lastM) : 0,
    lastFm: lastYm ? fiscalMonthIndex(lastM) : 11,
  };
}

/** 得意先名から会社名を外して課名だけに（「オリックス自動車(株)大阪フロント課」→「大阪フロント課」） */
export function shortClientName(name) {
  const t = normText(name);
  const m = t.match(/^.*?(?:\(株\)|\(有\)|株式会社)\s*(.+)$/);
  return m && m[1].trim() ? m[1].trim() : t;
}

/** リース会社の得意先一覧（本数の多い順） */
export function listClients(index, lease) {
  const m = new Map();
  index.leases.get(lease)?.forEach(c => m.set(c.client, (m.get(c.client) || 0) + c.qty));
  return [...m].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
}

/** 得意先チップの初期選択（オリックスは西日本の支店、他は空＝全部） */
export function defaultClientSelection(index, lease) {
  if (lease !== ORIX_LEASE) return new Set();
  return new Set(listClients(index, lease)
    .map(c => c.name)
    .filter(n => WEST_ORIX_CLIENT_KEYWORDS.some(w => n.includes(w))));
}

/** 年度別の本数＋最新年度の前年同期間 */
const newSeries = () => ({ byFy: new Map(), prevSame: 0 });
function addTo(s, c, lastFy, lastFm) {
  s.byFy.set(c.fy, (s.byFy.get(c.fy) || 0) + c.qty);
  if (c.fy === lastFy - 1 && c.fm <= lastFm) s.prevSame += c.qty;
}

/** 表示の年度一覧と、最新年度が途中かどうか */
function yearsInfo(index, cells) {
  const set = new Set();
  cells.forEach(c => set.add(c.fy));
  const years = [...set].sort((a, b) => a - b);
  const partial = years.includes(index.lastFy) && index.lastFm < 11;
  return { years, lastFy: index.lastFy, partial, lastMonth: monthOfFiscalIndex(index.lastFm) };
}

/** 前年比の比べる相手（途中の最新年度は前年同期間） */
export function prevBase(series, fy, info) {
  if (info.partial && fy === info.lastFy) return series.prevSame;
  return series.byFy.get(fy - 1) || 0;
}

function selectedCells(index, lease, clients) {
  const all = index.leases.get(lease);
  if (!all) return [];
  const out = [];
  all.forEach(c => { if (!clients || clients.size === 0 || clients.has(c.client)) out.push(c); });
  return out;
}

const sumAll = s => { let t = 0; s.byFy.forEach(v => { t += v; }); return t; };

/**
 * 工場別リビルト実績
 * @param {Set<string>|null} clients 対象の得意先（空 or null = 全部）
 */
export function summarizeFactories(index, lease, clients) {
  const cells = selectedCells(index, lease, clients);
  const info = yearsInfo(index, cells);
  const { lastFy, lastFm } = index;
  const map = new Map();
  const total = newSeries();
  const totalItems = new Map(REBUILD_ITEMS.map(it => [it, newSeries()]));
  for (const c of cells) {
    let f = map.get(c.factory);
    if (!f) {
      const fi = index.factories.get(c.factory);
      f = {
        key: c.factory, pref: fi?.pref || '', address: fi?.address || '',
        clientQty: new Map(), total: newSeries(),
        items: new Map(REBUILD_ITEMS.map(it => [it, newSeries()])), mids: new Map(),
      };
      map.set(c.factory, f);
    }
    f.clientQty.set(c.client, (f.clientQty.get(c.client) || 0) + c.qty);
    addTo(f.total, c, lastFy, lastFm);
    addTo(f.items.get(c.item), c, lastFy, lastFm);
    const mk = `${c.item}\t${c.mid}`;
    if (!f.mids.has(mk)) f.mids.set(mk, { item: c.item, mid: c.mid, series: newSeries() });
    addTo(f.mids.get(mk).series, c, lastFy, lastFm);
    addTo(total, c, lastFy, lastFm);
    addTo(totalItems.get(c.item), c, lastFy, lastFm);
  }
  const rows = [...map.values()].map(f => ({
    key: f.key,
    pref: f.pref,
    address: f.address,
    clients: [...f.clientQty].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    total: f.total,
    items: f.items,
    mids: [...f.mids.values()].sort((a, b) =>
      REBUILD_ITEMS.indexOf(a.item) - REBUILD_ITEMS.indexOf(b.item) || sumAll(b.series) - sumAll(a.series)),
    sum: sumAll(f.total),
  }));
  rows.sort((a, b) => b.sum - a.sum || a.key.localeCompare(b.key, 'ja'));
  return { info, rows, total, totalItems };
}

/** 得意先（支店）別 オルタ・スターター・コンプレッサー利用 */
export function summarizeClients(index, lease, clients) {
  const cells = selectedCells(index, lease, clients);
  const info = yearsInfo(index, cells);
  const { lastFy, lastFm } = index;
  const map = new Map();
  const total = newSeries();
  const totalItems = new Map(REBUILD_ITEMS.map(it => [it, newSeries()]));
  for (const c of cells) {
    let x = map.get(c.client);
    if (!x) {
      x = { client: c.client, total: newSeries(), items: new Map(REBUILD_ITEMS.map(it => [it, newSeries()])) };
      map.set(c.client, x);
    }
    addTo(x.total, c, lastFy, lastFm);
    addTo(x.items.get(c.item), c, lastFy, lastFm);
    addTo(total, c, lastFy, lastFm);
    addTo(totalItems.get(c.item), c, lastFy, lastFm);
  }
  const rows = [...map.values()].map(x => ({ ...x, sum: sumAll(x.total) }));
  rows.sort((a, b) => b.sum - a.sum || a.client.localeCompare(b.client, 'ja'));
  return { info, rows, total, totalItems };
}
