const DB_NAME = 'MaintReportDB';
const DB_VERSION = 1;

export const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const getCache = async (key) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readonly');
    const store = tx.objectStore('cache');
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const setCache = async (key, value) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    const store = tx.objectStore('cache');
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const clearCache = async () => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    const store = tx.objectStore('cache');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};
