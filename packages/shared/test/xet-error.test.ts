import { describe, expect, it } from "vitest";
import { hubErrorMessage } from "../src/upload/xet";

describe("上傳錯誤訊息：HubApiError 的 [object Object]", () => {
  it("後端 {error: {code, message}} 形狀：取出真正的訊息，保留 URL", () => {
    const e: any = new Error('[object Object]. URL: https://x.example/api/uploads/abc/action/hub/api/datasets/harbordrop/upload/commit/main');
    e.data = { error: { code: "bad_request", message: "commit 內容不符" } };
    expect(hubErrorMessage(e)).toBe(
      "commit 內容不符. URL: https://x.example/api/uploads/abc/action/hub/api/datasets/harbordrop/upload/commit/main",
    );
  });

  it("HF 形狀 {error: 字串}：直接用該字串", () => {
    const e: any = new Error("Api error with status 403. URL: https://huggingface.co/api/datasets/x/y/commit/main");
    e.data = { error: "Access denied" };
    expect(hubErrorMessage(e)).toBe("Access denied. URL: https://huggingface.co/api/datasets/x/y/commit/main");
  });

  it("一般 Error：原樣回傳", () => {
    expect(hubErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("純物件：JSON 化，不出現 [object Object]", () => {
    expect(hubErrorMessage({ code: "weird" })).toBe('{"code":"weird"}');
    expect(hubErrorMessage({ code: "weird" })).not.toContain("[object Object]");
  });
});
