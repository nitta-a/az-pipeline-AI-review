import type { IGitApi } from "azure-devops-node-api/GitApi";
import { AI_REVIEW_MARKER, MAX_DIFF_CHARS, MAX_FILE_CHARS } from "./constants";

/** 変更ファイルごとの情報を保持する型 */
export interface FileChange {
  /** ファイルパス */
  path: string;
  /** 変更種別ラベル（追加 / 編集 / 削除 など） */
  changeLabel: string;
  /** ファイルのコンテンツ（削除ファイルや取得失敗の場合は null） */
  content: string | null;
  /** unified diff 形式の差分テキスト（差分なし・削除・取得失敗の場合は null） */
  diff: string | null;
}

/** ReadableStream からバッファを読み取って文字列へ変換 */
export async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ─── diff 計算ヘルパー ────────────────────────────────────────────────────────

type DiffOp =
  | { op: "equal"; oldIdx: number; newIdx: number; content: string }
  | { op: "delete"; oldIdx: number; content: string }
  | { op: "insert"; newIdx: number; content: string };

/** LCS DP テーブルを構築する */
function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/** LCS テーブルをバックトラックして差分操作列を返す */
function computeDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const dp = buildLcsTable(oldLines, newLines);
  const ops: DiffOp[] = [];
  let i = oldLines.length;
  let j = newLines.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ op: "equal", oldIdx: i - 1, newIdx: j - 1, content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: "insert", newIdx: j - 1, content: newLines[j - 1] });
      j--;
    } else {
      ops.push({ op: "delete", oldIdx: i - 1, content: oldLines[i - 1] });
      i--;
    }
  }
  return ops.reverse();
}

/**
 * 旧コンテンツと新コンテンツを比較し、変更行とコンテキスト行のみを含む
 * unified diff 形式の文字列を返す。変更がない場合は空文字列を返す。
 *
 * 出力フォーマット:
 *   `+    N | content` — 追加行（N は新ファイルの行番号、5桁右詰め）
 *   `-      | content` — 削除行（新ファイルには存在しない）
 *   `     N | content` — コンテキスト行（N は新ファイルの行番号）
 *   `@@`               — ハンク区切り
 */
export function computeDiffContent(oldContent: string, newContent: string, contextLines = 3): string {
  const oldLines = oldContent === "" ? [] : oldContent.split("\n");
  const newLines = newContent === "" ? [] : newContent.split("\n");

  const ops = computeDiffOps(oldLines, newLines);

  // 変更行の前後 contextLines 行を含む対象インデックスを収集
  const includedIndices = new Set<number>();
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== "equal") {
      for (let c = Math.max(0, i - contextLines); c <= Math.min(ops.length - 1, i + contextLines); c++) {
        includedIndices.add(c);
      }
    }
  }

  if (includedIndices.size === 0) {
    return "";
  }

  const resultLines: string[] = [];
  let prevIdx = -2;

  for (let i = 0; i < ops.length; i++) {
    if (!includedIndices.has(i)) {
      continue;
    }
    if (prevIdx >= 0 && i > prevIdx + 1) {
      resultLines.push("@@");
    }
    prevIdx = i;

    const op = ops[i];
    if (op.op === "equal") {
      const lineNum = String(op.newIdx + 1).padStart(5, " ");
      resultLines.push(` ${lineNum} | ${op.content}`);
    } else if (op.op === "insert") {
      const lineNum = String(op.newIdx + 1).padStart(5, " ");
      resultLines.push(`+${lineNum} | ${op.content}`);
    } else {
      resultLines.push(`-      | ${op.content}`);
    }
  }

  return resultLines.join("\n");
}

/**
 * PR の最新イテレーションで変更されたファイルの内容を取得し、
 * LLM に渡すためのテキストへ整形して返す
 */
export async function getPrDiff(gitApi: IGitApi, repoId: string, prId: number): Promise<string> {
  // PR の詳細（ソースブランチ名）を取得
  const pr = await gitApi.getPullRequest(repoId, prId);
  // "refs/heads/feature/xxx" → "feature/xxx"
  const sourceBranch = pr.sourceRefName?.replace("refs/heads/", "") ?? "";

  // 最新イテレーションを取得
  const iterations = await gitApi.getPullRequestIterations(repoId, prId);
  if (!iterations || iterations.length === 0) {
    return "差分を取得できませんでした（イテレーションが存在しません）。";
  }
  const latestIterationId = iterations[iterations.length - 1].id!;

  // 変更ファイル一覧を取得
  const changes = await gitApi.getPullRequestIterationChanges(repoId, prId, latestIterationId);
  if (!changes.changeEntries || changes.changeEntries.length === 0) {
    return "変更ファイルがありません。";
  }

  const diffParts: string[] = [`## PR #${prId} 変更ファイル一覧 (イテレーション ${latestIterationId})\n`];
  let totalChars = 0;

  for (const entry of changes.changeEntries) {
    const filePath = entry.item?.path;
    if (!filePath) {
      continue;
    }

    // ログ出力: 処理中のファイルを通知
    console.log(`処理中のファイル: ${filePath}`);

    // changeType: 1=Add, 2=Edit, 4=Delete
    const changeTypeNum = entry.changeType ?? 0;
    const changeLabel =
      changeTypeNum === 1
        ? "追加"
        : changeTypeNum === 2
          ? "編集"
          : changeTypeNum === 4
            ? "削除"
            : `変更(${changeTypeNum})`;

    diffParts.push(`\n### [${changeLabel}] \`${filePath}\``);

    // 削除ファイルはコンテンツ取得不要
    if (changeTypeNum === 4) {
      diffParts.push("*(ファイルが削除されました)*");
      continue;
    }

    try {
      const stream = await gitApi.getItemContent(
        repoId,
        filePath,
        undefined, // project
        undefined, // scopePath
        undefined, // recursionLevel
        undefined, // includeContentMetadata
        undefined, // latestProcessedChange
        undefined, // download
        // GitVersionDescriptor: ソースブランチの HEAD (versionType 0 = Branch)
        { versionType: 0, version: sourceBranch },
      );
      const content = await streamToString(stream);
      const snippet = content.slice(0, MAX_FILE_CHARS);
      const truncated = content.length > MAX_FILE_CHARS;
      diffParts.push("```\n" + snippet + (truncated ? "\n...(省略)..." : "") + "\n```");
      totalChars += snippet.length;
    } catch {
      diffParts.push("*(コンテンツの取得に失敗しました)*");
    }

    if (totalChars >= MAX_DIFF_CHARS) {
      diffParts.push("\n> 文字数制限 (30,000字) に達したため、以降の変更は省略されました。");
      break;
    }
  }

  return diffParts.join("\n");
}

