// IndexedDB wrapper

const DB_NAME = 'workhours';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('work_records')) {
        db.createObjectStore('work_records', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        const s = db.createObjectStore('settings', { keyPath: 'key' });
        s.transaction.oncomplete = () => {
          const tx = db.transaction('settings', 'readwrite');
          tx.objectStore('settings').put({ key: 'total_annual_leave', value: '18' });
        };
      }
      if (!db.objectStoreNames.contains('company_holidays')) {
        db.createObjectStore('company_holidays', { keyPath: 'date' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function promReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function getRecord(date) {
  const store = await tx('work_records');
  return promReq(store.get(date));
}

export async function getRecords(from, to) {
  const store = await tx('work_records');
  const range = IDBKeyRange.bound(from, to);
  return promReq(store.getAll(range));
}

export async function getAllRecords() {
  const store = await tx('work_records');
  return promReq(store.getAll());
}

export async function saveRecord(record) {
  const store = await tx('work_records', 'readwrite');
  return promReq(store.put(record));
}

export async function deleteRecord(date) {
  const store = await tx('work_records', 'readwrite');
  return promReq(store.delete(date));
}

export async function getSetting(key) {
  const store = await tx('settings');
  const row = await promReq(store.get(key));
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  const store = await tx('settings', 'readwrite');
  return promReq(store.put({ key, value }));
}

export async function getCompanyHolidays() {
  const store = await tx('company_holidays');
  const rows = await promReq(store.getAll());
  const map = {};
  rows.forEach(r => { map[r.date] = r.name; });
  return map;
}

export async function saveCompanyHoliday(date, name) {
  const store = await tx('company_holidays', 'readwrite');
  return promReq(store.put({ date, name }));
}

export async function deleteCompanyHoliday(date) {
  const store = await tx('company_holidays', 'readwrite');
  return promReq(store.delete(date));
}
