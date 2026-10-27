/**
 * リース会社別レポート（工場別リビルト実績 / 支店別実績 / よく出る車種）を、印刷と同じ中身で Excel にする。
 * 書式は xlsxStyle.js の共通ルール（たかたかが整えた支店別レポートが基準）。
 * 途中の年度は「前年同期」列を足して、前年比はそれと比べる（画面と同じ）。
 */
import {
  font, colName, sumFormula, ratioFormula, yearColumns, ratioBase, drawBorders, writeYearHeader,
  writeTitle, writeUnit, redBelow100, landscapePage, writeFooter, saveXlsx,
  SUB_FILL, QTY_FMT, RATIO_FMT, GREEN_900,
} from './xlsxStyle.js';

/**
 * 拠点（工場・得意先）ごとのまとまりの表
 * groups: { labels: string[], align?: 'left'|'center' }[]（品目より前の見出し列。縦に結合）
 * rows:   { g: number, label: string, series?, sumOf?: number[] (rows の添字), sub?: boolean, indent?: number }[]
 */
function writeGroupedSheet(ws, { title, labelHeads, labelWidths, valueWidth = 15.1, years, info, groups, rows, footer }) {
  const L = labelHeads.length;
  const { yc, lastCol } = yearColumns(years, L + 1, info.partial ? info.lastFy : null);
  labelWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (let k = L + 1; k <= lastCol; k++) ws.getColumn(k).width = valueWidth;

  writeTitle(ws, title, lastCol);
  writeUnit(ws, '（台）', lastCol);
  writeYearHeader(ws, labelHeads, yc, lastCol, y => (y.prev ? `4月〜${info.lastMonth}月` : `${y.fy}/4〜${y.fy + 1}/3`));

  const start = 5;
  const rowNum = i => start + i;
  const endRow = rowNum(rows.length - 1);
  // グループの範囲と、太線（細線）を引く行
  const span = groups.map(() => ({ first: Infinity, last: -1 }));
  rows.forEach((row, i) => { span[row.g].first = Math.min(span[row.g].first, i); span[row.g].last = Math.max(span[row.g].last, i); });
  const groupTops = new Set();
  span.forEach((s, gi) => {
    const multi = s.last > s.first;
    const prevMulti = gi > 0 && span[gi - 1].last > span[gi - 1].first;
    if (gi === 0 || multi || prevMulti) groupTops.add(rowNum(s.first));
  });

  if (rows.length) {
    drawBorders(ws, start, endRow, 1, lastCol, {
      blockStarts: new Set([...labelHeads.map((_, i) => i + 1), ...yc.map(y => y.val)]),
      groupTops,
    });
  }

  rows.forEach((row, i) => {
    const r = rowNum(i);
    ws.getRow(r).height = 22.5;
    for (let k = L; k <= lastCol; k++) {
      const cell = ws.getCell(r, k);
      cell.font = font(yc.some(y => y.ratio === k) || row.indent ? 9 : 10, k === L && !!row.sub);
      cell.alignment = { vertical: 'middle', indent: k === L && row.indent ? row.indent * 2 : undefined };
      if (row.sub) cell.fill = SUB_FILL;
    }
    ws.getCell(r, L).value = row.label || null;
    yc.forEach((y, yi) => {
      const v = ws.getCell(r, y.val);
      v.value = row.sumOf ? sumFormula(y.val, row.sumOf.map(rowNum)) : (row.series.byFy.get(y.fy) || 0);
      v.numFmt = QTY_FMT;
      if (y.prev) {
        const p = ws.getCell(r, y.prev);
        p.value = row.sumOf ? sumFormula(y.prev, row.sumOf.map(rowNum)) : row.series.prevSame;
        p.numFmt = QTY_FMT;
      }
      if (y.ratio) {
        const c = ws.getCell(r, y.ratio);
        c.value = ratioFormula(`${colName(y.val)}${r}`, ratioBase(yc, yi, r));
        c.numFmt = RATIO_FMT;
      }
    });
  });

  // 品目より前の見出し列（工場名・県・拠点名）は縦に結合
  groups.forEach((g, gi) => {
    const { first, last } = span[gi];
    if (last < 0) return;
    g.labels.forEach((v, k) => {
      const cell = ws.getCell(rowNum(first), k + 1);
      cell.value = v || null;
      for (let r = rowNum(first); r <= rowNum(last); r++) {
        ws.getCell(r, k + 1).font = font(10, k === 0);
        ws.getCell(r, k + 1).alignment = g.align === 'left'
          ? { horizontal: 'left', vertical: 'middle', shrinkToFit: true }
          : { horizontal: 'center', vertical: 'middle', wrapText: true };
      }
      if (last > first) ws.mergeCells(rowNum(first), k + 1, rowNum(last), k + 1);
    });
  });

  redBelow100(ws, yc.filter(y => y.ratio).map(y => y.ratio), start, endRow);
  if (footer) writeFooter(ws, footer, endRow + 2, lastCol);
  landscapePage(ws);
}

