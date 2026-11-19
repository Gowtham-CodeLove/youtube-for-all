// Video files of Ready to Post / queued clips, kept in this browser.
// A plain in-memory map gives instant, synchronous reads (the upload code needs that); every write also goes
// to IndexedDB, so the clips are still there after a reload or a browser restart. Blobs read back from
// IndexedDB are backed by disk, so holding them all costs almost no memory.

import { useSyncExternalStore } from "react";

export type ClipFiles = {
  video: Blob;
  thumb?: Blob | null;
  /** The clip as it first arrived, before any edit in the Clip Studio — for "Restore original". */
  original?: Blob | null;
};

const memory = new Map<string, ClipFiles>();
const listeners = new Set<() => void>();
let version = 0;

const notify = () => {
  version++;
  for (const l of listeners) l();
};

// ---------- IndexedDB ----------

const DB_NAME = "utubeflow-clips";
const STORE = "clips";
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Everything saved earlier comes back into memory once, at start.
let hydrated = false;
const hydration: Promise<void> = (async () => {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        const id = String(cur.key);
        const v = cur.value as ClipFiles | null;
        if (v?.video instanceof Blob && !memory.has(id)) memory.set(id, v);
        cur.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
})().finally(() => {
  hydrated = true;
  notify();
});

/** Resolves once the clips saved in earlier visits are loaded. */
export const clipsReady = () => hydration;
export const clipsHydrated = () => hydrated;

// ---------- API ----------

export const hasClip = (id: string) => memory.has(id);
export const getClip = (id: string) => memory.get(id);

/** Saves (or replaces) a clip's files, in memory at once and on disk in the background. */
export function putClip(id: string, files: ClipFiles) {
  const prev = memory.get(id);
  const next: ClipFiles = { video: files.video, thumb: files.thumb ?? null, original: files.original ?? prev?.original ?? null };
  memory.set(id, next);
  notify();
  void tx("readwrite", (s) => s.put(next, id));
}

export function deleteClip(id: string) {
  if (!memory.delete(id)) {
    void tx("readwrite", (s) => s.delete(id));
    return;
  }
  notify();
  void tx("readwrite", (s) => s.delete(id));
}

/** Re-renders the caller whenever any clip is added, changed or removed. */
export function useClipsVersion() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
    () => 0,
  );
}

// ---------- Clip facts (length, size), read once per file ----------

export type ClipInfo = { durationSec: number; width: number; height: number; hasAudio: boolean };
const infoCache = new WeakMap<Blob, Promise<ClipInfo | null>>();

export function clipInfo(blob: Blob): Promise<ClipInfo | null> {
  let p = infoCache.get(blob);
  if (!p) {
    p = (async () => {
      try {
        const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        try {
          const track = await input.getPrimaryVideoTrack();
          const audio = await input.getPrimaryAudioTrack();
          const durationSec = await input.computeDuration();
          return { durationSec, width: track?.displayWidth ?? 0, height: track?.displayHeight ?? 0, hasAudio: !!audio };
        } finally {
          input.dispose();
        }
      } catch {
        return null;
      }
    })();
    infoCache.set(blob, p);
  }
  return p;
}
