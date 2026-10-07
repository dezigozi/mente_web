/**
 * 営業ルートプランナー（H:\dev\eigyo_route_planner）に読ませる「訪問ルート計画書」Excel を作る。
 * ひな型は public/route_plan_template.xlsx（プランナーの resources/template.xlsx のコピー）。
 * プランナーは見出し文字で列を探すので、訪問先表（訪問先/住所/TEL/担当者）に工場を流し込むだけ。
 */

const norm = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');

/**
 * @param {{ name: string, address: string, tel: string, contact?: string }[]} factories
 */
export async function writeRoutePlanXlsx(factories) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const res = await fetch(`${import.meta.env.BASE_URL}route_plan_template.xlsx`);
  if (!res.ok) throw new Error('ルート計画書のひな型が読めなかったよ');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  const ws = wb.worksheets[0];

  // 訪問先表の見出し行と列を探す
  let headerRow = 0;
  const cols = {};
  for (let r = 1; r <= ws.rowCount && !headerRow; r++) {
    const map = {};
    ws.getRow(r).eachCell((c, i) => { map[norm(c.text)] = i; });
    if (map['訪問先'] && map['住所']) {
      headerRow = r;
      cols.name = map['訪問先'];
      cols.address = map['住所'];
      cols.tel = map['TEL'];
      cols.contact = map['担当者'];
    }
  }
  if (!headerRow) throw new Error('ひな型に訪問先表が見つからなかったよ');

  const styleRow = ws.getRow(headerRow + 1);
  factories.forEach((f, i) => {
    const row = ws.getRow(headerRow + 1 + i);
    // ひな型の空行より多いときは1行目の書式をまねる
    if (headerRow + 1 + i > ws.rowCount) {
      styleRow.eachCell({ includeEmpty: true }, (c, col) => { row.getCell(col).style = { ...c.style }; });
      row.height = styleRow.height;
    }
    row.getCell(cols.name).value = f.name;
    row.getCell(cols.address).value = f.address || null;
    if (cols.tel) row.getCell(cols.tel).value = f.tel || null;
    if (cols.contact) row.getCell(cols.contact).value = f.contact || null;
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const fileName = `訪問ルート計画書_工場_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.xlsx`;

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