/**
 * PR の最新イテレーションで変更されたファイル一覧をファイルごとの情報として返す。
 * 1 ファイルずつ LLM へ送信するためのデータ取得に使用する。
 */
export async function getChangedFiles(gitApi: IGitApi, repoId: string, prId: number): Promise<FileChange[]> {
  // PR の詳細（ソースブランチ名・ターゲットブランチ名）を取得
  const pr = await gitApi.getPullRequest(repoId, prId);
  // "refs/heads/feature/xxx" → "feature/xxx"
  const sourceBranch = pr.sourceRefName?.replace("refs/heads/", "") ?? "";
  const targetBranch = pr.targetRefName?.replace("refs/heads/", "") ?? "";

  // 最新イテレーションを取得
  const iterations = await gitApi.getPullRequestIterations(repoId, prId);
  if (!iterations || iterations.length === 0) {
    return [];
  }
  const latestIterationId = iterations[iterations.length - 1].id!;

  // 変更ファイル一覧を取得
  const changes = await gitApi.getPullRequestIterationChanges(repoId, prId, latestIterationId);
  if (!changes.changeEntries || changes.changeEntries.length === 0) {
    return [];
  }

  const result: FileChange[] = [];

  for (const entry of changes.changeEntries) {
    const filePath = entry.item?.path;
    if (!filePath) {
      continue;
    }

    // changeType: 1=Add, 2=Edit, 4=Delete
    const changeTypeNum = entry.changeType ?? 0;
    const changeLabel =
      changeTypeNum === 1
        ? "追加"
        : changeTypeNum === 2
          ? "編集"
          : changeTypeNum === 4
            ? "削除"
            : `変更(${changeTypeNum})`;

    // 削除ファイルはコンテンツ取得不要
    if (changeTypeNum === 4) {
      result.push({ path: filePath, changeLabel, content: null, diff: null });
      continue;
    }

    try {
      // ソースブランチ（HEAD）のコンテンツを取得
      const headStream = await gitApi.getItemContent(
        repoId,
        filePath,
        undefined, // project
        undefined, // scopePath
        undefined, // recursionLevel
        undefined, // includeContentMetadata
        undefined, // latestProcessedChange
        undefined, // download
        // GitVersionDescriptor: ソースブランチの HEAD (versionType 0 = Branch)
        { versionType: 0, version: sourceBranch },
      );
      const headRaw = await streamToString(headStream);
      const snippet = headRaw.slice(0, MAX_FILE_CHARS);

      // 編集ファイルはターゲットブランチ（BASE）のコンテンツも取得して差分を計算する
      // 追加ファイルはベースが存在しないため空文字列として扱う
      let baseContent = "";
      if (changeTypeNum === 2) {
        try {
          const baseStream = await gitApi.getItemContent(
            repoId,
            filePath,
            undefined, // project
            undefined, // scopePath
            undefined, // recursionLevel
            undefined, // includeContentMetadata
            undefined, // latestProcessedChange
            undefined, // download
            // GitVersionDescriptor: ターゲットブランチの HEAD (versionType 0 = Branch)
            { versionType: 0, version: targetBranch },
          );
          const baseRaw = await streamToString(baseStream);
          baseContent = baseRaw.slice(0, MAX_FILE_CHARS);
        } catch {
          // ベースが取得できない場合は空文字列として差分計算
          baseContent = "";
        }
      }

      const diffText = computeDiffContent(baseContent, snippet);
      result.push({ path: filePath, changeLabel, content: snippet, diff: diffText || null });
    } catch {
      result.push({ path: filePath, changeLabel, content: null, diff: null });
    }
  }

  return result;
}

/**
 * PR に投稿済みの AI レビューコメント（マーカー付き）をすべて削除する
 */
export async function deleteExistingAiReviewComments(gitApi: IGitApi, repoId: string, prId: number): Promise<void> {
  const threads = await gitApi.getThreads(repoId, prId);
  for (const thread of threads) {
    if (!thread.comments) {
      continue;
    }
    for (const comment of thread.comments) {
      if (comment.content?.includes(AI_REVIEW_MARKER)) {
        await gitApi.deleteComment(repoId, prId, thread.id!, comment.id!);
        console.log(`スレッド ${thread.id} のコメント ${comment.id} を削除しました。`);
      }
    }
  }
}
