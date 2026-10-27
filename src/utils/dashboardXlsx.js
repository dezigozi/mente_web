/**
 * ダッシュボードの年次実績比較表（PDF と同じ中身）を Excel にする。
 * 1行=1項目（受注数/売上/粗利/粗利率）、年度ごとに「値・前年比」の2列。
 * 金額は円のまま入れて、千円表示は表示形式（#,##0,）で出す（いじっても1円もずれない）。
 * 合計・前年比・粗利率は式にしておく（数字を直して試せるように）。
 */

const FONT = 'Meiryo UI';
const GREEN_900 = 'FF14532D';
const EMERALD_50 = 'FFECFDF5';
const SLATE_50 = 'FFF8FAFC';
const BORDER = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const YOY_FMT = '[Color10]"↗"0.0%;[Red]"↘"-0.0%;"→"0.0%';
const RATE_FMT = '0.0%';

const colName = n => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * @param {object} p
 * @param {string} p.title          表のタイトル（levelTitle）
 * @param {string} p.levelLabel     先頭列の見出し（リース会社 / 工場 など）
 * @param {number[]} p.years
 * @param {{start:string,end:string}} p.monthRange
 * @param {{name:string, quantity:object, sales?:object, profit:object, address?:string, phone?:string, children?:{name:string, quantity:object}[]}[]} p.rows
 * @param {string|null} p.totalLabel 合計行の名前（null なら合計行なし）
 * @param {boolean} p.showSales
 * @param {boolean} p.showProfit
 * @param {boolean} p.showFactoryInfo 住所・TEL 列を出す
 * @param {'yen'|'thousand'} p.amountUnit
 */
