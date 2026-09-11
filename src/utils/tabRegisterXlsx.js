/**
 * タブ価格 登録用Excel 出力（exceljs を動的 import）
 * groups: [{ code, item, unitCost, rows: [{ lease, code, makerCode, price, dateStr, note, registered }] }]
 * 列は tab_data.csv と同じ並び（メンテ, 品番, メーカーコード, TAB価格, 適用日）＋ 備考。
 * 品番ごとに背景色を循環させ、品番の区切りに太罫線を引く。
 */

const FONT = 'Meiryo UI';

/** 品番グループの背景色（循環） */
const GROUP_FILLS = ['FFE3F2FD', 'FFFFF3E0', 'FFE8F5E9', 'FFF3E5F5', 'FFFFFDE7', 'FFE0F7FA'];
const HEADER_FILL = 'FF334155';    // slate-700
const REGISTERED_FONT = 'FF94A3B8'; // slate-400
const THIN  = { style: 'thin',   color: { argb: 'FFCBD5E1' } };
const THICK = { style: 'medium', color: { argb: 'FF475569' } };

export async function writeTabRegisterXlsx(groups, fileName) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('tab_data', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'メンテ',        key: 'lease',     width: 10 },
    { header: '品番',          key: 'code',      width: 22 },
    { header: 'メーカーコード', key: 'makerCode', width: 14 },
    { header: 'TAB価格',       key: 'price',     width: 12 },
    { header: '適用日',        key: 'dateStr',   width: 16 },
    { header: '備考',          key: 'note',      width: 12 },
    { header: '分析名(大)',    key: 'item',      width: 14 },
    { header: '原価(単位)',    key: 'unitCost',  width: 12 },
  ];

  // ヘッダー
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell(c => {
    c.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    c.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  });

  groups.forEach((g, gi) => {
    const fill = GROUP_FILLS[gi % GROUP_FILLS.length];
    const n = g.rows.length;
    g.rows.forEach((r, ri) => {
      const row = ws.addRow({
        lease: r.lease, code: r.code, makerCode: r.makerCode,
        price: r.price ?? '', dateStr: r.dateStr, note: r.note,
        item: g.item, unitCost: g.unitCost > 0 ? Math.round(g.unitCost) : '',
      });
      row.height = 18;
      const isFirst = ri === 0, isLast = ri === n - 1;
      row.eachCell({ includeEmpty: true }, (c, col) => {
        c.font = {
          name: FONT, size: 11,
          bold: col === 2 && isFirst,
          italic: r.registered,
          color: { argb: r.registered ? REGISTERED_FONT : 'FF1E293B' },
        };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        c.alignment = { vertical: 'middle', horizontal: [4, 8].includes(col) ? 'right' : (col === 1 ? 'center' : 'left') };
        c.border = {
          top:    isFirst ? THICK : THIN,
          bottom: isLast  ? THICK : THIN,
          left:   col === 1 ? THICK : THIN,
          right:  col === ws.columns.length ? THICK : THIN,
        };
        if (col === 4 || col === 8) c.numFmt = '#,##0';
      });
    });
  });

  // 品番列は2〜n行目を見た目でまとめる（先頭行だけ太字、2行目以降は薄く）
  ws.autoFilter = { from: 'A1', to: `H${ws.rowCount}` };

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
