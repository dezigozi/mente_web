/**
 * ダッシュボードの年次実績比較表（PDF と同じ中身）を Excel にする。書式は xlsxStyle.js の共通ルール。
 * 1行=1項目（受注数/売上/粗利/粗利率）、年度ごとに「値・前年比」。合計はいちばん下。
 * 金額は円のまま入れて、千円表示は表示形式（#,##0,）で出す（いじっても1円もずれない）。
 */
import {
  font, colName, sumFormula, ratioFormula, yearColumns, ratioBase, drawBorders, writeYearHeader,
  writeTitle, writeUnit, redBelow100, landscapePage, saveXlsx, SUB_FILL, QTY_FMT, RATIO_FMT,
} from './xlsxStyle.js';

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
  const ws = wb.addWorksheet('年次実績比較');
  const amtFmt = amountUnit === 'thousand' ? '#,##0,;-#,##0,;""' : '"¥"#,##0;-"¥"#,##0;""';

  const metrics = [{ key: 'quantity', label: '受注数', fmt: QTY_FMT }];
  if (showSales) metrics.push({ key: 'sales', label: '売上', fmt: amtFmt });
  if (showProfit) metrics.push({ key: 'profit', label: '粗利', fmt: amtFmt });
  if (showSales && showProfit) metrics.push({ key: 'rate', label: '粗利率', fmt: RATIO_FMT });

  // 列: 名前 / (住所 / TEL) / 項目 / 年度ごとに 値・前年比
  const labelHeads = showFactoryInfo ? [levelLabel, '住所', 'TEL', '項目'] : [levelLabel, '項目'];
  const L = labelHeads.length;
  const { yc, lastCol } = yearColumns(years, L + 1);
  (showFactoryInfo ? [28, 40, 15, 10] : [28, 10]).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  yc.forEach(y => {
    ws.getColumn(y.val).width = showSales || showProfit ? 15 : 11;
    if (y.ratio) ws.getColumn(y.ratio).width = 9;
  });

  writeTitle(ws, title, lastCol);
  writeUnit(ws, showSales || showProfit ? (amountUnit === 'thousand' ? '（千円）' : '（円）') : '（台）', lastCol);
  const sm = parseInt(String(monthRange?.start ?? '4'), 10);
  const em = parseInt(String(monthRange?.end ?? '3'), 10);
  writeYearHeader(ws, labelHeads, yc, lastCol,
    y => (sm <= em ? `${y.fy}年${sm}月〜${y.fy}年${em}月` : `${y.fy}年${sm}月〜${y.fy + 1}年${em}月`));

  const start = 5;
  let r = start;
  const groupTops = new Set();
  const subRows = new Set();
  const rowsOf = { quantity: [], sales: [], profit: [] };

  /** 1行ぶんの値と前年比。values(fy) は数値か式 */
  const putRow = (label, fmt, values, { ratio = true, indent = 0 } = {}) => {
    ws.getRow(r).height = 22.5;
    ws.getCell(r, L).value = label;
    ws.getCell(r, L).font = font(indent ? 9 : 10);
    ws.getCell(r, L).alignment = { vertical: 'middle', indent: indent ? 2 : undefined };
    yc.forEach((y, yi) => {
      const v = ws.getCell(r, y.val);
      v.value = values(y.fy);
      v.numFmt = fmt;
      v.font = font(10);
      v.alignment = { vertical: 'middle' };
      if (y.ratio) {
        const c = ws.getCell(r, y.ratio);
        if (ratio) {
          c.value = ratioFormula(`${colName(y.val)}${r}`, ratioBase(yc, yi, r));
          c.numFmt = RATIO_FMT;
        }
        c.font = font(9);
        c.alignment = { vertical: 'middle' };
      }
    });
    return r++;
  };

  /** 1グループ（名前1つ＝項目数ぶんの行）。valueOf(key, fy) が数値か式 */
  const writeGroup = (labels, valueOf, { children = [], isTotal = false } = {}) => {
    const first = r;
    groupTops.add(first);
    const rowOf = {};
    metrics.forEach(m => {
      if (m.key === 'rate') {
        rowOf.rate = putRow(m.label, m.fmt, fy => {
          const c = colName(yc.find(y => y.fy === fy).val);
          return { formula: `IF(N(${c}${rowOf.sales})=0,"",${c}${rowOf.profit}/${c}${rowOf.sales})` };
        }, { ratio: false });
      } else {
        rowOf[m.key] = putRow(m.label, m.fmt, fy => valueOf(m.key, fy));
      }
    });
    // 展開した子（メンテ別）は受注数だけ
    children.forEach(ch => putRow(ch.name, QTY_FMT, fy => ch.quantity[fy] || 0, { indent: 1 }));
    labels.forEach((v, k) => {
      ws.getCell(first, k + 1).value = v || null;
      for (let rr = first; rr < r; rr++) {
        ws.getCell(rr, k + 1).font = font(10, k === 0);
        ws.getCell(rr, k + 1).alignment = { horizontal: k === 0 ? 'center' : 'left', vertical: 'middle', wrapText: true };
      }
      if (r - 1 > first) ws.mergeCells(first, k + 1, r - 1, k + 1);
    });
    if (isTotal) for (let rr = first; rr < r; rr++) subRows.add(rr);
    return rowOf;
  };

  rows.forEach(row => {
    const labels = showFactoryInfo ? [row.name, row.address, row.phone] : [row.name];
    const rowOf = writeGroup(labels, (key, fy) => row[key]?.[fy] || 0, { children: row.children || [] });
    Object.keys(rowsOf).forEach(k => { if (rowOf[k]) rowsOf[k].push(rowOf[k]); });
  });
  if (totalLabel && rows.length) {
    writeGroup(showFactoryInfo ? [totalLabel, '', ''] : [totalLabel],
      (key, fy) => sumFormula(yc.find(y => y.fy === fy).val, rowsOf[key]), { isTotal: true });
  }
  const endRow = r - 1;

  if (endRow >= start) {
    drawBorders(ws, start, endRow, 1, lastCol, {
      blockStarts: new Set([...labelHeads.map((_, i) => i + 1), ...yc.map(y => y.val)]),
      groupTops,
    });
    // 合計のまとまりは塗る（名前の列は塗らない）
    subRows.forEach(rr => { for (let k = L; k <= lastCol; k++) ws.getCell(rr, k).fill = SUB_FILL; });
    redBelow100(ws, yc.filter(y => y.ratio).map(y => y.ratio), start, endRow);
  }
  landscapePage(ws);

  await saveXlsx(wb, title);
}
