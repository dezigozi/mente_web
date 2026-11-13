import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildVisitReport, buildTargetRows, NCS } from './ncsTarget.js';
import { buildNcsReportWorkbook } from './ncsReportXlsx.js';

const row = (o) => ({ branchCompany: 'A工場', leaseCompany: NCS, quantity: 1, sales: 10000, date: '2026/11/5', ...o });
const rows = [
  row({ date: '2026/10/14', quantity: 9 }),               // 訪問当日 → 数えない
  row({ date: '2026/10/20', quantity: 2, sales: 30000 }),  // 訪問後 NCS
  row({ date: '2026/11/3', leaseCompany: 'OR', quantity: 5 }), // 訪問後 他社（全体だけ）
  row({ date: '2027/1/10', quantity: 4 }),                 // 期間の外 → 数えない
  row({ branchCompany: '別名', phoneSearchStr: '0455720050', date: '2026/11/20', quantity: 1 }), // 電話で拾う
  row({ branchCompany: 'B工場', leaseCompany: 'OR', date: '2026/11/1', quantity: 3 }),
];
const visits = [
  { id: '1', factoryKey: 'A工場', tel: '045-572-0050', date: '2026-10-14', result: '様子見', memo: '初回' },
  { id: '2', factoryKey: 'A工場', tel: '045-572-0050', date: '2026-11-02', result: '好感触', memo: '2回目' },
  { id: '3', factoryKey: 'B工場', date: '2026-10-21', result: '' },
  { id: '4', factoryKey: 'C工場', date: '2026-09-30', result: '脈なし' }, // 期間の前 → 出ない
];
const make = () => buildVisitReport({
  rows, itemOk: () => true, visits, from: '2026-10-01', to: '2026-12-31', lastDate: 20261130,
  targetCount: 7, goalFY: 2025, goalBase: 147, todayNum: 20270301, revisitDays: 90,
  infoOf: k => ({ area: k === 'A工場' ? '横浜市鶴見区' : '札幌市白石区', address: '', tel: '' }),
});

describe('buildVisitReport', () => {
  it('期間内の訪問と、初回訪問の翌日〜終了日の受注を数える', () => {
    const r = make();
    expect(r.summary).toMatchObject({
      targetCount: 7, goalFY: 2025, goalBase: 147, goalQty: 44, visitedFactories: 2, visits: 3, repeatFactories: 1,
      wonFactories: 1, winRate: 0.5, ncsQty: 3, ncsSales: 40000, allQty: 11, revisitFactories: 1,
    });
    expect(r.summary.results).toEqual({ '好感触': 1, '様子見': 0, '脈なし': 0, '未記入': 1 });
    const a = r.factories.find(f => f.key === 'A工場');
    expect(a).toMatchObject({ judge: 'NCS受注あり', visitCount: 2, first: '2026-10-14', last: '2026-11-02', lastResult: '好感触', ncsQty: 3, ncsFirst: 20261020, allQty: 8 });
    expect(r.factories.find(f => f.key === 'B工場').judge).toBe('再訪問候補');
    expect(r.factories.map(f => f.key)).toEqual(['A工場', 'B工場']);
  });
  it('月別：訪問は訪問日の月、受注は受注日の月', () => {
    const r = make();
    expect(r.monthly.map(m => [m.ym, m.visits, m.factories, m.ncsQty, m.firstWon])).toEqual([
      [202610, 2, 2, 2, 1], [202611, 1, 1, 1, 0], [202612, 0, 0, 0, 0],
    ]);
    expect(r.visits.map(v => v.date)).toEqual(['2026-10-14', '2026-10-21', '2026-11-02']);
  });
});

