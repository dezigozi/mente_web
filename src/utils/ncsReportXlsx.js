/**
 * NCS訪問管理：方針書用の「訪問実績・受注実績」Excel（exceljs を動的 import）
 * report は ncsTarget.js の buildVisitReport の戻り値。シートは サマリー／工場別成果／訪問記録 の3枚
 */

const FONT = 'Meiryo UI';
const HEADER_FILL = 'FF14532D';  // green-900（画面の表の見出しと同じ色味）
const LABEL_FILL = 'FFECFDF5';   // emerald-50
const TOTAL_FILL = 'FFF1F5F9';   // slate-100
const TEXT_MAIN = 'FF1E293B';
const TEXT_NCS = 'FF047857';     // emerald-700
const THIN = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const BOX = { top: THIN, bottom: THIN, left: THIN, right: THIN };

const fmtDate = n => (n ? `${Math.floor(n / 10000)}/${Math.floor(n / 100) % 100}/${n % 100}` : '');
const fmtIso = s => String(s || '').replace(/-/g, '/');
const fmtYm = ym => `${Math.floor(ym / 100)}年${ym % 100}月`;

const styleHeader = (row) => {
  row.height = 22;
  row.eachCell(c => {
    c.font = { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BOX;
  });
};
const styleBody = (row, { fill, bold } = {}) => {
  row.eachCell({ includeEmpty: true }, c => {
    c.font = { name: FONT, size: 10, bold, color: { argb: TEXT_MAIN } };
    if (fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    c.alignment = { vertical: 'top', wrapText: true, ...(typeof c.value === 'number' ? { horizontal: 'right' } : {}) };
    c.border = BOX;
  });
};

/** 表を1つ書く。cols = [{ header, key, width, numFmt }]。戻り値は最後の行番号 */
const addTable = (ws, startRow, cols, items, { total } = {}) => {
  const header = ws.getRow(startRow);
  cols.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  styleHeader(header);
  let r = startRow;
  for (const it of [...items, ...(total ? [total] : [])]) {
    const row = ws.getRow(++r);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = it[c.key] ?? '';
      if (c.numFmt) cell.numFmt = c.numFmt;
    });
    styleBody(row, it === total ? { fill: TOTAL_FILL, bold: true } : {});
  }
  return r;
};

