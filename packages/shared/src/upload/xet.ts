import { commitIter } from "@huggingface/hub";
import type { UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import { retryingFetch, urlOf, type UploadHooks, type UploadStats } from "./common";

/**
 * HuggingFace Xet 直傳（瀏覽器與 Node 共用）。
 *
 * 使用 @huggingface/hub 的 commitIter（內含 wasm 版 xet 切塊／xorb／shard 產生器），
 * 但 hubUrl 指向後端的工作階段代理，因此：
 *  - HF token 永不進入瀏覽器；xet 寫入權杖由後端 xet-token 端點換發（短效）
 *  - xorb／shard 直接 POST 到 cas-server（不經後端）
 *  - 每個 xorb 請求各自指數退避重試；成功的 xorb 記入 ResumeStore，續傳時直接略過
 *  - commit 由後端代為提交（瀏覽器送出的 commit 內容只用來驗證 sha256／大小）
 *  - 批次：多個檔案共用一次 commitIter，後端只送一個 HF commit（HF 每小時
 *    最多 128 次 commit，逐檔提交幾百個小檔一定會被限流 429）
 */

export interface XetBatchEntry {
  /** 瀏覽器端路徑（工作階段檔案清單裡的 clientPath） */
  path: string;
  file: Blob;
}

function makeXetFetch(
  api: HdClient,
  session: UploadInitResponse,
  hooks: UploadHooks,
  stats: UploadStats,
  resumeNamespace: string,
): typeof fetch {
  const sessionPrefix = `${api.baseUrl}/api/uploads/${session.sessionId}/`;
  let xorbIndex = 0;
  let ctrlIndex = 0;
  const base = api.fetch;

  const xetFetch: typeof fetch = async (input, init = {}) => {
    const url = urlOf(input);
    const method = (init.method ?? "GET").toUpperCase();
    // 1) 送往後端代理（preupload / LFS batch / xet-token / commit）：附上上傳權杖
    if (url.startsWith(sessionPrefix)) {
      const headers = new Headers(init.headers);
      headers.set("X-Upload-Token", session.uploadToken);
      const req = { ...init, headers, credentials: "include" as RequestCredentials };
      // commit：可重試狀態碼（408/429/5xx）代表 HF 在建立提交前就拒絕了，重試不會重複提交；
      // 大量小檔案連續提交時 HF 容易限流，指數退避重試可把成功率拉回來。不可重試的狀態
      //（如 400/403/404）直接回傳，由 commitIter 丟出可讀錯誤。
      if (/\/commit\/[^/]+$/.test(url))
        return retryingFetch(base, url, req, { kind: "control", id: "commit", index: ctrlIndex++ }, hooks, stats);
      return retryingFetch(base, url, req, { kind: "control", id: url.slice(sessionPrefix.length), index: ctrlIndex++ }, hooks, stats);
    }
    // 2) xorb 上傳：逐一重試＋續傳略過
    const xorb = /\/v1\/xorbs\/[^/]+\/([0-9a-f]{64})$/.exec(url);
    if (xorb && method === "POST") {
      const key = `${resumeNamespace}:${xorb[1]}`;
      if (await hooks.resume?.has(key)) {
        stats.skipped++;
        return new Response(JSON.stringify({ was_inserted: false }), { status: 200 });
      }
      const r = await retryingFetch(base, url, init, { kind: "xorb", id: xorb[1], index: xorbIndex++ }, hooks, stats);
      if (r.ok) await hooks.resume?.add(key);
      return r;
    }
    if (/\/v1\/shards$/.test(url)) return retryingFetch(base, url, init, { kind: "shard", id: "shard", index: 0 }, hooks, stats);
    if (/\/v1\/chunks\//.test(url)) return retryingFetch(base, url, init, { kind: "dedup", id: url.split("/").pop()!, index: 0 }, hooks, stats);
    // 3) 其他（例如 HF 回退為 LFS 時的 S3 分片 URL）
    return retryingFetch(base, url, init, { kind: "other", id: url.split("?")[0].slice(-40), index: 0 }, hooks, stats);
  };
  return xetFetch;
}

export async function uploadXet(
  api: HdClient,
  session: UploadInitResponse,
  file: Blob,
  hooks: UploadHooks = {},
  resumeNamespace = "xet",
): Promise<UploadStats> {
  const stats: UploadStats = { protocol: "xet", attempts: [], skipped: 0, startedAt: Date.now() };
  const hubUrl = `${api.baseUrl}/api/uploads/${session.sessionId}/action/hub`;
  const xetFetch = makeXetFetch(api, session, hooks, stats, resumeNamespace);
  const c = session.client as { repo: string; path: string; revision: string };
  const iter = commitIter({
    repo: { type: "dataset", name: c.repo },
    operations: [{ operation: "addOrUpdate", path: c.path, content: file }],
    title: "HarborDrop upload",
    hubUrl,
    branch: c.revision,
    fetch: xetFetch,
    useXet: true,
    abortSignal: hooks.signal,
  });
  let phase: "hashing" | "uploading" | "committing" = "hashing";
  let lastEmit = 0;
  try {
    for await (const ev of iter) {
      if (ev.event === "phase") {
        if (ev.phase === "committing") phase = "committing";
        hooks.onProgress?.({ phase, fraction: phase === "committing" ? 1 : 0, total: file.size });
      } else if (ev.event === "fileProgress") {
        const next = ev.state === "hashing" ? "hashing" : "uploading";
        // 雜湊階段事件極多（每個讀取區塊一次），節流到每 100ms 一次
        if (next === phase && ev.progress < 1 && Date.now() - lastEmit < 100) continue;
        lastEmit = Date.now();
        phase = next;
        hooks.onProgress?.({ phase, fraction: ev.progress, loaded: Math.round(ev.progress * file.size), total: file.size });
      }
    }
  } catch (e) {
    throw new Error(hubErrorMessage(e));
  }
  stats.finishedAt = Date.now();
  return stats;
}

/**
 * 批次上傳：多個檔案一次 commitIter、一次 HF commit。
 * session 是批次工作階段（/api/fs/upload/init-batch 回傳），entries 的 path
 * 是該工作階段檔案清單裡的 clientPath。進度是整批彙總（loaded／total 為全部檔案加總）。
 */
export async function uploadXetBatch(
  api: HdClient,
  session: UploadInitResponse,
  entries: XetBatchEntry[],
  hooks: UploadHooks = {},
  resumeNamespace = "xet",
): Promise<UploadStats> {
  if (!entries.length) throw new Error("批次上傳缺少檔案");
  const stats: UploadStats = { protocol: "xet", attempts: [], skipped: 0, startedAt: Date.now() };
  const hubUrl = `${api.baseUrl}/api/uploads/${session.sessionId}/action/hub`;
  const xetFetch = makeXetFetch(api, session, hooks, stats, resumeNamespace);
  const c = session.client as { repo: string; revision: string };
  const total = entries.reduce((s, e) => s + e.file.size, 0);
  const sizes = new Map(entries.map((e) => [e.path, e.file.size]));
  const prog = new Map<string, { fraction: number; state: "hashing" | "uploading" }>();
  let committing = false;
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    let loaded = 0;
    let anyUploading = false;
    for (const [path, p] of prog) {
      loaded += Math.round(p.fraction * (sizes.get(path) ?? 0));
      if (p.state === "uploading") anyUploading = true;
    }
    const phase = committing ? "committing" : anyUploading ? "uploading" : "hashing";
    hooks.onProgress?.({ phase, fraction: total ? loaded / total : 1, loaded, total });
  };
  const iter = commitIter({
    repo: { type: "dataset", name: c.repo },
    operations: entries.map((e) => ({ operation: "addOrUpdate", path: e.path, content: e.file })),
    title: `HarborDrop 批次上傳 ${entries.length} 個檔案`,
    hubUrl,
    branch: c.revision,
    fetch: xetFetch,
    useXet: true,
    abortSignal: hooks.signal,
  });
  try {
    for await (const ev of iter) {
      if (ev.event === "phase") {
        if (ev.phase === "committing") {
          committing = true;
          emit(true);
        }
      } else if (ev.event === "fileProgress") {
        prog.set(ev.path, { fraction: ev.progress, state: ev.state === "hashing" ? "hashing" : "uploading" });
        emit(ev.progress >= 1);
      }
    }
  } catch (e) {
    throw new Error(hubErrorMessage(e));
  }
  emit(true);
  stats.finishedAt = Date.now();
  return stats;
}

/**
 * @huggingface/hub 的 createApiError 會把回應 JSON 的 error 欄位直接放進
 * message；後端回的是 {error: {code, message}} 物件，message 就變成
 * "[object Object]. URL: ..."——先從 data 裡取出真正的訊息再丟出。
 */
export function hubErrorMessage(e: any): string {
  const inner = e?.data?.error;
  const msg = typeof inner === "string" ? inner : inner?.message;
  if (typeof msg === "string" && msg) {
    const m = typeof e?.message === "string" ? e.message : "";
    const trailer = m.includes("URL: ") ? m.slice(m.indexOf("URL: ")) : "";
    return trailer ? `${msg}. ${trailer}` : msg;
  }
  if (typeof e?.message === "string" && e.message && !e.message.startsWith("[object Object]")) return e.message;
  try {
    return JSON.stringify(e?.data ?? e) || String(e);
  } catch {
    return String(e);
  }
}
