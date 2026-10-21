/**
 * mente_web「NCS訪問管理」の共有保存先（Google Apps Script ウェブアプリ）
 *
 * 置き場所: 特販部_営業訪問ログ のブックに 2 シート（NCS工場_訪問リスト / NCS工場_訪問記録）を足して使う。
 * Sales Pro の Code.gs とは別のスクリプト（script.google.com で新規作成）にして、Sales Pro には触らない。
 *
 * 初回だけ:
 *   1. 下の SHEET_ID にブックの ID を入れる
 *   2. setup を実行 → シートができて、共有キーがログに出る（営業のみんなに伝える）
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」/ 実行ユーザー「自分」/ アクセス「全員」→ /exec の URL を mente_web に設定
 * コードを直したら「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」で更新（URL は変わらない）
 */

const SHEET_ID = 'ここにブックのIDを入れる';

const SHEETS = {
  lists: { name: 'NCS工場_訪問リスト', cols: ['id', 'name', 'createdAt', 'updatedAt', 'factories'] },
  visits: {
    name: 'NCS工場_訪問記録',
    cols: ['id', 'listId', 'factoryKey', 'tel', 'date', 'visitor', 'contact', 'result', 'memo', 'nextDate', 'createdAt'],
  },
};

function setup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(SHEETS).forEach(k => {
    const def = SHEETS[k];
    const sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SHARE_KEY')) {
    props.setProperty('SHARE_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 8));
  }
  Logger.log('共有キー: ' + props.getProperty('SHARE_KEY'));
}

function doGet() {
  return json_({ ok: true, app: 'mente_web_ncs_visit' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'リクエストが読めない' });
  }
  if (!req.key || req.key !== PropertiesService.getScriptProperties().getProperty('SHARE_KEY')) {
    return json_({ ok: false, error: 'unauthorized' });
  }
  const lock = LockService.getScriptLock();
  try {
    if (req.action !== 'all') lock.waitLock(20000);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    switch (req.action) {
      case 'all':
        return json_({ ok: true, lists: readAll_(ss, 'lists'), visits: readAll_(ss, 'visits') });
      case 'saveList':
        upsert_(ss, 'lists', [req.list]);
        return json_({ ok: true });
      case 'deleteList':
        deleteWhere_(ss, 'visits', r => r.listId === req.id);
        deleteWhere_(ss, 'lists', r => r.id === req.id);
        return json_({ ok: true });
      case 'saveVisit':
        upsert_(ss, 'visits', [req.visit]);
        return json_({ ok: true });
      case 'deleteVisit':
        deleteWhere_(ss, 'visits', r => r.id === req.id);
        return json_({ ok: true });
      case 'importAll':
        upsert_(ss, 'lists', req.lists || []);
        upsert_(ss, 'visits', req.visits || []);
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) { /* 取っていないとき */ }
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(ss, kind) {
  const sh = ss.getSheetByName(SHEETS[kind].name);
  if (!sh) throw new Error('シートがない: ' + SHEETS[kind].name + '（setup を実行してね）');
  return sh;
}

function readAll_(ss, kind) {
  const cols = SHEETS[kind].cols;
  const sh = sheet_(ss, kind);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const out = [];
  values.forEach(row => {
    if (!row[0]) return;
    const o = {};
    cols.forEach((c, i) => {
      const v = row[i];
      o[c] = v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd') : String(v);
    });
    if (kind === 'lists') {
      try { o.factories = JSON.parse(o.factories || '[]'); } catch (err) { o.factories = []; }
    }
    out.push(o);
  });
  return out;
}

/** 数式として解釈されないよう先頭に ' を付ける */
function cell_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function upsert_(ss, kind, items) {
  if (!items.length) return;
  const cols = SHEETS[kind].cols;
  const sh = sheet_(ss, kind);
  const last = sh.getLastRow();
  const ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
  const rowOf = {};
  ids.forEach((id, i) => { if (id) rowOf[id] = i + 2; });
  const now = new Date().toISOString();
  const appends = [];
  items.forEach(item => {
    if (!item || !item.id) return;
    const o = Object.assign({}, item);
    if (kind === 'lists') {
      o.updatedAt = now;
      o.factories = JSON.stringify(o.factories || []);
    }
    const row = cols.map(c => cell_(o[c]));
    if (rowOf[o.id]) sh.getRange(rowOf[o.id], 1, 1, cols.length).setValues([row]);
    else appends.push(row);
  });
  if (appends.length) {
    const start = sh.getLastRow() + 1;
    const range = sh.getRange(start, 1, appends.length, cols.length);
    range.setNumberFormat('@');
    range.setValues(appends);
  }
}

function deleteWhere_(ss, kind, pred) {
  const cols = SHEETS[kind].cols;
  const sh = sheet_(ss, kind);
  const last = sh.getLastRow();
  if (last < 2) return;
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  // 下から消すと行番号がずれない
  for (let i = values.length - 1; i >= 0; i--) {
    const o = {};
    cols.forEach((c, j) => { o[c] = String(values[i][j]); });
    if (o.id && pred(o)) sh.deleteRow(i + 2);
  }
}
