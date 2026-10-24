/**
 * NCS訪問管理: ターゲット工場の抽出と、訪問後の受注チェック（純関数のみ）
 *
 * - 年度は10月始まり（2025年度 = 2025/10〜2026/9）。工場別 年次実績比較の画面と同じ区切り
 * - 受注数は quantity の合計。対象行は呼び出し側の itemOk（分析名(大)のオルタ・スタ・コンプ）で絞る
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

/**
 * 方針書用の訪問・受注レポート（期間内の訪問と、その訪問のあとの受注）
 * - 工場ごとの起点 = 期間内の最初の訪問日。受注はその翌日〜期間の終わり（データ最終日まで）
 * - 月別の受注は受注日の月で数える
 * @param {{ rows:object[], itemOk:Function, visits:object[], from:string, to:string, lastDate:number,
 *           targetCount:number, todayNum:number, revisitDays:number, infoOf:(key:string)=>{area:string,address:string,tel:string} }} opt
 */
export function buildVisitReport({ rows, itemOk, visits, from, to, lastDate, targetCount, todayNum, revisitDays, infoOf }) {
  const fromN = dateNum(from);
  const toN = dateNum(to);
  const inPeriod = visits
    .filter(v => { const d = dateNum(v.date); return d && d >= fromN && d <= toN; })
    .sort((a, b) => dateNum(a.date) - dateNum(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));

  // 工場ごと（期間内の訪問だけ）
  const fs = new Map();
  for (const v of inPeriod) {
    if (!fs.has(v.factoryKey)) fs.set(v.factoryKey, { key: v.factoryKey, tel: v.tel || '', vs: [] });
    const f = fs.get(v.factoryKey);
    f.vs.push(v);
    if (v.tel) f.tel = v.tel;
  }
  const byKey = new Map();
  const byTel = new Map();
  for (const f of fs.values()) {
    f.since = dateNum(f.vs[0].date);
    Object.assign(f, { ncsQty: 0, ncsSales: 0, ncsFirst: 0, allQty: 0, allSales: 0, byLease: new Map() });
    byKey.set(f.key, f);
    const d = digits(f.tel);
    if (d) byTel.set(d, f);
  }

  // 月の枠（期間の最初の月〜最後の月）
  const ymOf = n => Math.floor(n / 100);
  const months = new Map();
  if (fromN && toN && fromN <= toN) {
    let y = Math.floor(fromN / 10000), m = Math.floor(fromN / 100) % 100;
    while (y * 100 + m <= ymOf(toN)) {
      months.set(y * 100 + m, { ym: y * 100 + m, visits: 0, factories: new Set(), ncsQty: 0, ncsSales: 0, firstWon: 0 });
      if (++m > 12) { m = 1; y++; }
    }
  }
  for (const v of inPeriod) {
    const mo = months.get(ymOf(dateNum(v.date)));
    if (mo) { mo.visits++; mo.factories.add(v.factoryKey); }
  }

  if (byKey.size) {
    for (const r of rows) {
      const f = byKey.get(factoryKey(r)) || (r.phoneSearchStr ? byTel.get(String(r.phoneSearchStr)) : undefined);
      if (!f || !itemOk(r)) continue;
      const d = dateNum(r.date);
      if (d <= f.since || d > toN) continue;
      const q = Number(r.quantity) || 0;
      const sales = Number(r.sales) || 0;
      const lease = r.leaseCompany || '(未分類)';
      f.allQty += q;
      f.allSales += sales;
      f.byLease.set(lease, (f.byLease.get(lease) || 0) + q);
      if (lease === NCS) {
        f.ncsQty += q;
        f.ncsSales += sales;
        if (q > 0 && (!f.ncsFirst || d < f.ncsFirst)) f.ncsFirst = d;
        const mo = months.get(ymOf(d));
        if (mo) { mo.ncsQty += q; mo.ncsSales += sales; }
      }
    }
  }

  const factories = [...fs.values()].map(f => {
    const last = f.vs[f.vs.length - 1];
    const lastN = dateNum(last.date);
    const won = f.ncsQty > 0;
    const waiting = lastDate <= f.since;
    const revisit = !won && !waiting && daysBetween(lastN, todayNum) >= revisitDays;
    const judge = won ? 'NCS受注あり' : waiting ? 'データ待ち' : revisit ? '再訪問候補' : '未受注';
    if (won) { const mo = months.get(ymOf(f.ncsFirst)); if (mo) mo.firstWon++; }
    const info = infoOf(f.key);
    return {
      key: f.key, judge, area: info.area, address: info.address, tel: info.tel || f.tel,
      visitCount: f.vs.length, first: f.vs[0].date, last: last.date, lastResult: last.result || '', lastMemo: last.memo || '',
      ncsQty: f.ncsQty, ncsSales: f.ncsSales, ncsFirst: f.ncsFirst, allQty: f.allQty, allSales: f.allSales,
      byLease: [...f.byLease].filter(([, q]) => q).sort((a, b) => b[1] - a[1]),
    };
  });
  const JUDGE_ORDER = { 'NCS受注あり': 0, '未受注': 1, '再訪問候補': 2, 'データ待ち': 3 };
  factories.sort((a, b) => JUDGE_ORDER[a.judge] - JUDGE_ORDER[b.judge] || b.ncsQty - a.ncsQty
    || a.area.localeCompare(b.area, 'ja') || a.key.localeCompare(b.key, 'ja'));

  const sum = (arr, k) => arr.reduce((t, x) => t + x[k], 0);
  const wonCount = factories.filter(f => f.ncsQty > 0).length;
  const results = { '好感触': 0, '様子見': 0, '脈なし': 0, '未記入': 0 };
  factories.forEach(f => { results[f.lastResult in results ? f.lastResult : '未記入']++; });
  return {
    from: fromN, to: toN, dataLast: Math.min(lastDate || toN, toN),
    summary: {
      targetCount,
      visitedFactories: factories.length,
      visits: inPeriod.length,
      repeatFactories: factories.filter(f => f.visitCount >= 2).length,
      results,
      wonFactories: wonCount,
      winRate: factories.length ? wonCount / factories.length : 0,
      ncsQty: sum(factories, 'ncsQty'),
      ncsSales: sum(factories, 'ncsSales'),
      allQty: sum(factories, 'allQty'),
      revisitFactories: factories.filter(f => f.judge === '再訪問候補').length,
    },
    monthly: [...months.values()].map(m => ({ ym: m.ym, visits: m.visits, factories: m.factories.size, ncsQty: m.ncsQty, ncsSales: m.ncsSales, firstWon: m.firstWon })),
    factories,
    visits: inPeriod.map(v => ({ date: v.date, area: infoOf(v.factoryKey).area, key: v.factoryKey, result: v.result || '', memo: v.memo || '' })),
  };
}
