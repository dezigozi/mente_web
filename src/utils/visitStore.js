/**
 * NCS訪問管理の保存先（訪問リスト・訪問記録）
 *
 * いまはこのブラウザの IndexedDB に保存。画面はここの関数だけを呼ぶので、
 * みんなで共有するときは中身をサーバー（Supabase など）向けに差し替える。
 * MaintReportDB は「最新データに更新」で丸ごと消える（clearCache）ため、別DBにしている。
 */

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

export const newId = () =>
  (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 訪問リスト: { id, name, createdAt, factories: [{ key, tel, address, pref, contact }] } */
export const listLists = async () =>
  (await getAll(LISTS)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
export const saveList = (list) => write(LISTS, s => s.put(list));
export const deleteList = async (id) => {
  const visits = (await getAll(VISITS)).filter(v => v.listId === id);
  await write(LISTS, s => s.delete(id));
  if (visits.length) await write(VISITS, s => visits.forEach(v => s.delete(v.id)));
};

/** 訪問記録: { id, listId, factoryKey, tel, date:'YYYY-MM-DD', visitor, contact, result, memo, nextDate } */
export const listVisits = async () =>
  (await getAll(VISITS)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
export const saveVisit = (visit) => write(VISITS, s => s.put(visit));
export const deleteVisit = (id) => write(VISITS, s => s.delete(id));

/** バックアップ用に全件まとめて返す */
export const exportAll = async () => ({
  app: 'mente_web_ncs_visit',
  version: 1,
  exportedAt: new Date().toISOString(),
  lists: await getAll(LISTS),
  visits: await getAll(VISITS),
});

/** バックアップの読み込み（同じ id は上書き、ないものは追加） */
export const importAll = async (data) => {
  if (!data || data.app !== 'mente_web_ncs_visit') throw new Error('NCS訪問データのバックアップじゃないみたい');
  const lists = Array.isArray(data.lists) ? data.lists.filter(x => x?.id) : [];
  const visits = Array.isArray(data.visits) ? data.visits.filter(x => x?.id) : [];
  if (lists.length) await write(LISTS, s => lists.forEach(x => s.put(x)));
  if (visits.length) await write(VISITS, s => visits.forEach(x => s.put(x)));
  return { lists: lists.length, visits: visits.length };
};
