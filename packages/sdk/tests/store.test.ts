import { describe, expect, it } from 'vitest';
import { createReportStore, type StoredReport } from '../src/store';
import type { BugReelReport } from '../src/types';
import { meta } from './helpers';

const report = (capturedAt: number): BugReelReport => ({
  schemaVersion: '1.0',
  meta: { ...meta, capturedAt },
  reporterAnswers: { tryingToDo: 'checkout', wentWrong: '500' },
  findings: [],
  storySteps: [],
  events: [],
  network: [],
  console: [],
  outputs: { markdown: '# report' },
});

/** Minimal in-memory IndexedDB — just the open/transaction/put/getAll surface. */
const fakeIDB = (options: { failOpen?: boolean } = {}) => {
  const records = new Map<string, StoredReport>();
  const succeed = <T>(result: T, extra: Record<string, unknown> = {}) => {
    const req = {
      result,
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
      ...extra,
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const fail = () => {
    const req = {
      result: undefined,
      error: new Error('idb denied'),
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };
    queueMicrotask(() => req.onerror?.());
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore: () => ({}),
    transaction: () => ({
      objectStore: () => ({
        put(record: StoredReport) {
          records.set(record.id, record);
          return succeed(record.id);
        },
        getAll() {
          return succeed([...records.values()]);
        },
      }),
    }),
  };
  const idb = {
    open: () => (options.failOpen ? fail() : succeed(db)),
  } as unknown as IDBFactory;
  return { idb, records };
};

describe('createReportStore', () => {
  it('returns undefined when IndexedDB is unavailable', () => {
    expect(createReportStore(undefined)).toBeUndefined();
    expect(createReportStore({} as IDBFactory)).toBeUndefined();
  });

  it('saveReport persists the report and resolves its id', async () => {
    const { idb, records } = fakeIDB();
    const store = createReportStore(idb)!;
    const id = await store.saveReport(report(1_700_000_000_000));
    expect(id).toContain('1700000000000:');
    expect(records.size).toBe(1);
    const saved = [...records.values()][0]!;
    expect(saved.capturedAt).toBe(1_700_000_000_000);
    expect(saved.url).toBe('https://app.test/checkout');
    expect(saved.report.reporterAnswers.tryingToDo).toBe('checkout');
  });

  it('listReports returns newest-first metas without payloads', async () => {
    const { idb } = fakeIDB();
    const store = createReportStore(idb)!;
    await store.saveReport(report(100));
    await store.saveReport(report(300));
    await store.saveReport(report(200));
    const list = await store.listReports();
    expect(list.map((r) => r.capturedAt)).toEqual([300, 200, 100]);
    expect(list[0]).not.toHaveProperty('report');
  });

  it('never rejects — a denied open resolves undefined / []', async () => {
    const { idb } = fakeIDB({ failOpen: true });
    const store = createReportStore(idb)!;
    await expect(store.saveReport(report(1))).resolves.toBeUndefined();
    await expect(store.listReports()).resolves.toEqual([]);
  });
});
