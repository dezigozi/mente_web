import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildVisitReport, NCS } from './ncsTarget.js';
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
  targetCount: 7, todayNum: 20270301, revisitDays: 90,
  infoOf: k => ({ area: k === 'A工場' ? '横浜市鶴見区' : '札幌市白石区', address: '', tel: '' }),
});

describe('buildVisitReport', () => {
  it('期間内の訪問と、初回訪問の翌日〜終了日の受注を数える', () => {
    const r = make();
    expect(r.summary).toMatchObject({
      targetCount: 7, visitedFactories: 2, visits: 3, repeatFactories: 1,
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
    expect(wb.worksheets.map(w => w.name)).toEqual(['サマリー', '工場別成果', '訪問記録']);
    const sum = wb.getWorksheet('サマリー');
    const labels = [];
    sum.eachRow(r => labels.push([r.getCell(1).value, r.getCell(2).value]));
    expect(labels).toContainEqual(['訪問した工場数', 2]);
    expect(labels).toContainEqual(['訪問後 NCS受注数（本）', 3]);
    expect(labels).toContainEqual(['2026年10月', 2]);
    expect(labels).toContainEqual(['合計', 3]);
    expect(wb.getWorksheet('工場別成果').getRow(2).getCell(3).value).toBe('A工場');
    expect(wb.getWorksheet('訪問記録').rowCount).toBe(4);
    await wb.xlsx.writeBuffer(); // 書き出せること
  });
});
