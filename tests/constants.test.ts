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

  test("SYSTEM_PROMPT にリーダブルコード観点が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("リーダブルコード");
  });

  test("SYSTEM_PROMPT に命名の妥当性チェックが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("命名の妥当性");
  });

  test("SYSTEM_PROMPT に関数の単一責任チェックが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("関数の単一責任");
  });

  test("SYSTEM_PROMPT にネストの深さチェックが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("ネストの深さ");
  });

  test("SYSTEM_PROMPT にマジックナンバー排除チェックが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("マジックナンバー");
  });

  test("SYSTEM_PROMPT に Early Return チェックが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("Early Return");
  });

  test("SYSTEM_PROMPT に認知負荷チェックが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("認知負荷");
  });

  test("SYSTEM_PROMPT にコードスニペット提示の必須指示が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("コードスニペット");
    expect(SYSTEM_PROMPT).toContain("必ず提示");
  });
});
