import { formatReviewComment } from "../src/index";
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
