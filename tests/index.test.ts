import { extractChangedLineNumbers, formatReviewComment, parseIssueLocation, splitIntoComments } from "../src/index";
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
      "### [src/foo.ts:10]",
      "- **バグ**: ロジックに誤りがあります。",
      "```ts",
      "const x = 1;",
      "```",
      "### [src/foo.ts:20]",
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
      "### [src/foo.ts:5]",
      "- **パフォーマンス**: ループの最適化が必要です。",
      "```ts",
      "for (const item of items) {",
      "  process(item);",
      "}",
      "```",
      "### [src/foo.ts:15]",
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
    const text =
      "\n\n### [src/foo.ts:1]\n- **バグ**: 問題があります。\n\n### [src/foo.ts:2]\n- **セキュリティ**: 脆弱性があります。\n\n";
    const result = splitIntoComments(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("バグ");
    expect(result[1]).toContain("セキュリティ");
  });
});

describe("parseIssueLocation", () => {
  test("ファイルパスと行番号を正しく抽出する", () => {
    const text = "### [src/foo.ts:42]\n- **バグ**: 問題があります。";
    const result = parseIssueLocation(text);
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe("src/foo.ts");
    expect(result?.lineNumber).toBe(42);
  });

  test("行番号なしのヘッダーは lineNumber が null になる", () => {
    const text = "### [src/foo.ts]\n- **バグ**: 問題があります。";
    const result = parseIssueLocation(text);
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe("src/foo.ts");
    expect(result?.lineNumber).toBeNull();
  });

  test("ヘッダーがない場合は null を返す", () => {
    const text = "- **バグ**: 問題があります。";
    expect(parseIssueLocation(text)).toBeNull();
  });

  test("前後にスペースがあるヘッダーを正しく処理する", () => {
    const text = "###  [ src/bar.ts : 10 ]\n- **セキュリティ**: 脆弱性があります。";
    const result = parseIssueLocation(text);
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe("src/bar.ts");
    expect(result?.lineNumber).toBe(10);
  });

  test("行番号として 1 を正しく処理する", () => {
    const text = "### [/src/index.ts:1]\n- **バグ**: ファイル先頭行の問題。";
    const result = parseIssueLocation(text);
    expect(result?.filePath).toBe("/src/index.ts");
    expect(result?.lineNumber).toBe(1);
  });

  test("本文途中に ### [ が含まれても最初のヘッダーを返す", () => {
    const text = "### [src/a.ts:5]\n- **バグ**: 参照 ### [src/b.ts:99] を確認。";
    const result = parseIssueLocation(text);
    expect(result?.filePath).toBe("src/a.ts");
    expect(result?.lineNumber).toBe(5);
  });

  test("空文字列は null を返す", () => {
    expect(parseIssueLocation("")).toBeNull();
  });
});

describe("extractChangedLineNumbers", () => {
  test("null を渡すと null を返す", () => {
    expect(extractChangedLineNumbers(null)).toBeNull();
  });

  test("空文字列は空のセットを返す", () => {
    const result = extractChangedLineNumbers("");
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  test("追加行（+マーカー）の行番号を抽出する", () => {
    const diff = [
      "     1 | const a = 1;",
      "+    2 | const b = 2;",
      "+    3 | const c = 3;",
      "     4 | const d = 4;",
    ].join("\n");
    const result = extractChangedLineNumbers(diff);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
    expect(result!.has(2)).toBe(true);
    expect(result!.has(3)).toBe(true);
  });

  test("コンテキスト行と削除行は変更行に含まれない", () => {
    const diff = [
      "     5 | const x = 1;",
      "-      | const old = 2;",
      "+    6 | const newVal = 3;",
      "     7 | const y = 4;",
    ].join("\n");
    const result = extractChangedLineNumbers(diff);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(1);
    expect(result!.has(6)).toBe(true);
    // コンテキスト行は含まれない
    expect(result!.has(5)).toBe(false);
    expect(result!.has(7)).toBe(false);
  });

  test("ハンク区切り（@@）は無視される", () => {
    const diff = [
      "+    1 | line1",
      "@@",
      "+   10 | line10",
    ].join("\n");
    const result = extractChangedLineNumbers(diff);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
    expect(result!.has(1)).toBe(true);
    expect(result!.has(10)).toBe(true);
  });

  test("変更行がない差分は空のセットを返す", () => {
    const diff = [
      "     1 | const a = 1;",
      "     2 | const b = 2;",
      "-      | old line",
    ].join("\n");
    const result = extractChangedLineNumbers(diff);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });
});
