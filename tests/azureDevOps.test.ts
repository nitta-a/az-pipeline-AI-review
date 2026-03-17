import { Readable } from "node:stream";
import { AI_REVIEW_MARKER, MAX_DIFF_CHARS, MAX_FILE_CHARS } from "../src/constants";
import {
  computeDiffContent,
  deleteExistingAiReviewComments,
  getChangedFiles,
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

  test("各ファイルの処理時に console.log でパスを出力する", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/feature/log" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: "/src/a.ts" }, changeType: 2 },
          { item: { path: "/src/b.ts" }, changeType: 1 },
        ],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("code")),
    });

    await getPrDiff(gitApi as any, "repo-1", 5);

    expect(spy).toHaveBeenCalledWith("処理中のファイル: /src/a.ts");
    expect(spy).toHaveBeenCalledWith("処理中のファイル: /src/b.ts");

    spy.mockRestore();
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

// ─── getChangedFiles ──────────────────────────────────────────────────────────
describe("getChangedFiles", () => {
  test("変更ファイルの情報を配列として返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({
        sourceRefName: "refs/heads/feature/test",
        targetRefName: "refs/heads/main",
      }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: "/src/foo.ts" }, changeType: 2 },
        ],
      }),
      getItemContent: jest.fn()
        .mockResolvedValueOnce(makeStream("const x = 1;"))  // head (source branch)
        .mockResolvedValueOnce(makeStream("const x = 0;")),  // base (target branch)
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 42);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/src/foo.ts");
    expect(result[0].changeLabel).toBe("編集");
    expect(result[0].content).toBe("const x = 1;");
    // diff は変更行を含む（追加行と削除行の両方）
    expect(result[0].diff).not.toBeNull();
    expect(result[0].diff).toContain("+    1 | const x = 1;");
    expect(result[0].diff).toContain("-      | const x = 0;");
  });

  test("イテレーションが存在しない場合は空配列を返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([]),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result).toEqual([]);
  });

  test("変更ファイルが存在しない場合は空配列を返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({ changeEntries: [] }),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result).toEqual([]);
  });

  test("削除ファイル (changeType=4) は content と diff が null", async () => {
    const getItemContent = jest.fn();
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/old.ts" }, changeType: 4 }],
      }),
      getItemContent,
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(getItemContent).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].changeLabel).toBe("削除");
    expect(result[0].content).toBeNull();
    expect(result[0].diff).toBeNull();
  });

  test("changeType=1 は changeLabel が「追加」で diff は全行追加", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/new.ts" }, changeType: 1 }],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("export const hello = 'world';")),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result[0].changeLabel).toBe("追加");
    expect(result[0].content).toBe("export const hello = 'world';");
    // 追加ファイルはすべての行が + で始まる
    expect(result[0].diff).not.toBeNull();
    expect(result[0].diff?.split("\n").every((line) => line.startsWith("+"))).toBe(true);
  });

  test("MAX_FILE_CHARS を超えるコンテンツは切り詰められる", async () => {
    const longContent = "x".repeat(MAX_FILE_CHARS + 500);
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/big.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream(longContent)),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result[0].content).toHaveLength(MAX_FILE_CHARS);
  });

  test("getItemContent が失敗すると content と diff が null になる", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/err.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn().mockRejectedValue(new Error("404 Not Found")),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result[0].content).toBeNull();
    expect(result[0].diff).toBeNull();
  });

  test("item.path が undefined のエントリはスキップされる", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/main", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: undefined }, changeType: 2 },
          { item: { path: "/src/valid.ts" }, changeType: 2 },
        ],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("code")),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/src/valid.ts");
  });

  test("複数ファイルをすべて返す", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({ sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 2 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [
          { item: { path: "/src/a.ts" }, changeType: 1 },
          { item: { path: "/src/b.ts" }, changeType: 2 },
          { item: { path: "/src/c.ts" }, changeType: 4 },
        ],
      }),
      getItemContent: jest.fn().mockResolvedValue(makeStream("code")),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result).toHaveLength(3);
    expect(result[0].changeLabel).toBe("追加");
    expect(result[1].changeLabel).toBe("編集");
    expect(result[2].changeLabel).toBe("削除");
    expect(result[2].content).toBeNull();
    expect(result[2].diff).toBeNull();
  });

  test("編集ファイル: ターゲットブランチのコンテンツと比較した diff が生成される", async () => {
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
      }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/calc.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn()
        .mockResolvedValueOnce(makeStream("line1\nline2_new\nline3"))  // head
        .mockResolvedValueOnce(makeStream("line1\nline2_old\nline3")), // base
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result[0].diff).not.toBeNull();
    // 追加行（+）と削除行（-）が含まれる
    expect(result[0].diff).toContain("+");
    expect(result[0].diff).toContain("-");
    // 変更なしのコンテキスト行（line1, line3）が含まれる
    expect(result[0].diff).toContain("line1");
    expect(result[0].diff).toContain("line3");
  });

  test("編集ファイル: ベースのコンテンツ取得失敗時は空ベースとして diff を計算する", async () => {
    let callCount = 0;
    const gitApi = makeMockGitApi({
      getPullRequest: jest.fn().mockResolvedValue({
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
      }),
      getPullRequestIterations: jest.fn().mockResolvedValue([{ id: 1 }]),
      getPullRequestIterationChanges: jest.fn().mockResolvedValue({
        changeEntries: [{ item: { path: "/src/calc.ts" }, changeType: 2 }],
      }),
      getItemContent: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(makeStream("new content"));
        return Promise.reject(new Error("Not found"));
      }),
    });

    const result = await getChangedFiles(gitApi as any, "repo-1", 1);
    expect(result[0].content).toBe("new content");
    // ベース取得失敗 → 空ベースからの diff（全行追加）
    expect(result[0].diff).not.toBeNull();
    expect(result[0].diff?.split("\n").every((line) => line.startsWith("+"))).toBe(true);
  });
});

