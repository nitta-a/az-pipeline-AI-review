import { AI_REVIEW_MARKER, MAX_DIFF_CHARS, MAX_FILE_CHARS, SYSTEM_PROMPT } from "../src/constants";

describe("constants", () => {
  test("AI_REVIEW_MARKER が正しい値", () => {
    expect(AI_REVIEW_MARKER).toBe("<!-- AI-REVIEW -->");
  });

  test("MAX_DIFF_CHARS が 30000", () => {
    expect(MAX_DIFF_CHARS).toBe(30000);
  });

  test("MAX_FILE_CHARS が 5000", () => {
    expect(MAX_FILE_CHARS).toBe(5000);
  });

  test("SYSTEM_PROMPT が空でない文字列", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("MAX_DIFF_CHARS は MAX_FILE_CHARS より大きい", () => {
    expect(MAX_DIFF_CHARS).toBeGreaterThan(MAX_FILE_CHARS);
  });

  test("SYSTEM_PROMPT に良い点・モダンな書き方の必須出力指示が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("💚");
    expect(SYSTEM_PROMPT).toContain("必ず");
  });

  test("SYSTEM_PROMPT に空レスポンス禁止の制約が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("空のレスポンスは禁止");
  });

  test("SYSTEM_PROMPT に Markdown 出力指示が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("Markdown");
  });

  test("SYSTEM_PROMPT に LGTM のみの出力指示が含まれない", () => {
    // 以前の「指摘なしは LGTM とだけ出力」という指示は削除済み
    expect(SYSTEM_PROMPT).not.toContain("\"LGTM\"とだけ出力");
  });
});