export async function writeDashboardXlsx({
  title, levelLabel, years, monthRange, rows, totalLabel,
  showSales, showProfit, showFactoryInfo, amountUnit,
}) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('年次実績比較', { views: [{ state: 'frozen', xSplit: 0, ySplit: 4 }] });
  const amtFmt = amountUnit === 'thousand' ? '#,##0,' : '"¥"#,##0';

  const metrics = [{ key: 'quantity', label: '受注数', fmt: '#,##0' }];
  if (showSales) metrics.push({ key: 'sales', label: '売上', fmt: amtFmt });
  if (showProfit) metrics.push({ key: 'profit', label: '粗利', fmt: amtFmt });
  const showRate = showSales && showProfit;
  if (showRate) metrics.push({ key: 'rate', label: '粗利率', fmt: RATE_FMT });

  // 列: 名前 / (住所 / TEL) / 項目 / 年度ごとに 値・前年比
  const C_NAME = 1;
  const C_ADDR = showFactoryInfo ? 2 : 0;
  const C_TEL = showFactoryInfo ? 3 : 0;
  const C_LABEL = showFactoryInfo ? 4 : 2;
  const valCol = yIdx => C_LABEL + 1 + yIdx * 2;
  const lastCol = valCol(years.length - 1) + 1;

  ws.getColumn(C_NAME).width = 28;
  if (showFactoryInfo) { ws.getColumn(C_ADDR).width = 40; ws.getColumn(C_TEL).width = 15; }
  ws.getColumn(C_LABEL).width = 9;
  years.forEach((_, i) => { ws.getColumn(valCol(i)).width = 15; ws.getColumn(valCol(i) + 1).width = 9; });

  // タイトル行
  ws.getCell(1, 1).value = title + (amountUnit === 'thousand' && (showSales || showProfit) ? '（千円）' : '');
  ws.getCell(1, 1).font = { name: FONT, size: 14, bold: true };
  ws.getCell(1, lastCol).value = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
  ws.getCell(1, lastCol).font = { name: FONT, size: 9, color: { argb: 'FF94A3B8' } };
  ws.getCell(1, lastCol).alignment = { horizontal: 'right' };

  // 見出し 2 段（年度 / 期間）
  const sm = parseInt(String(monthRange?.start ?? '4'), 10);
  const em = parseInt(String(monthRange?.end ?? '3'), 10);
  const head = (r, c, v, size = 11) => {
    const cell = ws.getCell(r, c);
    cell.value = v;
    cell.font = { name: FONT, size, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_900 } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { left: BORDER, right: BORDER };
  };
  const fixedHeads = [[C_NAME, levelLabel], [C_ADDR, '住所'], [C_TEL, 'TEL'], [C_LABEL, '項目']].filter(([c]) => c);
  fixedHeads.forEach(([c, v]) => { head(3, c, v); head(4, c, null); ws.mergeCells(3, c, 4, c); });
  years.forEach((year, i) => {
    const c = valCol(i);
    head(3, c, `${year}年度`); head(3, c + 1, null);
    ws.mergeCells(3, c, 3, c + 1);
    head(4, c, sm <= em ? `${year}年${sm}月〜${year}年${em}月` : `${year}年${sm}月〜${year + 1}年${em}月`, 8);
    head(4, c + 1, null, 8);
    ws.mergeCells(4, c, 4, c + 1);
  });
  ws.getRow(3).height = 22;

  const styleRow = (r, { fill, bold, nameColor } = {}) => {
    for (let c = 1; c <= lastCol; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { name: FONT, size: 10, bold: !!bold || c === C_NAME, color: c === C_NAME && nameColor ? { argb: nameColor } : undefined };
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = { left: c > C_LABEL && (c - C_LABEL) % 2 === 1 ? BORDER : undefined, bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
      if (c === C_NAME || c === C_ADDR) cell.alignment = { vertical: 'middle', wrapText: true };
    }
  };

  /** 1グループ（名前1つ＝項目数ぶんの行）を書く。values(key, year) が数値か式を返す */
  const writeGroup = (startRow, name, values, opt = {}) => {
    const rowOf = {};
    metrics.forEach((m, i) => { rowOf[m.key] = startRow + i; });
    metrics.forEach((m, i) => {
      const r = startRow + i;
      styleRow(r, opt);
      ws.getCell(r, C_LABEL).value = m.label;
      ws.getCell(r, C_LABEL).font = { name: FONT, size: 9, bold: true, color: { argb: 'FF475569' } };
      years.forEach((year, yIdx) => {
        const c = valCol(yIdx);
        const ref = `${colName(c)}${r}`;
        const cell = ws.getCell(r, c);
        if (m.key === 'rate') {
          const s = `${colName(c)}${rowOf.sales}`, p = `${colName(c)}${rowOf.profit}`;
          cell.value = { formula: `IF(N(${s})=0,"",${p}/${s})` };
        } else {
          cell.value = values(m.key, year);
          if (yIdx > 0) {
            const prev = `${colName(valCol(yIdx - 1))}${r}`;
            ws.getCell(r, c + 1).value = { formula: `IF(N(${prev})=0,"",(${ref}-${prev})/ABS(${prev}))` };
            ws.getCell(r, c + 1).numFmt = YOY_FMT;
            ws.getCell(r, c + 1).font = { name: FONT, size: 8, bold: true };
          }
        }
        cell.numFmt = m.fmt;
      });
    });
    const endRow = startRow + metrics.length - 1;
    ws.getCell(startRow, C_NAME).value = name;
    if (showFactoryInfo) {
      ws.getCell(startRow, C_ADDR).value = opt.address || null;
      ws.getCell(startRow, C_TEL).value = opt.phone || null;
    }
    if (endRow > startRow) {
      [C_NAME, C_ADDR, C_TEL].filter(Boolean).forEach(c => ws.mergeCells(startRow, c, endRow, c));
    }
    for (let c = 1; c <= lastCol; c++) ws.getCell(endRow, c).border = { ...ws.getCell(endRow, c).border, bottom: BORDER };
    return rowOf;
  };

  let r = 5;
  // 合計行は先に場所だけ取っておき、明細を書いたあと SUM 式を入れる
  const totalStart = totalLabel ? r : 0;
  if (totalLabel) r += metrics.length;

  const dataRowsByKey = { quantity: [], sales: [], profit: [] };
  rows.forEach(row => {
    const rowOf = writeGroup(r, row.name, (key, year) => row[key]?.[year] || 0, { address: row.address, phone: row.phone });
    Object.keys(dataRowsByKey).forEach(k => { if (rowOf[k]) dataRowsByKey[k].push(rowOf[k]); });
    r += metrics.length;
    // 展開した子（メンテ別）は受注数だけ
    (row.children || []).forEach(ch => {
      styleRow(r, { fill: SLATE_50 });
      ws.getCell(r, C_NAME).value = `　└ ${ch.name}`;
      ws.getCell(r, C_NAME).font = { name: FONT, size: 9, color: { argb: 'FF334155' } };
      ws.getCell(r, C_LABEL).value = '受注数';
      ws.getCell(r, C_LABEL).font = { name: FONT, size: 9, color: { argb: 'FF475569' } };
      years.forEach((year, yIdx) => {
        const c = valCol(yIdx);
        ws.getCell(r, c).value = ch.quantity[year] || null;
        ws.getCell(r, c).numFmt = '#,##0';
        if (yIdx > 0) {
          const prev = `${colName(valCol(yIdx - 1))}${r}`;
          ws.getCell(r, c + 1).value = { formula: `IF(N(${prev})=0,"",(${colName(c)}${r}-${prev})/ABS(${prev}))` };
          ws.getCell(r, c + 1).numFmt = YOY_FMT;
          ws.getCell(r, c + 1).font = { name: FONT, size: 8, bold: true };
        }
      });
      r += 1;
    });
  });

  if (totalLabel) {
    writeGroup(totalStart, totalLabel, (key, year) => {
      const c = colName(valCol(years.indexOf(year)));
      const list = dataRowsByKey[key];
      return list.length ? { formula: list.map(x => `${c}${x}`).join('+') } : 0;
    }, { fill: EMERALD_50, bold: true, nameColor: 'FF047857' });
  }

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  ws.pageSetup.printTitlesRow = '3:4';

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const safeTitle = String(title).replace(/[\\/:*?"<>|]/g, '_');
  const fileName = `${safeTitle}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.xlsx`;

  // 保存先を選べるブラウザ（Chrome/Edge）はデスクトップを初期位置にする
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        startIn: 'desktop',
        types: [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return; // キャンセル
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
