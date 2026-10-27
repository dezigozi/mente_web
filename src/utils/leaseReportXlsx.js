/**
 * リース会社別レポート（工場別リビルト実績 / 支店別実績 / よく出る車種）を、印刷と同じ中身で Excel にする。
 * 本数・前年比は年度ごとに2列。途中の年度は前年同期間の列を足して、前年比はそれと比べる。
 * 合計（計・工場/得意先の計）と前年比は式にしておく（数字を直して試せるように）。
 */
import { saveXlsx } from './dashboardXlsx.js';

const FONT = 'Meiryo UI';
const GREEN_900 = 'FF14532D';
const EMERALD_50 = 'FFECFDF5';
const SLATE_50 = 'FFF8FAFC';
const BORDER = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const HAIR = { style: 'hair', color: { argb: 'FFE2E8F0' } };
const QTY_FMT = '#,##0;-#,##0;""';
const YOY_FMT = '[Color10]"↗"0.0%;[Red]"↘"-0.0%;"→"0.0%';

const colName = n => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** 行番号の並びを SUM の引数に（続いている所は範囲にまとめる） */
const sumFormula = (col, rowNums) => {
  const c = colName(col);
  const sorted = [...rowNums].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${c}${sorted[i]}` : `${c}${sorted[i]}:${c}${sorted[j]}`);
    i = j + 1;
  }
  return parts.length ? `SUM(${parts.join(',')})` : '0';
};

const headCell = (ws, r, c, v, size = 10) => {
  const cell = ws.getCell(r, c);
  cell.value = v;
  cell.font = { name: FONT, size, bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_900 } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
};

const yoyCell = (cell, cur, base) => {
  cell.value = { formula: `IF(N(${base})=0,"",(${cur}-${base})/ABS(${base}))` };
  cell.numFmt = YOY_FMT;
  cell.font = { name: FONT, size: 8, bold: true };
};

/**
 * 年度別の本数表（工場別・支店別）
 * rows: { labels: string[], series, level: 0|1|2, total?: boolean, sumOf?: number[] (rows の添字) }
 */
function writeSeriesSheet(ws, { title, labelHeads, labelWidths, years, info, rows, footer }) {
  const L = labelHeads.length;
  const partialFy = info.partial ? info.lastFy : null;
  // 年度ごとの列: 本数, 前年比, (途中の年度だけ) 前年同期
  const yc = [];
  let c = L + 1;
  years.forEach(fy => {
    yc.push({ fy, qty: c, yoy: c + 1, prev: fy === partialFy ? c + 2 : 0 });
    c += fy === partialFy ? 3 : 2;
  });
  const lastCol = c - 1;

  labelWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  yc.forEach(y => {
    ws.getColumn(y.qty).width = 9;
    ws.getColumn(y.yoy).width = 9;
    if (y.prev) ws.getColumn(y.prev).width = 9;
  });

  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { name: FONT, size: 14, bold: true };

  labelHeads.forEach((h, i) => {
    headCell(ws, 3, i + 1, h);
    headCell(ws, 4, i + 1, null);
    ws.mergeCells(3, i + 1, 4, i + 1);
    ws.getCell(3, i + 1).alignment = { horizontal: 'left', vertical: 'middle' };
  });
  yc.forEach(y => {
    const end = y.prev || y.yoy;
    for (let k = y.qty; k <= end; k++) { headCell(ws, 3, k, null); headCell(ws, 4, k, null, 8); }
    ws.getCell(3, y.qty).value = `${y.fy}年度`;
    ws.mergeCells(3, y.qty, 3, end);
    ws.getCell(4, y.qty).value = y.prev ? `4月〜${info.lastMonth}月 途中` : `${y.fy}/4〜${y.fy + 1}/3`;
    ws.mergeCells(4, y.qty, 4, y.yoy);
    if (y.prev) ws.getCell(4, y.prev).value = '前年同期';
    ws.getCell(3, y.qty).border = { left: BORDER };
    ws.getCell(4, y.qty).border = { left: BORDER };
  });
  ws.getRow(3).height = 20;

  const start = 5;
  const rowNum = i => start + i;
  rows.forEach((row, i) => {
    const r = rowNum(i);
    const fill = row.total ? EMERALD_50 : row.level > 0 ? SLATE_50 : null;
    const bold = row.total || row.level === 0;
    const color = row.total ? 'FF047857' : row.level === 2 ? 'FF64748B' : row.level === 1 ? 'FF047857' : 'FF1E293B';
    for (let k = 1; k <= lastCol; k++) {
      const cell = ws.getCell(r, k);
      cell.font = { name: FONT, size: 10, bold, color: { argb: k <= L ? color : 'FF1E293B' } };
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = { bottom: HAIR, left: yc.some(y => y.qty === k) ? BORDER : undefined };
    }
    row.labels.forEach((v, k) => {
      ws.getCell(r, k + 1).value = v || null;
      if (k === 0 && row.level) ws.getCell(r, 1).alignment = { indent: row.level * 2 };
    });
    yc.forEach((y, yi) => {
      const qtyCell = ws.getCell(r, y.qty);
      if (row.sumOf) qtyCell.value = { formula: sumFormula(y.qty, row.sumOf.map(rowNum)) };
      else qtyCell.value = row.series.byFy.get(y.fy) || 0;
      qtyCell.numFmt = QTY_FMT;
      let base = null;
      if (y.prev) {
        const pc = ws.getCell(r, y.prev);
        pc.value = row.sumOf ? { formula: sumFormula(y.prev, row.sumOf.map(rowNum)) } : row.series.prevSame;
        pc.numFmt = QTY_FMT;
        pc.font = { name: FONT, size: 9, color: { argb: 'FF94A3B8' } };
        base = `${colName(y.prev)}${r}`;
      } else if (yi > 0 && yc[yi - 1].fy === y.fy - 1) {
        base = `${colName(yc[yi - 1].qty)}${r}`;
      }
      if (base) yoyCell(ws.getCell(r, y.yoy), `${colName(y.qty)}${r}`, base);
    });
  });
  // 計の上は太線
  const firstTotal = rows.findIndex(x => x.total);
  if (firstTotal >= 0) {
    for (let k = 1; k <= lastCol; k++) {
      const cell = ws.getCell(rowNum(firstTotal), k);
      cell.border = { ...cell.border, top: { style: 'medium', color: { argb: GREEN_900 } } };
    }
  }
  if (footer) {
    const r = rowNum(rows.length) + 1;
    ws.getCell(r, lastCol).value = footer;
    ws.getCell(r, lastCol).font = { name: FONT, size: 11, bold: true };
    ws.getCell(r, lastCol).alignment = { horizontal: 'right' };
  }

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 4 }];
  ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  ws.pageSetup.printTitlesRow = '3:4';
}

/** よく出る車種：品目ごとのランキングを横に3つ並べる */
function writeCarSheet(ws, { title, subTitle, items, itemLabel, carSum, top, showAll, partial }) {
  const BLOCK = 5; // #, 車種, 本数, 前年比, 前年
  const blockCol = bi => 1 + bi * (BLOCK + 1);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { name: FONT, size: 14, bold: true };
  ws.getCell(2, 1).value = subTitle;
  ws.getCell(2, 1).font = { name: FONT, size: 9, bold: true, color: { argb: 'FF047857' } };

  let maxRow = 4;
  items.forEach((it, bi) => {
    const c0 = blockCol(bi);
    [4, 22, 8, 9, 8].forEach((w, k) => { ws.getColumn(c0 + k).width = w; });
    if (bi < items.length - 1) ws.getColumn(c0 + BLOCK).width = 2;
    ['#', itemLabel[it] || it, '本数', '前年比', partial ? '前年同期' : '前年度'].forEach((h, k) => headCell(ws, 3, c0 + k, h));
    ws.getCell(3, c0 + 1).alignment = { horizontal: 'left', vertical: 'middle' };

    const g = carSum.items.get(it);
    const shown = showAll ? g.rows : g.rows.slice(0, top);
    let topQty = 0, topPrev = 0;
    shown.forEach(x => { topQty += x.qty; topPrev += x.prev; });
    const other = shown.length < g.rows.length ? { qty: g.total - topQty, prev: g.prevTotal - topPrev } : null;

    const put = (r, rank, car, qty, prev, style = {}) => {
      for (let k = 0; k < BLOCK; k++) {
        const cell = ws.getCell(r, c0 + k);
        cell.font = { name: FONT, size: 9, bold: !!style.bold || k === 2, color: style.color ? { argb: style.color } : undefined };
        if (style.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
        cell.border = { bottom: HAIR, top: style.top };
      }
      ws.getCell(r, c0).value = rank;
      ws.getCell(r, c0).font = { name: FONT, size: 9, bold: true, color: { argb: 'FF94A3B8' } };
      ws.getCell(r, c0 + 1).value = car;
      ws.getCell(r, c0 + 2).value = qty;
      ws.getCell(r, c0 + 2).numFmt = '#,##0';
      ws.getCell(r, c0 + 4).value = prev;
      ws.getCell(r, c0 + 4).numFmt = QTY_FMT;
      ws.getCell(r, c0 + 4).font = { name: FONT, size: 9, color: { argb: 'FF94A3B8' } };
      yoyCell(ws.getCell(r, c0 + 3), `${colName(c0 + 2)}${r}`, `${colName(c0 + 4)}${r}`);
    };

    let r = 4;
    shown.forEach((x, i) => { put(r, i + 1, x.car, x.qty, x.prev); r++; });
    if (!g.rows.length) { ws.getCell(r, c0 + 1).value = 'データがないよ'; r++; }
    if (other) {
      put(r, null, `その他（${(g.rows.length - shown.length).toLocaleString()}車種）`, other.qty, other.prev,
        { fill: SLATE_50, color: 'FF475569' });
      r++;
    }
    if (g.rows.length) {
      const first = 4, last = r - 1;
      const qc = colName(c0 + 2), pc = colName(c0 + 4);
      // 前年は、今年0本で表に出ない車種の分があると行の合計と合わないので、そのときは値で入れる
      const prevMatches = topPrev + (other ? other.prev : 0) === g.prevTotal;
      put(r, null, '計', { formula: `SUM(${qc}${first}:${qc}${last})` },
        prevMatches ? { formula: `SUM(${pc}${first}:${pc}${last})` } : g.prevTotal,
        { bold: true, fill: EMERALD_50, color: 'FF047857', top: { style: 'medium', color: { argb: GREEN_900 } } });
      r++;
    }
    maxRow = Math.max(maxRow, r);
  });
  ws.getCell(maxRow + 1, 1).value = `車種＝車種名（メーカー）＋車輌型式のハイフンより前。前年比は${partial ? '前年同期間' : '前年度'}と比べてるよ`;
  ws.getCell(maxRow + 1, 1).font = { name: FONT, size: 8, color: { argb: 'FF94A3B8' } };

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 3 }];
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: showAll ? 0 : 1 };
}

/**
 * @param {object} p
 * @param {'factory'|'client'|'car'} p.tab
 * @param {string} p.fileName       保存名（日付の前）
 * @param {string} p.title          1行目の題名（印刷の題名）
 * @param {string[]} p.items        品目（REBUILD_ITEMS）
 * @param {Record<string,string>} p.itemLabel
 * @param {string|null} p.footer    最後の右下（提出用の社名）
 * 工場別: factories, openKey / 支店別: clientRows, clientName / 共通: years, info, bottomTotal
 * 車種: carSum, carSubTitle, carTop, carShowAll, carPartial
 */
export async function writeLeaseReportXlsx(p) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  const label = it => p.itemLabel[it] || it;

  if (p.tab === 'car') {
    writeCarSheet(wb.addWorksheet('よく出る車種'), {
      title: p.title, subTitle: p.carSubTitle, items: p.items, itemLabel: p.itemLabel,
      carSum: p.carSum, top: p.carTop, showAll: p.carShowAll, partial: p.carPartial,
    });
  } else {
    const rows = [];
    const add = row => { rows.push(row); return rows.length - 1; };
    let labelHeads, labelWidths, sheetName;
    if (p.tab === 'factory') {
      sheetName = '工場別';
      labelHeads = ['工場', '県'];
      labelWidths = [34, 9];
      const tops = [];
      for (const f of p.factories) {
        const open = f.key === p.openKey;
        const ti = add({ labels: [f.key, f.pref], series: f.total, level: 0 });
        tops.push(ti);
        if (open) {
          const itemIdx = [];
          p.items.forEach(it => {
            itemIdx.push(add({ labels: [label(it), ''], series: f.items.get(it), level: 1 }));
            f.mids.filter(m => m.item === it).forEach(m => add({ labels: [m.mid, ''], series: m.series, level: 2 }));
          });
          rows[ti].sumOf = itemIdx;
        }
      }
      if (p.bottomTotal) {
        add({ labels: ['計', ''], series: p.bottomTotal.total, level: 0, total: true, sumOf: tops });
        p.items.forEach(it => add({ labels: [label(it), ''], series: p.bottomTotal.items.get(it), level: 1, total: true }));
      }
    } else {
      sheetName = '支店別';
      labelHeads = ['得意先 / 品目'];
      labelWidths = [30];
      const tops = [];
      const byItem = new Map(p.items.map(it => [it, []]));
      for (const c of p.clientRows) {
        const ti = add({ labels: [p.clientName(c.client)], series: c.total, level: 0 });
        tops.push(ti);
        rows[ti].sumOf = p.items.map(it => {
          const ii = add({ labels: [label(it)], series: c.items.get(it), level: 1 });
          byItem.get(it).push(ii);
          return ii;
        });
      }
      if (p.bottomTotal) {
        add({ labels: ['計'], series: p.bottomTotal.total, level: 0, total: true, sumOf: tops });
        p.items.forEach(it => add({ labels: [label(it)], series: p.bottomTotal.items.get(it), level: 1, total: true, sumOf: byItem.get(it) }));
      }
    }
    writeSeriesSheet(wb.addWorksheet(sheetName), {
      title: p.title, labelHeads, labelWidths, years: p.years, info: p.info, rows, footer: p.footer,
    });
  }

  await saveXlsx(wb, p.fileName);
}