// ─── computeDiffContent ───────────────────────────────────────────────────────
describe("computeDiffContent", () => {
  test("変更がない場合は空文字列を返す", () => {
    const content = "line1\nline2\nline3";
    expect(computeDiffContent(content, content)).toBe("");
  });

  test("どちらも空の場合は空文字列を返す", () => {
    expect(computeDiffContent("", "")).toBe("");
  });

  test("追加ファイル (旧が空) は全行が + になる", () => {
    const result = computeDiffContent("", "line1\nline2");
    expect(result).toContain("+    1 | line1");
    expect(result).toContain("+    2 | line2");
    expect(result).not.toContain("-");
  });

  test("削除ファイル (新が空) は全行が - になる", () => {
    const result = computeDiffContent("line1\nline2", "");
    expect(result).toContain("-      | line1");
    expect(result).toContain("-      | line2");
    expect(result).not.toContain("+");
  });

  test("1行追加の差分を正しく出力する", () => {
    const result = computeDiffContent("line1\nline3", "line1\nline2\nline3");
    expect(result).toContain("+    2 | line2");
    // コンテキスト行も含まれる
    expect(result).toContain("line1");
    expect(result).toContain("line3");
  });

  test("1行削除の差分を正しく出力する", () => {
    const result = computeDiffContent("line1\nline2\nline3", "line1\nline3");
    expect(result).toContain("-      | line2");
    expect(result).toContain("line1");
    expect(result).toContain("line3");
  });

  test("行の変更（削除 + 追加）を正しく出力する", () => {
    const result = computeDiffContent("a\nold\nb", "a\nnew\nb");
    expect(result).toContain("-      | old");
    expect(result).toContain("+    2 | new");
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  test("行番号は新ファイルの行番号を使用する", () => {
    const result = computeDiffContent("x\ny\nz", "x\ny\nz\nadded");
    // "added" は4行目
    expect(result).toContain("+    4 | added");
  });

  test("コンテキスト行は変更行の前後 contextLines 行を含む", () => {
    // 10行のファイルで5行目だけ変更
    const oldLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const newLines = oldLines.replace("line5", "line5_new");
    const result = computeDiffContent(oldLines, newLines, 2);
    // 変更行の前後2行が含まれる
    expect(result).toContain("line3");
    expect(result).toContain("line4");
    expect(result).toContain("line6");
    expect(result).toContain("line7");
    // 遠い行は含まれない
    expect(result).not.toContain("line1");
    expect(result).not.toContain("line10");
  });

  test("離れた複数の変更箇所は @@ で区切られる", () => {
    // 1行目と10行目を変更
    const oldLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const newLines = oldLines.replace("line1", "line1_new").replace("line10", "line10_new");
    const result = computeDiffContent(oldLines, newLines, 1);
    expect(result).toContain("@@");
  });

  test("隣接する変更箇所は @@ で区切られない", () => {
    // 2行目と3行目を変更（コンテキスト=1 で隣接する）
    const oldLines = "a\nb\nc\nd";
    const newLines = "a\nB\nC\nd";
    const result = computeDiffContent(oldLines, newLines, 1);
    // 変更が隣接しているため @@ は挿入されない
    expect(result).not.toContain("@@");
  });

  test("削除行には行番号が付かない", () => {
    const result = computeDiffContent("removed\nkept", "kept");
    // 削除行のフォーマット: `-      | content`
    expect(result).toMatch(/-\s+\| removed/);
    // + で始まる行番号付き行は含まれない
    expect(result).not.toMatch(/\+\s+\d+\s+\|/);
  });
});
