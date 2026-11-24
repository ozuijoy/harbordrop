import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../src/fs/client";

// fs/client 經 ../api 在模組載入時讀 location.origin；Node 測試環境先補上
vi.stubGlobal("location", { origin: "http://test.invalid" });
// 上傳請求一律離線失敗，避免測試打真網路
vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

type Client = typeof import("../src/fs/client");
let c: Client;

const mkItem = (id: number, status: QueueItem["status"]): QueueItem => ({
  id,
  file: new File(["x"], `f${id}.txt`),
  dir: "/",
  status,
  progress: null,
  speed: 0,
  error: status === "error" ? "boom" : "",
  retryMsg: status === "error" ? "第 1 次重試" : "",
});

describe("檔案總管上傳佇列：全部重試", () => {
  beforeAll(async () => {
    c = await import("../src/fs/client");
  });
  beforeEach(() => {
    // 並行數 0：pump 不啟動上傳，狀態可確定斷言
    c.queue.items = [];
    c.queue.concurrency = 0;
  });

  it("只重試失敗的項目，成功／等待中／已取消的不動，並清除錯誤訊息", () => {
    c.queue.items = [mkItem(1, "done"), mkItem(2, "error"), mkItem(3, "waiting"), mkItem(4, "error"), mkItem(5, "canceled")];
    c.retryAllFailed();
    expect(c.queue.items.map((i) => i.status)).toEqual(["done", "waiting", "waiting", "waiting", "canceled"]);
    expect(c.queue.items[1].error).toBe("");
    expect(c.queue.items[1].retryMsg).toBe("");
    expect(c.queue.items[3].error).toBe("");
  });

  it("沒有失敗項目時不做任何事", () => {
    c.queue.items = [mkItem(1, "done"), mkItem(2, "waiting")];
    c.retryAllFailed();
    expect(c.queue.items.map((i) => i.status)).toEqual(["done", "waiting"]);
  });

  it("重試後又失敗，可再全部重試", () => {
    c.queue.items = [mkItem(1, "error")];
    c.retryAllFailed();
    expect(c.queue.items[0].status).toBe("waiting");
    // 模擬重試後再度失敗
    Object.assign(c.queue.items[0], { status: "error", error: "boom2" });
    c.retryAllFailed();
    expect(c.queue.items[0].status).toBe("waiting");
    expect(c.queue.items[0].error).toBe("");
  });

  it("重試沿用 pump 並行控制：一次只啟動 concurrency 個", () => {
    c.queue.concurrency = 1;
    c.queue.items = [mkItem(1, "error"), mkItem(2, "error"), mkItem(3, "error")];
    c.retryAllFailed();
    // run() 同步把第一個設為 running，其餘留在 waiting；上傳隨即離線失敗（背景，不影響斷言）
    expect(c.queue.items.map((i) => i.status)).toEqual(["running", "waiting", "waiting"]);
  });

  it("逐檔重試不受影響", () => {
    c.queue.items = [mkItem(1, "error"), mkItem(2, "error")];
    c.retryItem(c.queue.items[0]);
    expect(c.queue.items.map((i) => i.status)).toEqual(["waiting", "error"]);
  });
});

describe("檔案總管上傳佇列：清除已完成", () => {
  beforeAll(async () => {
    c = await import("../src/fs/client");
  });
  beforeEach(() => {
    c.queue.items = [];
    c.queue.concurrency = 0;
  });

  it("只清除已成功（done）的項目，失敗的保留以便重試，等待中／進行中／已取消的不動", () => {
    c.queue.items = [mkItem(1, "done"), mkItem(2, "error"), mkItem(3, "waiting"), mkItem(4, "canceled"), mkItem(5, "done")];
    c.clearFinished();
    expect(c.queue.items.map((i) => i.status)).toEqual(["error", "waiting", "canceled"]);
    // 失敗項目的錯誤訊息保留，重試按鈕還在
    expect(c.queue.items[0].error).toBe("boom");
  });

  it("只剩已成功項目時佇列清空", () => {
    c.queue.items = [mkItem(1, "done"), mkItem(2, "done")];
    c.clearFinished();
    expect(c.queue.items).toEqual([]);
  });

  it("沒有已成功項目時不做任何事", () => {
    c.queue.items = [mkItem(1, "error"), mkItem(2, "waiting")];
    c.clearFinished();
    expect(c.queue.items.map((i) => i.status)).toEqual(["error", "waiting"]);
  });
});

describe("上傳錯誤訊息：不顯示 [object Object]", () => {
  it("一般 Error 原樣回傳", () => {
    expect(c.readableError(new Error("boom"))).toBe("boom");
  });

  it("HubApiError 形狀：取出 data.error.message", () => {
    const e: any = new Error("[object Object]. URL: https://x.example/commit/main");
    e.data = { error: { code: "bad_request", message: "commit 內容不符" } };
    expect(c.readableError(e)).toBe("commit 內容不符");
  });

  it("純物件 {error: 字串}：用該字串", () => {
    expect(c.readableError({ error: "oops" })).toBe("oops");
  });

  it("純物件 {error: {message}}：用裡面的 message", () => {
    expect(c.readableError({ error: { message: "nested" } })).toBe("nested");
  });

  it("去不掉的物件：JSON 化，不出現 [object Object]", () => {
    const out = c.readableError({ code: 1 });
    expect(out).toBe('{"code":1}');
    expect(out).not.toContain("[object Object]");

  });
});