export function buildNcsReportWorkbook(ExcelJS, report) {
  const wb = new ExcelJS.Workbook();
  const s = report.summary;
  const period = `${fmtDate(report.from)}〜${fmtDate(report.to)}`;

  // ---- サマリー ----
  const ws = wb.addWorksheet('サマリー');
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 18 }, { width: 18 }];
  ws.getCell('A1').value = 'NCS 訪問実績・受注実績';
  ws.getCell('A1').font = { name: FONT, size: 16, bold: true, color: { argb: HEADER_FILL } };
  ws.getCell('A2').value = `訪問期間 ${period} ／ 受注データ ${fmtDate(report.dataLast)} まで`;
  ws.getCell('A2').font = { name: FONT, size: 10, color: { argb: 'FF64748B' } };
  ws.getCell('A3').value = '受注＝オルタネーター・スターター・コンプレッサーの本数。各工場の期間内の初回訪問の翌日から数える';
  ws.getCell('A3').font = { name: FONT, size: 9, color: { argb: 'FF94A3B8' } };

  const kpis = [
    ['ターゲット工場数', s.targetCount, '#,##0'],
    ['訪問した工場数', s.visitedFactories, '#,##0'],
    ['延べ訪問回数', s.visits, '#,##0'],
    ['2回以上訪問した工場', s.repeatFactories, '#,##0'],
    ['最後の感触：好感触／様子見／脈なし／未記入', `${s.results['好感触']}／${s.results['様子見']}／${s.results['脈なし']}／${s.results['未記入']}`],
    ['訪問後 NCS受注のあった工場数', s.wonFactories, '#,##0'],
    ['受注率（NCS受注工場 ÷ 訪問工場）', s.winRate, '0.0%'],
    ['訪問後 NCS受注数（本）', s.ncsQty, '#,##0'],
    ['訪問後 NCS売上（円）', Math.round(s.ncsSales), '#,##0'],
    ['（参考）訪問後 全体受注数（本）', s.allQty, '#,##0'],
    ['再訪問候補の工場数', s.revisitFactories, '#,##0'],
  ];
  let r = 5;
  for (const [label, value, numFmt] of kpis) {
    const row = ws.getRow(r++);
    row.getCell(1).value = label;
    row.getCell(2).value = value;
    if (numFmt) row.getCell(2).numFmt = numFmt;
    styleBody(row);
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LABEL_FILL } };
    row.getCell(1).font = { name: FONT, size: 10, bold: true, color: { argb: TEXT_MAIN } };
    row.getCell(2).font = { name: FONT, size: 12, bold: true, color: { argb: label.includes('NCS') ? TEXT_NCS : TEXT_MAIN } };
    row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
  }

  r += 1;
  ws.getCell(`A${r}`).value = '月別推移';
  ws.getCell(`A${r}`).font = { name: FONT, size: 12, bold: true, color: { argb: HEADER_FILL } };
  const monthly = report.monthly.map(m => ({ ...m, label: fmtYm(m.ym), ncsSales: Math.round(m.ncsSales) }));
  const sum = k => report.monthly.reduce((t, m) => t + m[k], 0);
  addTable(ws, r + 1, [
    { header: '月', key: 'label' },
    { header: '訪問回数', key: 'visits', numFmt: '#,##0' },
    { header: '訪問工場数', key: 'factories', numFmt: '#,##0' },
    { header: '訪問後 NCS受注数', key: 'ncsQty', numFmt: '#,##0' },
    { header: '訪問後 NCS売上（円）', key: 'ncsSales', numFmt: '#,##0' },
    { header: 'NCS初受注の工場数', key: 'firstWon', numFmt: '#,##0' },
  ], monthly, {
    total: { label: '合計', visits: sum('visits'), factories: s.visitedFactories, ncsQty: sum('ncsQty'), ncsSales: Math.round(sum('ncsSales')), firstWon: sum('firstWon') },
  });

  // ---- 工場別成果 ----
  const wf = wb.addWorksheet('工場別成果', { views: [{ state: 'frozen', ySplit: 1 }] });
  const fCols = [
    { header: '判定', key: 'judge', width: 12 },
    { header: 'エリア', key: 'area', width: 16 },
    { header: '工場', key: 'key', width: 30 },
    { header: '住所', key: 'address', width: 34 },
    { header: 'TEL', key: 'tel', width: 14 },
    { header: '訪問回数', key: 'visitCount', width: 9, numFmt: '#,##0' },
    { header: '初回訪問', key: 'first', width: 11 },
    { header: '最終訪問', key: 'last', width: 11 },
    { header: '最後の感触', key: 'lastResult', width: 10 },
    { header: 'メモ', key: 'lastMemo', width: 40 },
    { header: '訪問後 NCS受注数', key: 'ncsQty', width: 11, numFmt: '#,##0' },
    { header: '訪問後 NCS売上（円）', key: 'ncsSales', width: 14, numFmt: '#,##0' },
    { header: 'NCS初受注日', key: 'ncsFirst', width: 11 },
    { header: '訪問後 全体受注数', key: 'allQty', width: 11, numFmt: '#,##0' },
    { header: '訪問後 メンテ別', key: 'byLease', width: 28 },
  ];
  wf.columns = fCols.map(c => ({ width: c.width }));
  const fRows = report.factories.map(f => ({
    ...f, first: fmtIso(f.first), last: fmtIso(f.last), ncsSales: Math.round(f.ncsSales), ncsFirst: fmtDate(f.ncsFirst),
    byLease: f.byLease.map(([l, q]) => `${l} ${q}`).join('、'),
  }));
  const fLast = addTable(wf, 1, fCols, fRows, {
    total: { judge: '合計', key: `${fRows.length}工場`, visitCount: s.visits, ncsQty: s.ncsQty, ncsSales: Math.round(s.ncsSales), allQty: s.allQty },
  });
  report.factories.forEach((f, i) => {
    if (f.ncsQty > 0) wf.getRow(i + 2).getCell(1).font = { name: FONT, size: 10, bold: true, color: { argb: TEXT_NCS } };
  });
  if (fRows.length) wf.autoFilter = { from: 'A1', to: { row: fLast - 1, column: fCols.length } };

  // ---- 訪問記録 ----
  const wv = wb.addWorksheet('訪問記録', { views: [{ state: 'frozen', ySplit: 1 }] });
  const vCols = [
    { header: '訪問日', key: 'date', width: 11 },
    { header: 'エリア', key: 'area', width: 16 },
    { header: '工場', key: 'key', width: 30 },
    { header: '感触', key: 'result', width: 10 },
    { header: 'メモ', key: 'memo', width: 60 },
  ];
  wv.columns = vCols.map(c => ({ width: c.width }));
  const vLast = addTable(wv, 1, vCols, report.visits.map(v => ({ ...v, date: fmtIso(v.date) })));
  if (report.visits.length) wv.autoFilter = { from: 'A1', to: { row: vLast, column: vCols.length } };

  return wb;
}

export async function writeNcsReportXlsx(report, fileName) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = buildNcsReportWorkbook(ExcelJS, report);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
