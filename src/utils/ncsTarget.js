/**
 * NCS訪問管理: ターゲット工場の抽出と、訪問後の受注チェック（純関数のみ）
 *
 * - 年度は10月始まり（2025年度 = 2025/10〜2026/9）。工場別 年次実績比較の画面と同じ区切り
 * - 受注数は quantity の合計。対象行は呼び出し側の itemOk（分析名(大)の許容4分類）で絞る
 * - 工場は送り先から作った社名（branchCompany）で束ねる。電話番号は名前が変わったときの控え
 */

export const NCS = 'NCS';
export const FY_START_MONTH = 10;

const normText = s => String(s ?? '').normalize('NFKC').trim();
const factoryKey = r => r.branchCompany || r.branch || '(未分類)';

/** 'YYYY/M/D' / 'YYYY-MM-DD' → 20261019（読めなければ 0） */
export function dateNum(s) {
  const m = String(s ?? '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

/** 20261019 → '2026/10/19' */
export function fmtDateNum(n) {
  if (!n) return '';
  return `${Math.floor(n / 10000)}/${Math.floor(n / 100) % 100}/${n % 100}`;
}

/** 10月始まりの年度 */
export function fiscalYearOct(y, m) {
  return m >= FY_START_MONTH ? y : y - 1;
}

const digits = s => String(s ?? '').replace(/\D/g, '');

/**
 * 全行を1回だけ走査して工場ごとの年度×メンテ別受注数をまとめる
 * @returns {{ factories: Map<string, object>, fiscalYears: number[], lastDate: number }}
 */
export function buildFactoryIndex(rows, itemOk) {
  const factories = new Map();
  const fySet = new Set();
  let lastDate = 0;
  for (const r of rows) {
    if (!itemOk(r)) continue;
    const key = factoryKey(r);
    if (key === '(未分類)') continue;
    const d = dateNum(r.date);
    if (d > lastDate) lastDate = d;
    const y = Number(r.year), m = Number(r.month);
    if (!y || !m) continue;
    const fy = fiscalYearOct(y, m);
    fySet.add(fy);

    let f = factories.get(key);
    if (!f) {
      f = { key, address: '', tel: '', pref: '', phones: new Set(), byFy: new Map(), orderersByFy: new Map() };
      factories.set(key, f);
    }
    if (!f.address && r.address1) f.address = String(r.address1).trim();
    if (!f.tel && r.deliveryPhone) f.tel = String(r.deliveryPhone).trim();
    if (!f.pref && r.prefecture) f.pref = r.prefecture;
    if (r.phoneSearchStr) f.phones.add(String(r.phoneSearchStr));

    const lease = r.leaseCompany || '(未分類)';
    const q = Number(r.quantity) || 0;
    let byLease = f.byFy.get(fy);
    if (!byLease) { byLease = new Map(); f.byFy.set(fy, byLease); }
    byLease.set(lease, (byLease.get(lease) || 0) + q);

    const o = String(r.orderer ?? '').trim();
    if (o && o !== '(注文者未登録)' && o !== '(未分類)') {
      let om = f.orderersByFy.get(fy);
      if (!om) { om = new Map(); f.orderersByFy.set(fy, om); }
      om.set(o, (om.get(o) || 0) + q);
    }
  }
  return { factories, fiscalYears: [...fySet].sort((a, b) => a - b), lastDate };
}

/** データ最終日までで「9月まで埋まっている」最新の年度 */
export function latestCompleteFiscalYear(lastDate, fiscalYears) {
  if (!lastDate) return fiscalYears[fiscalYears.length - 1];
  const y = Math.floor(lastDate / 10000);
  const m = Math.floor(lastDate / 100) % 100;
  const d = lastDate % 100;
  // 年度 F は F/10〜(F+1)/9。9月末まで入っていれば F = y-1 が完了
  const doneThroughSep = m > 9 || (m === 9 && d >= 25);
  const fy = doneThroughSep ? y - 1 : y - 2;
  return fiscalYears.includes(fy) ? fy : fiscalYears[fiscalYears.length - 1];
}

/** 年度の受注数を NCS / 比較対象の会社 / メンテ別 に分ける */
export function splitFy(f, fy, compareSet) {
  const byLease = f.byFy.get(fy);
  let ncs = 0, other = 0;
  const leases = [];
  if (byLease) {
    byLease.forEach((q, lease) => {
      if (lease === NCS) ncs += q;
      else if (!compareSet || compareSet.has(lease)) other += q;
      if (q) leases.push([lease, q]);
    });
  }
  leases.sort((a, b) => b[1] - a[1]);
  return { ncs, other, leases };
}

/**
 * 電話番号・都道府県・住所/工場名キーワードの絞り込み
 * @param {{ key:string, address?:string, pref?:string, tel?:string, phones?:Set<string> }} f 工場（phones と tel の両方で照合）
 */
export function factoryMatches(f, { phone, pref, keyword }) {
  const dP = digits(phone);
  if (dP) {
    const phones = [...(f.phones || []), digits(f.tel)];
    // 0始まり＝市外局番として前方一致（工場一覧の電話絞り込みと同じ）
    if (!phones.some(p => p && (dP.startsWith('0') ? p.startsWith(dP) : p.includes(dP)))) return false;
  }
  const nPref = normText(pref);
  if (nPref && !normText(f.pref).includes(nPref)) return false;
  const nKw = normText(keyword).replace(/\s+/g, '');
  if (nKw && !(normText(f.address) + normText(f.key)).replace(/\s+/g, '').includes(nKw)) return false;
  return true;
}

/**
 * 工場の絞り込み＋ターゲット判定
 * @param {Map} factories buildFactoryIndex の factories
 * @param {{ judgeFY:number, compareLeases:Set<string>, phone:string, pref:string, keyword:string, onlyTargets:boolean, minOther?:number }} opt
 *   minOther = 判定年度の他社台数がこれ未満の工場は出さない（0・未指定＝絞らない）
 */
export function buildNcsTargets(factories, { judgeFY, compareLeases, phone, pref, keyword, onlyTargets, minOther = 0 }) {
  const compareSet = compareLeases && compareLeases.size ? compareLeases : null;
  const out = [];
  factories.forEach(f => {
    if (!factoryMatches(f, { phone, pref, keyword })) return;

    const judge = splitFy(f, judgeFY, compareSet);
    const isTarget = judge.ncs <= 0 && judge.other > 0;
    if (onlyTargets && !isTarget) return;
    if (!onlyTargets && judge.ncs <= 0 && judge.other <= 0) return;
    if (minOther > 0 && judge.other < minOther) return;
    out.push({ f, judge, isTarget });
  });
  out.sort((a, b) => b.judge.other - a.judge.other || a.f.key.localeCompare(b.f.key, 'ja'));
  return out;
}

/** 指定年度の注文者 上位n名 */
export function topOrderers(f, fy, n = 3) {
  const om = f.orderersByFy.get(fy);
  if (!om) return [];
  return [...om].filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([o]) => o);
}

/**
 * 訪問した工場ごとに「基準日の翌日以降」の受注を集計（全行1回走査）
 * @param {{ key:string, tel?:string, since:number }[]} targets since = 20261019 形式
 * @returns {Map<string, { ncsQty:number, ncsSales:number, ncsFirst:number, allQty:number, allSales:number, byLease:Map<string, number> }>}
 */
export function buildPostVisitStats(rows, itemOk, targets) {
  const byKey = new Map();
  const byTel = new Map();
  const out = new Map();
  for (const t of targets) {
    if (!t.since) continue;
    byKey.set(t.key, t);
    const d = digits(t.tel);
    if (d) byTel.set(d, t);
    out.set(t.key, { ncsQty: 0, ncsSales: 0, ncsFirst: 0, allQty: 0, allSales: 0, byLease: new Map() });
  }
  if (!byKey.size) return out;
  for (const r of rows) {
    const t = byKey.get(factoryKey(r)) || (r.phoneSearchStr ? byTel.get(String(r.phoneSearchStr)) : undefined);
    if (!t) continue;
    if (!itemOk(r)) continue;
    const d = dateNum(r.date);
    if (d <= t.since) continue;
    const s = out.get(t.key);
    const q = Number(r.quantity) || 0;
    const sales = Number(r.sales) || 0;
    const lease = r.leaseCompany || '(未分類)';
    s.allQty += q;
    s.allSales += sales;
    s.byLease.set(lease, (s.byLease.get(lease) || 0) + q);
    if (lease === NCS) {
      s.ncsQty += q;
      s.ncsSales += sales;
      if (q > 0 && (!s.ncsFirst || d < s.ncsFirst)) s.ncsFirst = d;
    }
  }
  return out;
}

/**
 * 住所からエリア（市区町村）を出す: 宮城県仙台市青葉区木町通1-5-12 → 仙台市青葉区
 * 政令市は区まで、それ以外は市 / 郡＋町村 / 東京23区。拾えなければ空
 */
export function areaOf(address) {
  const a = String(address ?? '').normalize('NFKC').trim().replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, '');
  const m = a.match(/^(.{1,6}?市市?.{1,4}?区)/) || a.match(/^(.{1,6}?市市?)/) || a.match(/^(.{1,5}?郡.{1,5}?[町村])/)
    || a.match(/^(.{1,4}?区)/) || a.match(/^(.{1,5}?[町村])/);
  return m ? m[1] : '';
}

