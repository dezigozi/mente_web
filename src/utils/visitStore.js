/**
 * NCS訪問管理の保存先（訪問リスト・訪問記録）
 *
 * - 共有: NCS_GAS_URL があれば GAS 経由で「特販部_営業訪問ログ」のシートに読み書き（共有キー必須）
 * - ブラウザ内: URL が空のときは IndexedDB（NcsVisitDB）
 *   MaintReportDB は「最新データに更新」で丸ごと消える（clearCache）ため、別DBにしている。
 * 画面はここの関数だけを呼ぶ。
 */
import { NCS_GAS_URL } from '../config/ncsShare';

const SHARE_KEY_LS = 'ncs_share_key_v1';
const MIGRATED_LS = 'ncs_local_migrated_v1';

const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* 保存できない環境 */ } };

export const getShareKey = () => lsGet(SHARE_KEY_LS);
export const setShareKey = (k) => lsSet(SHARE_KEY_LS, String(k || '').trim());

/** 'shared' = スプレッドシート共有 / 'needKey' = 共有だけど共有キー未入力 / 'local' = このブラウザだけ */
export const storeMode = () => (!NCS_GAS_URL ? 'local' : getShareKey() ? 'shared' : 'needKey');

// ---------- 共有（GAS） ----------
const gas = async (action, body = {}) => {
  let res;
  try {
    // text/plain にして CORS のプリフライトを避ける（GAS は OPTIONS を受けられない）
    res = await fetch(NCS_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: getShareKey(), action, ...body }),
    });
  } catch {
    throw new Error('共有先（スプレッドシート）に繋がらなかったよ。ネットを確認してね');
  }
  if (!res.ok) throw new Error(`共有先の応答がおかしいよ (${res.status})`);
  const data = await res.json();
  if (!data.ok) {
    const e = new Error(data.error === 'unauthorized' ? '共有キーが違うみたい' : data.error || '共有先でエラー');
    e.code = data.error === 'unauthorized' ? 'unauthorized' : 'gas';
    throw e;
  }
  return data;
};

// ---------- ブラウザ内（IndexedDB） ----------
const DB_NAME = 'NcsVisitDB';
const DB_VERSION = 1;
const LISTS = 'lists';
const VISITS = 'visits';

let dbPromise = null;
const openDB = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(LISTS)) db.createObjectStore(LISTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(VISITS)) db.createObjectStore(VISITS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
};
const getAll = async (store) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
};
const write = async (store, fn) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    fn(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
const localLoad = async () => ({ lists: await getAll(LISTS), visits: await getAll(VISITS) });

// ---------- 画面から呼ぶ関数 ----------
/** 共有なら true。共有キー未入力のままブラウザ内に書いてしまわないよう止める */
const isShared = () => {
  const m = storeMode();
  if (m === 'needKey') throw new Error('共有キーを入れてね');
  return m === 'shared';
};

export const newId = () =>
  (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * 訪問リスト: { id, name, createdAt, factories: [{ key, tel, address, pref, contact }] }
 * 訪問記録:   { id, listId, factoryKey, tel, date:'YYYY-MM-DD', visitor, contact, result, memo, nextDate, createdAt }
 */
export const loadAll = async () => {
  const { lists, visits } = isShared() ? await gas('all') : await localLoad();
  return {
    lists: [...lists].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    visits: [...visits].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt))),
  };
};

export const saveList = (list) =>
  isShared() ? gas('saveList', { list }) : write(LISTS, s => s.put(list));

export const deleteList = async (id) => {
  if (isShared()) return gas('deleteList', { id });
  const visits = (await getAll(VISITS)).filter(v => v.listId === id);
  await write(LISTS, s => s.delete(id));
  if (visits.length) await write(VISITS, s => visits.forEach(v => s.delete(v.id)));
};

export const saveVisit = (visit) =>
  isShared() ? gas('saveVisit', { visit }) : write(VISITS, s => s.put(visit));

export const deleteVisit = (id) =>
  isShared() ? gas('deleteVisit', { id }) : write(VISITS, s => s.delete(id));

/** バックアップ用に全件まとめて返す */
export const exportAll = async () => ({
  app: 'mente_web_ncs_visit',
  version: 1,
  exportedAt: new Date().toISOString(),
  ...(await loadAll()),
});

/** バックアップの読み込み（同じ id は上書き、ないものは追加） */
export const importAll = async (data) => {
  if (!data || data.app !== 'mente_web_ncs_visit') throw new Error('NCS訪問データのバックアップじゃないみたい');
  const lists = Array.isArray(data.lists) ? data.lists.filter(x => x?.id) : [];
  const visits = Array.isArray(data.visits) ? data.visits.filter(x => x?.id) : [];
  if (isShared()) {
    await gas('importAll', { lists, visits });
  } else {
    if (lists.length) await write(LISTS, s => lists.forEach(x => s.put(x)));
    if (visits.length) await write(VISITS, s => visits.forEach(x => s.put(x)));
  }
  return { lists: lists.length, visits: visits.length };
};

/** 共有前にこのブラウザだけに保存していた分（共有へ移す案内用。移したあとは空扱い） */
export const localLeftovers = async () => {
  if (lsGet(MIGRATED_LS)) return { lists: [], visits: [] };
  try { return await localLoad(); } catch { return { lists: [], visits: [] }; }
};

/** ブラウザ内の分を共有へ送る（ブラウザ内のデータは消さずに、移した印だけ付ける） */
export const migrateLocalToShared = async () => {
  const { lists, visits } = await localLoad();
  if (lists.length || visits.length) await gas('importAll', { lists, visits });
  lsSet(MIGRATED_LS, new Date().toISOString());
  return { lists: lists.length, visits: visits.length };
};
