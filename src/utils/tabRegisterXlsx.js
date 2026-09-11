/**
 * タブ価格 登録用Excel 出力（exceljs を動的 import）
 * groups: [{ code, item, unitCost,
 *            rows:     [{ lease, code, makerCode, price, dateStr, note, registered }],   // 4社ぶん
 *            siblings: [{ lease, code, makerCode, price, dateStr }] }]                   // 登録済みの同系品番（コンプレッサー）
 * 列は tab_data.csv と同じ並び（メンテ, 品番, メーカーコード, TAB価格, 適用日）＋ 備考・参考列。
 * 品番ごとに背景色を循環させ、品番の区切りに太罫線を引く。同系品番は同グループ内に薄い色で続けて出す。
 */

const FONT = 'Meiryo UI';

/** 品番グループの背景色（循環） */
const GROUP_FILLS = ['FFE3F2FD', 'FFFFF3E0', 'FFE8F5E9', 'FFF3E5F5', 'FFFFFDE7', 'FFE0F7FA'];
const SIBLING_FILL = 'FFF1F5F9';    // slate-100（同系品番）
const HEADER_FILL = 'FF334155';     // slate-700
const TEXT_MAIN = 'FF1E293B';
const TEXT_REGISTERED = 'FF94A3B8'; // slate-400
const TEXT_SIBLING = 'FF475569';    // slate-600
const TEXT_WARN = 'FFB91C1C';       // red-700
const THIN  = { style: 'thin',   color: { argb: 'FFCBD5E1' } };
const THICK = { style: 'medium', color: { argb: 'FF475569' } };

const COL = { lease: 1, code: 2, makerCode: 3, price: 4, dateStr: 5, note: 6, item: 7, unitCost: 8, margin: 9, marginRate: 10 };
const NUM_COLS = new Set([COL.price, COL.unitCost, COL.margin]);

export async function writeTabRegisterXlsx(groups, fileName) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('tab_data', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'メンテ',        key: 'lease',      width: 10 },
    { header: '品番',          key: 'code',       width: 22 },
    { header: 'メーカーコード', key: 'makerCode',  width: 14 },
    { header: 'TAB価格',       key: 'price',      width: 12 },
    { header: '適用日',        key: 'dateStr',    width: 16 },
    { header: '備考',          key: 'note',       width: 34 },
    { header: '分析名(大)',    key: 'item',       width: 14 },
    { header: '原価(単位)',    key: 'unitCost',   width: 12 },
    { header: '粗利単価',      key: 'margin',     width: 12 },
    { header: '粗利率',        key: 'marginRate', width: 9 },
  ];
  const lastCol = ws.columns.length;

  // ヘッダー
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell(c => {
    c.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  });

  const styleRow = (row, { fill, fontColor, bold, italic, isFirst, isLast }) => {
    row.height = 18;
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.font = { name: FONT, size: 11, bold: bold && col === COL.code, italic, color: { argb: fontColor } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      c.alignment = {
        vertical: 'middle',
        horizontal: NUM_COLS.has(col) || col === COL.marginRate ? 'right' : (col === COL.lease ? 'center' : 'left'),
      };
      c.border = {
        top:    isFirst ? THICK : THIN,
        bottom: isLast  ? THICK : THIN,
        left:   col === 1 ? THICK : THIN,
        right:  col === lastCol ? THICK : THIN,
      };
      if (NUM_COLS.has(col)) c.numFmt = '#,##0';
      if (col === COL.marginRate) c.numFmt = '0.0%';
    });
  };

  const marginOf = (price, unitCost) => {
    if (!(price > 0) || !(unitCost > 0)) return { margin: '', marginRate: '' };
    const margin = price - unitCost;
    return { margin, marginRate: margin / price };
  };

  groups.forEach((g, gi) => {
    const fill = GROUP_FILLS[gi % GROUP_FILLS.length];
    const unitCost = g.unitCost > 0 ? Math.round(g.unitCost) : '';
    const total = g.rows.length + (g.siblings?.length || 0);
    let idx = 0;

    // 4社ぶん（提案 / 登録済み）
    for (const r of g.rows) {
      const row = ws.addRow({
        lease: r.lease, code: r.code, makerCode: r.makerCode,
        price: r.price ?? '', dateStr: r.dateStr, note: r.note,
        item: g.item, unitCost, ...marginOf(r.price, g.unitCost),
      });
      styleRow(row, {
        fill, bold: idx === 0, italic: r.registered,
        fontColor: r.registered ? TEXT_REGISTERED : TEXT_MAIN,
        isFirst: idx === 0, isLast: idx === total - 1,
      });
      if (!r.registered && /^要確認/.test(r.note || '')) {
        row.getCell(COL.note).font = { name: FONT, size: 11, bold: true, color: { argb: TEXT_WARN } };
      }
      idx++;
    }

    // 登録済みの同系品番（比較用・貼らない）
    for (const s of g.siblings || []) {
      const row = ws.addRow({
        lease: s.lease, code: s.code, makerCode: s.makerCode,
        price: s.price, dateStr: s.dateStr, note: `同系品番 登録済み（${g.code} と売価を揃える）`,
        item: g.item, unitCost, ...marginOf(s.price, g.unitCost),
      });
      styleRow(row, {
        fill: SIBLING_FILL, bold: false, italic: true, fontColor: TEXT_SIBLING,
        isFirst: idx === 0, isLast: idx === total - 1,
      });
      idx++;
    }
  });

  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + lastCol)}${ws.rowCount}` };

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
