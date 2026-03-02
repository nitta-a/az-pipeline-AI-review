import { Readable } from "node:stream";
import { AI_REVIEW_MARKER, MAX_DIFF_CHARS, MAX_FILE_CHARS } from "../src/constants";
import {
  deleteExistingAiReviewComments,
  getPrDiff,
  streamToString,
} from "../src/azureDevOps";

// ─── ヘルパー: モック IGitApi を生成 ──────────────────────────────────────────
function makeMockGitApi(overrides: Record<string, jest.Mock> = {}): Record<string, jest.Mock> {
  return {
    getPullRequest: jest.fn(),
    getPullRequestIterations: jest.fn(),
    getPullRequestIterationChanges: jest.fn(),
    getItemContent: jest.fn(),
    getThreads: jest.fn(),
    deleteComment: jest.fn(),
    ...overrides,
  };
}

// ─── ヘルパー: ReadableStream を文字列から生成 ─────────────────────────────────
function makeStream(content: string): Readable {
  return Readable.from([Buffer.from(content, "utf-8")]);
}

// ─── streamToString ────────────────────────────────────────────────────────────
describe("streamToString", () => {
  test("Buffer チャンクを結合して UTF-8 文字列を返す", async () => {
    const stream = Readable.from([Buffer.from("hello "), Buffer.from("world")]);
    expect(await streamToString(stream)).toBe("hello world");
  });

  test("文字列チャンクを結合して返す", async () => {
    const stream = Readable.from(["foo", "bar"]);
    expect(await streamToString(stream)).toBe("foobar");
  });

  test("空ストリームは空文字列を返す", async () => {
    const stream = Readable.from([]);
    expect(await streamToString(stream)).toBe("");
  });

  test("マルチバイト文字（日本語）を正しく返す", async () => {
    const text = "日本語テスト";
    const stream = Readable.from([Buffer.from(text, "utf-8")]);
    expect(await streamToString(stream)).toBe(text);
  });
});

// ─── getPrDiff ─────────────────────────────────────────────────────────────────
describe("getPrDiff", () => {
  test("変更ファイルのコンテンツを含む差分テキストを返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/feature/test" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: "/src/foo.ts" }, changeType: 2 },
        ],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("const x = 1;")),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 42);

    expect(result).toContain("PR #42");
    expect(result).toContain("/src/foo.ts");
    expect(result).toContain("const x = 1;");
    expect(gitApi.getItemContent).toHaveBeenCalledWith(
      "repo-1",
      "/src/foo.ts",
      undefined, undefined, undefined, undefined, undefined, undefined,
      { versionType: 0, version: "feature/test" },
    );
  });

  test("イテレーションが存在しない場合はメッセージを返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([]),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("イテレーションが存在しません");
  });

  test("変更ファイルが存在しない場合はメッセージを返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({ changeEntries: [] }),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("変更ファイルがありません");
  });

  test("削除ファイル (changeType=4) はコンテンツを取得しない", async () => {
    const getItemContent = jest.fn();
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/old.ts" }, changeType: 4 }],
      }),
      getItemContent,
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(getItemContent).not.toHaveBeenCalled();
    expect(result).toContain("削除");
    expect(result).toContain("/src/old.ts");
  });

  test("changeType=1 は「追加」として表示される", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/feature" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/new.ts" }, changeType: 1 }],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("export const hello = 'world';")),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("追加");
  });

  test("MAX_FILE_CHARS を超えるコンテンツは切り詰められる", async () => {
    const longContent = "x".repeat(MAX_FILE_CHARS + 500);
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/big.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream(longContent)),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("省略");
    // MAX_FILE_CHARS + 500 文字すべては含まれない
    expect(result).not.toContain("x".repeat(MAX_FILE_CHARS + 1));
  });

  test("MAX_DIFF_CHARS を超えると以降のファイルが省略される", async () => {
    // 各ファイルが MAX_FILE_CHARS 文字のコンテンツを返す
    const bigContent = "a".repeat(MAX_FILE_CHARS);
    const entries = Array.from({ length: 10 }, (_, i) => ({
      item: { path: `/src/file${i}.ts` },
      changeType: 2,
    }));
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({ changeEntries: entries }),
      getItemContent: jest.fn().mockImplementation(() => Promise.resolve(makeStream(bigContent))),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("文字数制限");
  });

  test("getItemContent が失敗するとエラーメッセージを挿入する", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/err.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn().mockRejectedValue(new Error("404 Not Found")),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("コンテンツの取得に失敗しました");
  });

  test("item.path が undefined のエントリはスキップされる", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: undefined }, changeType: 2 },
          { item: { path: "/src/valid.ts" }, changeType: 2 },
        ],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("code")),
    });

    const result = await getPrDiff(gitApi as any, "repo-1", 1);
    expect(result).toContain("/src/valid.ts");
    // undefined パスのエントリは結果に影響しない
    expect(gitApi.getItemContent).toHaveBeenCalledTimes(1);
  });

  test("sourceRefName が undefined の場合は空文字列をブランチとして使う", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: undefined }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/foo.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("content")),
    });

    await getPrDiff(gitApi as any, "repo-1", 1);
    expect(gitApi.getItemContent).toHaveBeenCalledWith(
      "repo-1", "/src/foo.ts",
      undefined, undefined, undefined, undefined, undefined, undefined,
      { versionType: 0, version: "" },
    );
  });
});

