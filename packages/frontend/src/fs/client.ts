import { reactive } from "vue";
import { HdApiError, LocalStorageResumeStore, folderDirname, type FolderItem, type ProgressInfo, type UploadHooks } from "@harbordrop/shared/upload";
import { fsUpload, fsUploadBatch, type FsBatchFile, type ProxyPut } from "./upload";
import { api } from "../api";

/** 檔案總管前端 API（/api/fs/*）。目錄解鎖權杖存在 sessionStorage，以 X-Fs-Token 或 ?fsToken= 帶上 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modifiedAt: number | null;
  mime: string | null;
  mount?: boolean;
  hidden?: boolean;
  downloadUrl?: string;
}
export interface FsListResponse {
  path: string;
  entries: FsEntry[];
  cursor: string | null;
  mount: { id: number; path: string; readonly: boolean } | null;
  headerMd: string | null;
  readmeMd: string | null;
}
export interface FsMetaResponse {
  path: string;
  passwordRequired: boolean;
  passwordPath: string | null;
  unlocked: boolean;
  headerMd: string | null;
  readmeMd: string | null;
}
export interface TransferResponse {
  ok: boolean;
  done: number;
  queued: number;
  taskId: string | null;
}

const TOKEN_KEY = "hd-fs-tokens";
function loadTokens(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}
export const fsTokens = reactive<Record<string, string>>(loadTokens());
export function saveToken(path: string, token: string) {
  fsTokens[path] = token;
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(fsTokens));
}
export const tokenHeader = (): Record<string, string> => {
  const v = Object.values(fsTokens).join(",");
  return v ? { "X-Fs-Token": v } : {};
};
const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export function downloadUrl(path: string, inline = false): string {
  const tok = Object.values(fsTokens).join(",");
  return `/api/fs/download?${q({ path, inline: inline ? 1 : undefined, fsToken: tok || undefined })}`;
}

const j = <T>(method: string, path: string, body?: unknown) => api.json<T>(method, path, body, tokenHeader());

export const fs = {
  list: (path: string, cursor?: string) => j<FsListResponse>("GET", `/api/fs/list?${q({ path, cursor })}`),
  get: (path: string) => j<FsEntry>("GET", `/api/fs/get?${q({ path })}`),
  meta: (path: string) => j<FsMetaResponse>("GET", `/api/fs/meta?${q({ path })}`),
  unlock: async (path: string, password: string) => {
    const r = await j<{ ok: boolean; token: string | null; path: string | null }>("POST", "/api/fs/unlock", { path, password });
    if (r.token && r.path) saveToken(r.path, r.token);
    return r;
  },
  mkdir: (path: string) => j<{ ok: boolean; path: string }>("POST", "/api/fs/mkdir", { path }),
  rename: (path: string, name: string) => j<{ ok: boolean; path: string }>("POST", "/api/fs/rename", { path, name }),
  remove: (paths: string[]) => j<{ ok: boolean; deleted: number }>("POST", "/api/fs/delete", { paths }),
  copy: (paths: string[], dst: string) => j<TransferResponse>("POST", "/api/fs/copy", { paths, dst }),
  move: (paths: string[], dst: string) => j<TransferResponse>("POST", "/api/fs/move", { paths, dst }),
  share: (path: string, share: Record<string, unknown>) => j<{ url: string; share: any }>("POST", "/api/fs/share", { path, share }),
};

export const isPasswordError = (e: unknown) => e instanceof HdApiError && e.code === "password_required";

// ───────── 上傳 ─────────
/** 經後端 PUT（XHR 才有上傳進度） */
const xhrPut: ProxyPut = (url, file, headers, hooks) =>
  new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if ((file as File).type) x.setRequestHeader("Content-Type", (file as File).type);
    x.upload.onprogress = (e) => hooks.onProgress?.({ phase: "uploading", fraction: e.total ? e.loaded / e.total : 0, loaded: e.loaded, total: file.size });
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let msg = `HTTP ${x.status}`;
      let code = "http_error";
      try {
        const d = JSON.parse(x.responseText);
        msg = d?.error?.message ?? msg;
        code = d?.error?.code ?? code;
      } catch {}
      reject(new HdApiError(x.status, code, msg));
    };
    x.onerror = () => reject(new Error("網路錯誤"));
    x.onabort = () => reject(new DOMException("aborted", "AbortError"));
    hooks.signal?.addEventListener("abort", () => x.abort());
    x.send(file);
  });

