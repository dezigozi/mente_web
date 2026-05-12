/**
 * 納品日パース済み行から暦の年・月・年月を得る（CSV追記用）
 * 年月は「2026年3月」形式（Excel が YYYY-MM を日付化して Apr-23 等になるのを避ける）
 * csvLoader と aggregator の両方から参照（循環 import を避けるため独立ファイル）
 * @param {{ year?: number|string, month?: number|string, fiscalYear?: number|string }} row
 * @returns {{ year: string, month: string, yearMonth: string }}
 */
export function deliveryDateCalendarParts(row) {
  const mNum = Number(row?.month);
  if (!Number.isFinite(mNum) || mNum < 1 || mNum > 12) {
    return { year: '', month: '', yearMonth: '' };
  }
  let yNum;
  if (row.year != null && row.year !== '') {
    yNum = Number(row.year);
  } else if (row.fiscalYear != null && row.fiscalYear !== '') {
    yNum = mNum >= 4 ? Number(row.fiscalYear) : Number(row.fiscalYear) + 1;
  } else {
    return { year: '', month: String(mNum), yearMonth: '' };
  }
  if (!Number.isFinite(yNum)) return { year: '', month: String(mNum), yearMonth: '' };
  const year = String(yNum);
  const month = String(mNum);
  const yearMonth = `${yNum}年${mNum}月`;
  return { year, month, yearMonth };
}