/** 住所 → 市まで（横浜市鶴見区 → 横浜市）。市が無ければ areaOf と同じ（東京23区・郡町村） */
export function cityOf(address) {
  const area = areaOf(address);
  const m = area.match(/^(.{1,6}?市市?)/);
  return m ? m[1] : area;
}

/** 'YYYY-MM-DD' 同士の日数差（b - a） */
export function daysBetween(aNum, bNum) {
  const toDate = n => new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100);
  return Math.round((toDate(bNum) - toDate(aNum)) / 86400000);
}

/**
 * 訪問日 → その日に訪問した工場をエリアごとに（カレンダー用）
 * @param {{ date:string, factoryKey:string }[]} visits
 * @param {(key:string) => string} areaOfKey
 * @returns {Map<number, { area:string, keys:Set<string> }[]>} キーは 20261014 形式。エリアは工場の多い順
 */
export function visitAreasByDate(visits, areaOfKey) {
  const byDate = new Map();
  for (const v of visits) {
    const d = dateNum(v.date);
    if (!d) continue;
    const area = areaOfKey(v.factoryKey) || '(エリア不明)';
    if (!byDate.has(d)) byDate.set(d, new Map());
    const m = byDate.get(d);
    if (!m.has(area)) m.set(area, new Set());
    m.get(area).add(v.factoryKey);
  }
  const out = new Map();
  byDate.forEach((m, d) => out.set(d, [...m]
    .map(([area, keys]) => ({ area, keys }))
    .sort((a, b) => b.keys.size - a.keys.size || a.area.localeCompare(b.area, 'ja'))));
  return out;
}

/**
 * 工場の判定。訪問なし → 'none'
 * @param {{ ncsWon:boolean, waiting:boolean, revisit:boolean } | null} st App の statusOf の戻り値
 * @returns {'won'|'waiting'|'revisit'|'open'|'none'}
 */
export function ncsJudge(st) {
  if (!st) return 'none';
  return st.ncsWon ? 'won' : st.waiting ? 'waiting' : st.revisit ? 'revisit' : 'open';
}