/** 上傳一個檔案到目錄 dir */
export async function uploadToDir(dir: string, file: File, hooks: UploadHooks): Promise<void> {
  await fsUpload(api, dir, file, file.name, { ...hooks, headers: tokenHeader(), proxyPut: xhrPut });
}

/**
 * 批次上傳整個資料夾到目錄 dir：一次 commit。儲存不支援批次時
 *（後端回 batch_unsupported），退回逐檔上傳。
 */
export async function uploadBatchToDir(dir: string, entries: FsBatchFile[], hooks: UploadHooks): Promise<void> {
  try {
    await fsUploadBatch(api, dir, entries, { ...hooks, headers: tokenHeader() });
  } catch (e: any) {
    if (e?.code !== "batch_unsupported") throw e;
    const total = entries.reduce((s, x) => s + x.file.size, 0);
    let loaded = 0;
    for (const x of entries) {
      const relDir = folderDirname(x.relativePath);
      const targetDir = relDir ? (dir === "/" ? "" : dir) + "/" + relDir : dir;
      await uploadToDir(targetDir, x.file, {
        ...hooks,
        onProgress: (p) => {
          const cur = p.loaded ?? p.fraction * p.total;
          hooks.onProgress?.({ phase: p.phase, fraction: total ? (loaded + cur) / total : 1, loaded: loaded + cur, total });
        },
      });
      loaded += x.file.size;
    }
    hooks.onProgress?.({ phase: "done", fraction: 1, loaded: total, total });
  }
}

