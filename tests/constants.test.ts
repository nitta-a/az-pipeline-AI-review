import { AI_REVIEW_MARKER, MAX_DIFF_CHARS, MAX_FILE_CHARS, MAX_KNOWLEDGE_FILES, ROUTING_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../src/constants";

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

  test("SYSTEM_PROMPT に禁止事項セクションが含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("禁止事項");
  });

  test("SYSTEM_PROMPT に良い点の指摘・称賛の禁止が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("良い点の指摘・称賛");
  });

  test("SYSTEM_PROMPT にモダンな書き方への提案禁止が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("モダンな書き方や糖衣構文へのリファクタリング提案");
  });

  test("SYSTEM_PROMPT に推測に基づく指摘の禁止が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("推測に基づく指摘");
  });

  test("SYSTEM_PROMPT に指摘対象としてバグ・論理的欠陥が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("バグ・論理的欠陥");
  });

  test("SYSTEM_PROMPT に指摘対象としてセキュリティの脆弱性が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("セキュリティの脆弱性");
  });

  test("SYSTEM_PROMPT に指摘対象として著しいパフォーマンスの低下が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("著しいパフォーマンスの低下");
  });

  test("SYSTEM_PROMPT に指摘対象として致命的なアーキテクチャ上の問題が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("致命的なアーキテクチャ上の問題");
  });

  test("SYSTEM_PROMPT に指摘なし時の空出力指示が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("何も出力しないでください");
  });

  test("SYSTEM_PROMPT に良い点・モダンな書き方の必須出力指示が含まれない", () => {
    expect(SYSTEM_PROMPT).not.toContain("💚");
    expect(SYSTEM_PROMPT).not.toContain("良い点・モダンな書き方の提案");
  });

  test("SYSTEM_PROMPT に空レスポンス禁止の旧制約が含まれない", () => {
    expect(SYSTEM_PROMPT).not.toContain("空のレスポンスは禁止");
  });

  test("SYSTEM_PROMPT に Markdown 出力指示が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("Markdown");
  });

  test("SYSTEM_PROMPT に LGTM のみの出力指示が含まれない", () => {
    // 指摘なし時のテキスト出力（LGTM など）は禁止済み
    expect(SYSTEM_PROMPT).not.toContain("\"LGTM\"とだけ出力");
  });

  test("SYSTEM_PROMPT にコードスニペット提示の必須指示が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("コードスニペット");
    expect(SYSTEM_PROMPT).toContain("必ず提示");
  });

  test("SYSTEM_PROMPT にコンテキスト行への指摘禁止が含まれる", () => {
    expect(SYSTEM_PROMPT).toContain("コンテキスト行");
    expect(SYSTEM_PROMPT).toContain("禁止");
  });

  test("MAX_KNOWLEDGE_FILES が 5", () => {
    expect(MAX_KNOWLEDGE_FILES).toBe(5);
  });

  test("ROUTING_SYSTEM_PROMPT が空でない文字列", () => {
    expect(typeof ROUTING_SYSTEM_PROMPT).toBe("string");
    expect(ROUTING_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("ROUTING_SYSTEM_PROMPT に JSON 配列での出力指示が含まれる", () => {
    expect(ROUTING_SYSTEM_PROMPT).toContain("JSON");
  });

  test("ROUTING_SYSTEM_PROMPT に最大件数の指示が含まれる", () => {
    expect(ROUTING_SYSTEM_PROMPT).toContain(`${MAX_KNOWLEDGE_FILES}`);
  });
});
