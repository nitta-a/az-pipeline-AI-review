import { formatReviewComment, splitIntoComments } from "../src/index";
import { AI_REVIEW_MARKER } from "../src/constants";

describe("formatReviewComment", () => {
  test("非空のレビュー結果はそのまま含まれる", () => {
    const comment = formatReviewComment("問題があります。修正してください。");
    expect(comment).toContain(AI_REVIEW_MARKER);
    expect(comment).toContain("問題があります。修正してください。");
  });

  test("空文字の場合はコメント無しメッセージを挿入", () => {
    const comment = formatReviewComment("");
    expect(comment).toContain(AI_REVIEW_MARKER);
    expect(comment).toContain("コメントはありません。");
  });

  test("空白のみの文字列も同様に扱う", () => {
    const comment = formatReviewComment("   \n  \t");
    expect(comment).toContain("コメントはありません。");
  });
});

describe("splitIntoComments", () => {
  test("空文字列は空配列を返す", () => {
    expect(splitIntoComments("")).toEqual([]);
  });

  test("空白のみの文字列は空配列を返す", () => {
    expect(splitIntoComments("   \n\t  ")).toEqual([]);
  });

  test("指摘が1件のみの場合は要素1件の配列を返す", () => {
    const text = "- **バグ**: 修正が必要です。";
    const result = splitIntoComments(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("- **バグ**: 修正が必要です。");
  });

  test("複数の指摘を個別に分割する", () => {
    const text = [
      "- **バグ**: ロジックに誤りがあります。",
      "```ts",
      "const x = 1;",
      "```",
      "- **セキュリティ**: 機密情報がハードコードされています。",
      "```ts",
      "const token = process.env.TOKEN;",
      "```",
    ].join("\n");

    const result = splitIntoComments(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("バグ");
    expect(result[1]).toContain("セキュリティ");
  });

  test("## セクションヘッダーで分割する", () => {
    const text = [
      "- **バグ**: 問題があります。",
      "## 💚 良い点・モダンな書き方の提案",
      "- コードが読みやすいです。",
    ].join("\n");

    const result = splitIntoComments(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("バグ");
    expect(result[1]).toContain("良い点");
  });

  test("指摘直後のコードブロックは同じ項目に含まれる", () => {
    const text = [
      "- **パフォーマンス**: ループの最適化が必要です。",
      "```ts",
      "for (const item of items) {",
      "  process(item);",
      "}",
      "```",
      "- **可読性**: 命名が不明瞭です。",
    ].join("\n");

    const result = splitIntoComments(text);
    expect(result).toHaveLength(2);
    // コードブロックは1件目の指摘に含まれる
    expect(result[0]).toContain("```ts");
    expect(result[0]).toContain("process(item)");
  });

  test("指摘のない単純なテキストは1件として返す", () => {
    const text = "コードに問題は見当たりませんでした。";
    const result = splitIntoComments(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("コードに問題は見当たりませんでした。");
  });

  test("前後の空白がトリムされる", () => {
    const text = "\n\n- **バグ**: 問題があります。\n\n- **セキュリティ**: 脆弱性があります。\n\n";
    const result = splitIntoComments(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("- **バグ**: 問題があります。");
    expect(result[1]).toBe("- **セキュリティ**: 脆弱性があります。");
  });
});