// ───────── 上傳佇列 ─────────
export interface QueueItem {
  id: number;
  file: File;
  dir: string;
  /** 文件夾上傳時，該檔在文件夾內的相對路徑（顯示用） */
  relativePath?: string;
  /** 完成後要刷新的目錄（文件夾上傳時為最上層目錄，未填 = dir） */
  notifyDir?: string;
  /** 批次上傳（整個資料夾一次 commit）：整批檔案；有此欄位時 file 只作顯示備援 */
  batch?: { entries: FsBatchFile[] };
  /** 佇列顯示名稱（批次上傳用；未填 = relativePath ?? file.name） */
  label?: string;
  status: "waiting" | "running" | "done" | "error" | "canceled";
  progress: ProgressInfo | null;
  speed: number;
  error: string;
  retryMsg: string;
  ctrl?: AbortController;
}
let seq = 0;
export const queue = reactive<{ items: QueueItem[]; concurrency: number }>({ items: [], concurrency: 2 });
const listeners = new Set<(dir: string) => void>();
export function onUploaded(fn: (dir: string) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function enqueue(dir: string, files: File[]) {
  for (const file of files) queue.items.push({ id: ++seq, file, dir, status: "waiting", progress: null, speed: 0, error: "", retryMsg: "" });
  pump();
}

/** 文件夾上傳：整批檔案一個佇列項目、一次 commit，保留文件夾結構；完成後刷新最上層目錄 */
export function enqueueFolder(dir: string, items: FolderItem[]) {
  if (!items.length) return;
  const entries: FsBatchFile[] = items.map((it) => ({ file: it.file as File, relativePath: it.relativePath }));
  queue.items.push({
    id: ++seq,
    file: items[0].file as File,
    dir,
    batch: { entries },
    label: `資料夾上傳（${items.length} 個檔案）`,
    notifyDir: dir,
    status: "waiting",
    progress: null,
    speed: 0,
    error: "",
    retryMsg: "",
  });
  pump();
}

/** 拖放上傳：拖入資料夾（相對路徑含子目錄）走一次 commit 的批次；拖入零散檔案走逐檔上傳（一檔一次 commit） */
export function enqueueDropped(dir: string, items: FolderItem[]) {
  if (!items.length) return;
  if (items.some((it) => it.relativePath.includes("/"))) enqueueFolder(dir, items);
  else enqueue(dir, items.map((it) => it.file as File));
}
export function retryItem(it: QueueItem) {
  Object.assign(it, { status: "waiting", error: "", retryMsg: "", progress: null, speed: 0 });
  pump();
}
/** 全部重試：只把失敗（error）的項目放回等待佇列，成功／等待中／進行中／已取消的不動；沿用既有 pump 並行控制。重試後又失敗的項目可再全部重試 */
export function retryAllFailed() {
  let n = 0;
  for (const it of queue.items) {
    if (it.status !== "error") continue;
    Object.assign(it, { status: "waiting", error: "", retryMsg: "", progress: null, speed: 0 });
    n++;
  }
  if (n) pump();
}
export function cancelItem(it: QueueItem) {
  if (it.status === "running") it.ctrl?.abort();
  else if (it.status === "waiting") it.status = "canceled";
}
/** 清除已完成：只移除已成功（done）的項目；失敗（error）與已取消的保留以便重試，等待中／進行中的也不動 */
export function clearFinished() {
  queue.items = queue.items.filter((i) => i.status !== "done");
}

function pump() {
  const running = queue.items.filter((i) => i.status === "running").length;
  const next = queue.items.filter((i) => i.status === "waiting").slice(0, Math.max(0, queue.concurrency - running));
  for (const it of next) void run(it);
}

async function run(it0: QueueItem) {
  const it = queue.items.find((i) => i.id === it0.id) ?? it0; // 取 reactive 代理
  it.status = "running";
  it.ctrl = new AbortController();
  let lastT = performance.now();
  let lastB = 0;
  const hooks: UploadHooks = {
    signal: it.ctrl.signal,
    resume: new LocalStorageResumeStore(`hd-fs-resume:${it.dir}`),
    onProgress: (p) => {
      it.progress = p;
      const loaded = p.loaded ?? p.fraction * p.total;
      const now = performance.now();
      if (now - lastT >= 500) {
        it.speed = Math.max(0, ((loaded - lastB) * 1000) / (now - lastT));
        lastT = now;
        lastB = loaded;
      }
    },
    onRetry: (r) => (it.retryMsg = `第 ${r.attempt} 次重試（${r.kind}）`),
  };
  try {
    if (it.batch) await uploadBatchToDir(it.dir, it.batch.entries, hooks);
    else await uploadToDir(it.dir, it.file, hooks);
    it.status = "done";
    it.speed = 0;
    listeners.forEach((f) => f(it.notifyDir ?? it.dir));
  } catch (e: any) {
    it.status = it.ctrl.signal.aborted ? "canceled" : "error";
    it.error = it.status === "canceled" ? "" : readableError(e);
  } finally {
    pump();
  }
}

/** 錯誤可能是純物件（無 message），直接 String() 會變成 "[object Object]"；先拆出裡面的訊息。 */
export function readableError(e: any): string {
  if (e instanceof Error && e.message && !e.message.startsWith("[object Object]")) return e.message;
  const inner = e?.data?.error ?? e?.error;
  if (typeof inner === "string" && inner) return inner;
  if (typeof inner?.message === "string" && inner.message) return inner.message;
  if (typeof e?.message === "string" && e.message) return e.message.replace(/^\[object Object\]\.?\s*/, "") || JSON.stringify(e);
  try {
    return JSON.stringify(e) || String(e);
  } catch {
    return String(e);
  }
}