describe('buildNcsReportWorkbook', () => {
  it('サマリー・工場別成果・訪問記録の3シート', async () => {
    const wb = buildNcsReportWorkbook(ExcelJS, make());
    expect(wb.worksheets.map(w => w.name)).toEqual(['サマリー', '工場別成果', '訪問記録']); // ターゲットなし
    const sum = wb.getWorksheet('サマリー');
    const labels = [];
    sum.eachRow(r => labels.push([r.getCell(1).value, r.getCell(2).value]));
    expect(labels).toContainEqual(['訪問した工場数', 2]);
    // オリックス何本で NCS 何本（目標はオリックスの行 × 30% の式）
    expect(labels.slice(3, 6)).toEqual([
      ['ターゲット工場数', 7],
      ['オリックス受注 2025年度（本）', 147],
      ['NCS目標（オリックスの30%・本）', { formula: 'ROUND(B6*30%,0)', result: 44 }],
    ]);
    expect(labels).toContainEqual(['訪問後 NCS受注数（本）', 3]);
    expect(labels).toContainEqual(['2026年10月', 2]);
    expect(labels).toContainEqual(['合計', 3]);
    expect(wb.getWorksheet('工場別成果').getRow(2).getCell(3).value).toBe('A工場');
    expect(wb.getWorksheet('訪問記録').rowCount).toBe(4);
    await wb.xlsx.writeBuffer(); // 書き出せること
  });

  it('ターゲットがあれば「対象エリア」「ターゲット一覧」も出す（県の数字は一覧の式）', async () => {
    const factories = new Map([
      ['札幌A', { key: '札幌A', pref: '北海道', address: '北海道札幌市中央区1', tel: '011-1', byFy: new Map([[2025, new Map([['OR', 100]])]]) }],
      ['小樽B', { key: '小樽B', pref: '北海道', address: '北海道小樽市1', tel: '', byFy: new Map([[2025, new Map([['OR', 7]])]]) }],
      ['仙台C', { key: '仙台C', pref: '宮城県', address: '宮城県仙台市青葉区1', tel: '', byFy: new Map([[2025, new Map([['OR', 40], ['MAL', 9]])]]) }],
    ]);
    const pool = [{ key: '仙台C' }, { key: '小樽B' }, { key: '札幌A', tel: '011-999' }];
    const targets = buildTargetRows(pool, factories, 2025, k => (k === '仙台C' ? { visitCount: 2, lastVisit: '2026-10-21' } : { visitCount: 0, lastVisit: '' }));
    const wb = buildNcsReportWorkbook(ExcelJS, { ...make(), targets });
    expect(wb.worksheets.map(w => w.name)).toEqual(['サマリー', '対象エリア', 'ターゲット一覧', '工場別成果', '訪問記録']);

    const wl = wb.getWorksheet('ターゲット一覧');
    const cells = r => wl.getRow(r).values.slice(1);
    expect(cells(1)).toEqual(['No', '県', '市区町村', '工場', '住所', 'TEL', 'オリックス受注 2025年度（本）', 'NCS目標（本）', '訪問回数', '最終訪問']);
    // 県は北から、県の中はオリックスの多い市から。目標は 30.0 / 2.1 / 12.0 → 合計 44（147 × 30%）
    expect(cells(2)).toEqual([1, '北海道', '札幌市', '札幌A', '北海道札幌市中央区1', '011-999', 100, 30, 0, '']);
    expect(cells(3)).toEqual([2, '北海道', '小樽市', '小樽B', '北海道小樽市1', '', 7, 2, 0, '']);
    expect(cells(4)).toEqual([3, '宮城県', '仙台市', '仙台C', '宮城県仙台市青葉区1', '', 40, 12, 2, '2026/10/21']);
    expect(wl.getRow(5).getCell(8).value).toEqual({ formula: 'SUM(H2:H4)', result: 44 });

    const wa = wb.getWorksheet('対象エリア');
    expect(wa.getRow(5).getCell(1).value).toBe('北海道');
    expect(wa.getRow(5).getCell(3).value).toEqual({ formula: "SUMIF('ターゲット一覧'!$B$2:$B$4,A5,'ターゲット一覧'!$G$2:$G$4)", result: 107 });
    expect(wa.getRow(5).getCell(5).value).toBe('札幌市 1・小樽市 1');
    expect(wa.getRow(7).getCell(4).value).toEqual({ formula: 'SUM(D5:D6)', result: 44 });
    await wb.xlsx.writeBuffer();
  });
});