/** よく出る車種：品目ごとのランキングを横に3つ並べる */
function writeCarSheet(ws, { title, subTitle, items, itemLabel, carSum, top, showAll, partial }) {
  const BLOCK = 5; // #, 車種, 本数, 前年比, 前年
  const blockCol = bi => 1 + bi * (BLOCK + 1);
  const lastCol = blockCol(items.length - 1) + BLOCK - 1;
  writeTitle(ws, title, lastCol);
  writeUnit(ws, '（台）', lastCol);
  ws.getCell(2, 1).value = subTitle;
  ws.getCell(2, 1).font = font(10, true);

  let maxRow = 4;
  items.forEach((it, bi) => {
    const c0 = blockCol(bi);
    [4, 22, 9, 9, 9].forEach((w, k) => { ws.getColumn(c0 + k).width = w; });
    if (bi < items.length - 1) ws.getColumn(c0 + BLOCK).width = 2;
    ws.getRow(3).height = 21;
    ['#', itemLabel[it] || it, '本数', '前年比', partial ? '前年同期' : '前年度'].forEach((h, k) => {
      const cell = ws.getCell(3, c0 + k);
      cell.value = h;
      cell.font = font(10, true, 'FFFFFFFF');
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_900 } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const g = carSum.items.get(it);
    const shown = showAll ? g.rows : g.rows.slice(0, top);
    let topQty = 0, topPrev = 0;
    shown.forEach(x => { topQty += x.qty; topPrev += x.prev; });
    const other = shown.length < g.rows.length ? { qty: g.total - topQty, prev: g.prevTotal - topPrev } : null;

    const put = (r, rank, car, qty, prev, sub = false) => {
      ws.getRow(r).height = 18;
      for (let k = 0; k < BLOCK; k++) {
        const cell = ws.getCell(r, c0 + k);
        cell.font = font(k === 3 ? 9 : 10, sub && k === 1);
        cell.alignment = { vertical: 'middle' };
        if (sub) cell.fill = SUB_FILL;
      }
      ws.getCell(r, c0).value = rank;
      ws.getCell(r, c0).alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getCell(r, c0 + 1).value = car;
      ws.getCell(r, c0 + 2).value = qty;
      ws.getCell(r, c0 + 2).numFmt = QTY_FMT;
      ws.getCell(r, c0 + 4).value = prev;
      ws.getCell(r, c0 + 4).numFmt = QTY_FMT;
      ws.getCell(r, c0 + 3).value = ratioFormula(`${colName(c0 + 2)}${r}`, `${colName(c0 + 4)}${r}`);
      ws.getCell(r, c0 + 3).numFmt = RATIO_FMT;
    };

    let r = 4;
    shown.forEach((x, i) => { put(r, i + 1, x.car, x.qty, x.prev); r++; });
    if (!g.rows.length) { ws.getCell(r, c0 + 1).value = 'データなし'; ws.getCell(r, c0 + 1).font = font(10); r++; }
    const otherRow = other ? r : 0;
    if (other) { put(r, null, `その他（${(g.rows.length - shown.length).toLocaleString()}車種）`, other.qty, other.prev); r++; }
    let totalRow = 0;
    if (g.rows.length) {
      const rows = Array.from({ length: r - 4 }, (_, i) => 4 + i);
      // 前年は、今年0本で表に出ない車種の分があると行の合計と合わないので、そのときは値で入れる
      const prevMatches = topPrev + (other ? other.prev : 0) === g.prevTotal;
      totalRow = r;
      put(r, null, '計', sumFormula(c0 + 2, rows), prevMatches ? sumFormula(c0 + 4, rows) : g.prevTotal, true);
      r++;
    }
    drawBorders(ws, 3, r - 1, c0, c0 + BLOCK - 1, {
      blockStarts: new Set([c0, c0 + 2]),
      groupTops: new Set([3, 4, otherRow, totalRow].filter(Boolean)),
    });
    redBelow100(ws, [c0 + 3], 4, r - 1);
    maxRow = Math.max(maxRow, r);
  });
  ws.getCell(maxRow + 1, 1).value = `車種＝車種名（メーカー）＋車輌型式のハイフンより前。前年比は${partial ? '前年同期間' : '前年度'}との比較。`;
  ws.getCell(maxRow + 1, 1).font = font(8);

  landscapePage(ws, '3:3', 3);
  ws.pageSetup.fitToHeight = showAll ? 0 : 1;
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
    await saveXlsx(wb, p.fileName);
    return;
  }

  const groups = [];
  const rows = [];
  const add = row => { rows.push(row); return rows.length - 1; };
  let labelHeads, labelWidths, sheetName;
  let valueWidth = 15.1;
  if (p.tab === 'factory') {
    sheetName = '工場別';
    // 内訳を開いた工場がなければ品目の列は作らず、その幅を実績の列に回す（工場計の品目は県の列に）
    const hasOpen = p.factories.some(f => f.key === p.openKey);
    labelHeads = hasOpen ? ['工場', '県', '品目'] : ['工場', '県'];
    labelWidths = hasOpen ? [34, 9, 16] : [34, 14];
    if (!hasOpen) {
      const n = yearColumns(p.years, 1, p.info.partial ? p.info.lastFy : null).lastCol;
      valueWidth += (16 - 5) / n;
    }
    const totals = [];
    for (const f of p.factories) {
      if (!hasOpen) {
        const g = groups.push({ labels: [f.key], align: 'left' }) - 1;
        totals.push(add({ g, label: f.pref, series: f.total }));
        continue;
      }
      const g = groups.push({ labels: [f.key, f.pref], align: 'left' }) - 1;
      if (f.key !== p.openKey) { totals.push(add({ g, label: '', series: f.total })); continue; }
      // 開いている工場は 品目（＋分析名）→ 計
      const itemRows = p.items.map(it => {
        const ir = add({ g, label: label(it), series: f.items.get(it) });
        f.mids.filter(m => m.item === it).forEach(m => add({ g, label: m.mid, series: m.series, indent: 1 }));
        return ir;
      });
      totals.push(add({ g, label: '計', sumOf: itemRows, sub: true }));
    }
    if (p.bottomTotal) {
      const g = groups.push({ labels: hasOpen ? ['工場計', ''] : ['工場計'] }) - 1;
      p.items.forEach(it => add({ g, label: label(it), series: p.bottomTotal.items.get(it) }));
      add({ g, label: '計', sumOf: totals, sub: true });
    }
  } else {
    sheetName = '支店別';
    labelHeads = ['拠点', '品目'];
    labelWidths = [18.6, 18.6];
    const itemRowsOf = [];
    const subRows = [];
    for (const c of p.clientRows) {
      const g = groups.push({ labels: [p.clientName(c.client)] }) - 1;
      const itemRows = p.items.map(it => add({ g, label: label(it), series: c.items.get(it) }));
      itemRowsOf.push(itemRows);
      subRows.push(add({ g, label: '計', sumOf: itemRows, sub: true }));
    }
    if (p.bottomTotal && subRows.length) {
      const g = groups.push({ labels: ['支店計'] }) - 1;
      p.items.forEach((it, i) => add({ g, label: label(it), sumOf: itemRowsOf.map(x => x[i]) }));
      add({ g, label: '計', sumOf: subRows, sub: true });
    }
  }
  writeGroupedSheet(wb.addWorksheet(sheetName), {
    title: p.title, labelHeads, labelWidths, valueWidth, years: p.years, info: p.info, groups, rows, footer: p.footer,
  });
  await saveXlsx(wb, p.fileName);
}