// ─── deleteExistingAiReviewComments ───────────────────────────────────────────
describe("deleteExistingAiReviewComments", () => {
  test("AI_REVIEW_MARKER を含むコメントを削除する", async () => {
    const deleteComment = jest.fn().mockResolvedValue(undefined);
    const gitApi = makeMockGitApi({
      getThreads: jest.fn().mockResolvedValue([
        {
          id: 10,
          comments: [
            { id: 1, content: `${AI_REVIEW_MARKER}\n問題があります` },
          ],
        },
      ]),
      deleteComment,
    });

    await deleteExistingAiReviewComments(gitApi as any, "repo-1", 42);
    expect(deleteComment).toHaveBeenCalledTimes(1);
    expect(deleteComment).toHaveBeenCalledWith("repo-1", 42, 10, 1);
  });

  test("マーカーを含まないコメントは削除しない", async () => {
    const deleteComment = jest.fn();
    const gitApi = makeMockGitApi({
      getThreads: jest.fn().mockResolvedValue([
        {
          id: 20,
          comments: [
            { id: 5, content: "通常のレビューコメントです" },
          ],
        },
      ]),
      deleteComment,
    });

    await deleteExistingAiReviewComments(gitApi as any, "repo-1", 1);
    expect(deleteComment).not.toHaveBeenCalled();
  });

  test("複数スレッドの複数コメントを正しく処理する", async () => {
    const deleteComment = jest.fn().mockResolvedValue(undefined);
    const gitApi = makeMockGitApi({
      getThreads: jest.fn().mockResolvedValue([
        {
          id: 1,
          comments: [
            { id: 10, content: `${AI_REVIEW_MARKER} AI レビュー 1` },
            { id: 11, content: "人間のコメント" },
          ],
        },
        {
          id: 2,
          comments: [
            { id: 20, content: `コンテキスト ${AI_REVIEW_MARKER} 末尾` },
            { id: 21, content: "別のコメント" },
          ],
        },
      ]),
      deleteComment,
    });

    await deleteExistingAiReviewComments(gitApi as any, "repo-1", 99);
    expect(deleteComment).toHaveBeenCalledTimes(2);
    expect(deleteComment).toHaveBeenCalledWith("repo-1", 99, 1, 10);
    expect(deleteComment).toHaveBeenCalledWith("repo-1", 99, 2, 20);
  });

  test("コメントがないスレッドはスキップする", async () => {
    const deleteComment = jest.fn();
    const gitApi = makeMockGitApi({
      getThreads: jest.fn().mockResolvedValue([
        { id: 1, comments: undefined },
        { id: 2, comments: [] },
      ]),
      deleteComment,
    });

    await deleteExistingAiReviewComments(gitApi as any, "repo-1", 1);
    expect(deleteComment).not.toHaveBeenCalled();
  });

  test("スレッドが 0 件の場合は何もしない", async () => {
    const deleteComment = jest.fn();
    const gitApi = makeMockGitApi({
      getThreads: jest.fn().mockResolvedValue([]),
      deleteComment,
    });

    await deleteExistingAiReviewComments(gitApi as any, "repo-1", 1);
    expect(deleteComment).not.toHaveBeenCalled();
  });
});
