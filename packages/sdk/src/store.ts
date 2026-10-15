import { uuid } from './util';
import type { BugReelReport } from './types';

const DB_NAME = 'bugreel';
const DB_VERSION = 1;
const STORE = 'reports';

/** Record persisted under the `reports` object store — report JSON plus lookup fields. */
export interface StoredReport {
  id: string;
  capturedAt: number;
  url: string;
  report: BugReelReport;
}

/** What listReports returns — identity and sort fields only, no payload. */
export interface StoredReportMeta {
  id: string;
  capturedAt: number;
  url: string;
}

/**
 * Mode-1 persistence seam (offline Routing, ADR-0001). Kept intentionally
 * tiny — save a report, list what has been saved. The modal gets a store via
 * deps so tests can substitute a fake.
 */
export interface ReportStore {
  /** Persist the report; resolves the record id, or undefined when IndexedDB failed. */
  saveReport(report: BugReelReport): Promise<string | undefined>;
  /** Newest-first index of saved reports. Never rejects — a broken store yields []. */
  listReports(): Promise<StoredReportMeta[]>;
}

/** IDB request -> Promise; rejections are handled by the caller's catch. */
const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const openDatabase = (idb: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      } catch {
        /* a failed upgrade still resolves via onsuccess/onerror below */
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const metaOf = (record: StoredReport): StoredReportMeta => ({
  id: record.id,
  capturedAt: record.capturedAt,
  url: record.url,
});

/**
 * Create the tiny IndexedDB-backed store. Returns undefined where IndexedDB
 * does not exist (tests, strict privacy modes) — callers degrade silently.
 * The database opens lazily on first use so creating the store is free.
 */
export function createReportStore(
  indexedDB: IDBFactory | undefined = globalThis.indexedDB,
): ReportStore | undefined {
  if (typeof indexedDB?.open !== 'function') return undefined;
  let db: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => (db ??= openDatabase(indexedDB));

  return {
    async saveReport(report) {
      try {
        const capturedAt = Number.isFinite(report?.meta?.capturedAt)
          ? report.meta.capturedAt
          : Date.now();
        const record: StoredReport = {
          id: `${capturedAt}:${uuid()}`,
          capturedAt,
          url: String(report?.meta?.url ?? ''),
          report,
        };
        const tx = (await open()).transaction(STORE, 'readwrite');
        await request(tx.objectStore(STORE).put(record));
        return record.id;
      } catch {
        return undefined;
      }
    },

    async listReports() {
      try {
        const tx = (await open()).transaction(STORE, 'readonly');
        const all = (await request(tx.objectStore(STORE).getAll())) as StoredReport[];
        return all.map(metaOf).sort((a, b) => b.capturedAt - a.capturedAt);
      } catch {
        return [];
      }
    },
  };
}
