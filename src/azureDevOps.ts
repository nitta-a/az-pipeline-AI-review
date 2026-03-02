import type { IGitApi } from "azure-devops-node-api/GitApi";
import { AI_REVIEW_MARKER, MAX_DIFF_CHARS, MAX_FILE_CHARS } from "./constants";

/** ReadableStream からバッファを読み取って文字列へ変換 */
export async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
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
