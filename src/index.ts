import * as path from "node:path";
import * as azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import * as tl from "azure-pipelines-task-lib/task";
import { deleteExistingAiReviewComments, getChangedFiles } from "./azureDevOps";
import { AI_REVIEW_MARKER, RATE_LIMIT_DELAY_MS, SKIP_LOG_PREVIEW_CHARS } from "./constants";
import { indexKnowledgeFiles, loadKnowledgeContents } from "./knowledge";
import { callLlm, selectKnowledgeFiles } from "./llm";
import { parseConnectionString } from "./types";

export function formatReviewComment(reviewResult: string): string {
  // LLM からの返信が空文字の場合は明示的に "コメントはありません。" と表示する
  const body = reviewResult.trim() || "コメントはありません。";
  return `${AI_REVIEW_MARKER}\n## 🤖 AI コードレビュー\n\n${body}`;
}

/**
 * LLM レスポンス（Markdown 形式）を指摘1件ごとに分割する。
 * 行頭が `### [` または `## ` で始まる箇所を区切りとして分割する。
 */
export function splitIntoComments(reviewText: string): string[] {
  if (!reviewText.trim()) {
    return [];
  }
  // `### [` (ファイルパス:行番号ヘッダー) または `## ` (セクションヘッダー) で始まる行の直前で分割
  const items = reviewText.split(/\n(?=### \[|## )/);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * 指摘テキストから `### [ファイルパス:行番号]` 形式のヘッダーを解析し、
 * ファイルパスと行番号を返す。
 * 行番号が含まれない場合は lineNumber を null として返す。
 * ヘッダーが存在しない場合は null を返す。
 */
export function parseIssueLocation(issueText: string): { filePath: string; lineNumber: number | null } | null {
  // `### [filepath:lineNumber]` 形式（行番号あり）にマッチ
  const withLine = issueText.match(/^###\s*\[([^\]]+?):\s*(\d+)\s*\]/m);
  if (withLine) {
    return { filePath: withLine[1].trim(), lineNumber: Number.parseInt(withLine[2], 10) };
  }
  // `### [filepath]` 形式（行番号なし）にマッチ（フォールバック）
  const withoutLine = issueText.match(/^###\s*\[([^\]]+?)\]/m);
  if (withoutLine) {
    return { filePath: withoutLine[1].trim(), lineNumber: null };
  }
  return null;
}

/**
 * unified diff テキストから変更行（`+` マーカー付き追加行）の行番号セットを抽出する。
 * LLM の指摘が実際の変更行に対応しているかを検証するために使用する。
 * diff が null の場合は null を返す（フィルタリング不可）。
 */
export function extractChangedLineNumbers(diff: string | null): Set<number> | null {
  if (diff === null) {
    return null;
  }
  const changed = new Set<number>();
  for (const line of diff.split("\n")) {
    // 追加行: `+    N | content` — N は5桁右詰めの行番号
    const match = line.match(/^\+\s*(\d+)\s*\|/);
    if (match) {
      changed.add(Number.parseInt(match[1], 10));
    }
  }
  return changed;
}

/**
 * 指定されたミリ秒数だけ非同期に待機する。
 * API レート制限（TPM/RPM）に抵触しないよう、LLM リクエスト間に挿入するために使用する。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  try {
    // 1. パイプライン入力値・環境変数の取得と検証
    const rawConnectionString = tl.getInput("llmConnectionString", true)!;
    const connParams = parseConnectionString(rawConnectionString);

    const token = tl.getVariable("System.AccessToken")!;
    const orgUrl = tl.getVariable("System.TeamFoundationCollectionUri")!;
    const repoId = tl.getVariable("Build.Repository.Id")!;
    const prIdStr = tl.getVariable("System.PullRequest.PullRequestId");

    if (!prIdStr) {
      tl.setResult(
        tl.TaskResult.Skipped,
        "System.PullRequest.PullRequestId が設定されていません。PR のパイプラインでのみ実行可能です。",
      );
      return;
    }
    const prId = parseInt(prIdStr, 10);

    // ナレッジディレクトリのパスを解決（タスク入力 → Build.SourcesDirectory/.knowledge）
    const knowledgeDirInput = tl.getInput("knowledgeDir", false) ?? "";
    const knowledgeDir =
      knowledgeDirInput || path.join(tl.getVariable("Build.SourcesDirectory") ?? process.cwd(), ".knowledge");

    // 2. Azure DevOps API クライアントの初期化
    const authHandler = azdev.getPersonalAccessTokenHandler(token);
    const connection = new azdev.WebApi(orgUrl, authHandler);
    const gitApi: IGitApi = await connection.getGitApi();

    // 3. 過去の AI レビューコメントを削除
    console.log("既存の AI レビューコメントを検索・削除しています...");
    await deleteExistingAiReviewComments(gitApi, repoId, prId);

    // 4. 変更ファイル一覧を取得
    console.log("PR の変更ファイル一覧を取得しています...");
    const changedFiles = await getChangedFiles(gitApi, repoId, prId);

    if (changedFiles.length === 0) {
      console.log("変更ファイルがありません。処理をスキップします。");
      tl.setResult(tl.TaskResult.Succeeded, "変更ファイルがありませんでした。");
      return;
    }

    console.log(`変更ファイル数: ${changedFiles.length} 件`);
    console.log(
      `接続パラメータ: provider=${connParams.provider}, model=${connParams.model},` +
        ` apiVersion=${connParams.apiVersion ?? "(default)"},` +
        ` maxTokens=${connParams.maxTokens ?? "(default:40960)"},` +
        ` temperature=${connParams.temperature ?? "(default)"},` +
        ` debug=${connParams.debug ?? "false"}`,
    );

    // 5. Step 1: ナレッジファイルのインデックス作成
    const knowledgeIndex = indexKnowledgeFiles(knowledgeDir);
    console.log(`ナレッジファイル数: ${knowledgeIndex.length} 件 (ディレクトリ: ${knowledgeDir})`);

    // 6. Step 2 (Pass 1): ナレッジの動的選択（Routing）
    // 変更ファイルの概要（パスと変更種別のみ）を LLM へ渡す。コード内容は含めない。
    let knowledgeContext = "";
    let selectedKnowledgeNames: string[] = [];

    if (knowledgeIndex.length > 0) {
      const changedFilesSummary = changedFiles.map((f) => `- ${f.path} [${f.changeLabel}]`).join("\n");

      console.log("Pass 1: ナレッジファイルを選択しています...");
      selectedKnowledgeNames = await selectKnowledgeFiles(connParams, knowledgeIndex, changedFilesSummary);

      // インデックスに存在するファイル名のみに限定して安全性を確保
      const validFilenames = new Set(knowledgeIndex.map((e) => e.filename));
      selectedKnowledgeNames = selectedKnowledgeNames.filter((n) => validFilenames.has(n));

      console.log(
        `選択されたナレッジ (${selectedKnowledgeNames.length} 件): ${selectedKnowledgeNames.join(", ") || "(なし)"}`,
      );

      // 7. Step 3 (Pass 2 前処理): 選択されたナレッジファイルの内容を読み込む
      if (selectedKnowledgeNames.length > 0) {
        knowledgeContext = loadKnowledgeContents(knowledgeDir, selectedKnowledgeNames);
      }
    }

    // 8. Step 3 (Pass 2): 各ファイルをレビュー → 指摘を個別コメントとして投稿
    let totalPostedCount = 0;
    const postedComments = new Set<string>(); // 重複投稿防止

    for (let i = 0; i < changedFiles.length; i++) {
      const file = changedFiles[i];

      console.log(`##[group]📄 ファイル処理中 (${i + 1}/${changedFiles.length}): ${file.path}`);
      console.log(`変更種別: ${file.changeLabel}`);

      // 削除ファイルや取得失敗はスキップ
      if (file.content === null) {
        console.log("コンテンツが取得できなかったため LLM へのリクエストをスキップします。");
        console.log("##[endgroup]");
        continue;
      }

      const ext = file.path.split(".").pop() ?? "";
      // diff が利用可能な場合はそちらを優先（変更行のみ+コンテキスト、行番号・+/-マーカー付き）
      // diff がない場合は全コンテンツに行番号を付与してフォールバック
      let fileDiffText: string;
      if (file.diff) {
        fileDiffText = `### [${file.changeLabel}] \`${file.path}\`\n` + "```diff\n" + file.diff + "\n```";
      } else {
        const contentWithLineNumbers = file.content
          .split("\n")
          .map((line, i) => `${String(i + 1).padStart(5, " ")} | ${line}`)
          .join("\n");
        fileDiffText =
          `### [${file.changeLabel}] \`${file.path}\`\n` + "```" + ext + "\n" + contentWithLineNumbers + "\n```";
      }

      // 変更行の行番号セットを抽出（差分がない場合は null → フィルタリングしない）
      const changedLines = extractChangedLineNumbers(file.diff);
      if (changedLines) {
        console.log(`変更行番号: [${[...changedLines].sort((a, b) => a - b).join(", ")}]`);
      }

      // LLM に送信するデータをログ出力（デバッグ用可視化）
      console.log("##[group]📤 LLM 送信データ");
      console.log(`--- ユーザーメッセージ（プロンプト） ---\n${fileDiffText}`);
      if (knowledgeContext) {
        console.log(`--- ナレッジコンテキスト ---\n${knowledgeContext}`);
      }
      console.log("##[endgroup]");

      console.log(`LLM (${connParams.provider}) にレビューを依頼しています...`);
      const fileReview = await callLlm(connParams, fileDiffText, knowledgeContext || undefined);

      // LLM の生レスポンスをログ出力
      console.log("##[group]📥 LLM レスポンス");
      console.log(fileReview);
      console.log("##[endgroup]");

      const issues = splitIntoComments(fileReview);
      console.log(`LLM から ${issues.length} 件の指摘を受け取りました。`);
      console.log("##[endgroup]");

      // 指摘1件ごとに個別スレッドとして投稿
      for (const issue of issues) {
        const location = parseIssueLocation(issue);

        // フォーマット外の出力（雑談や指摘なしのテキスト）を除外
        if (!location) {
          console.log(`フォーマットに一致しないためスキップしました: ${issue.substring(0, SKIP_LOG_PREVIEW_CHARS)}...`);
          continue;
        }

        const lineNumber = location.lineNumber;

        const commentBody = formatReviewComment(`### [${file.changeLabel}] \`${file.path}\`\n\n${issue}`);

        // 重複チェック
        if (postedComments.has(commentBody)) {
          continue;
        }
        postedComments.add(commentBody);

        // 変更行フィルタリング: 差分データがあり、指摘の行番号が変更行に含まれない場合はスキップ
        if (lineNumber !== null && changedLines !== null && !changedLines.has(lineNumber)) {
          console.log(
            `⚠️ 変更行以外への指摘をスキップしました: ${file.path}:${lineNumber} (変更行: [${[...changedLines].sort((a, b) => a - b).join(", ")}])`,
          );
          continue;
        }
        const threadContext =
          lineNumber !== null
            ? {
                filePath: file.path,
                rightFileStart: { line: lineNumber, offset: 1 },
                rightFileEnd: { line: lineNumber, offset: 1 },
              }
            : undefined;

        try {
          await gitApi.createThread(
            {
              comments: [
                {
                  content: commentBody,
                  commentType: 1, // Text
                },
              ],
              status: 1, // Active
              ...(threadContext && { threadContext }),
            },
            repoId,
            prId,
          );
          totalPostedCount++;
          // セキュリティのため、コード内容は出力せず投稿先の情報のみをログに出力する
          const locationStr = lineNumber !== null ? `${file.path}:${lineNumber}` : `${file.path} (ファイル全体)`;
          console.log(`コメントを投稿しました: ${locationStr}`);
        } catch (postErr: unknown) {
          console.log(
            `コメントの投稿に失敗しました (${file.path}): ${postErr instanceof Error ? postErr.message : String(postErr)}`,
          );
        }
      }

      // レート制限への配慮: 次のリクエストまで待機
      if (i < changedFiles.length - 1) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }

    console.log(`AI レビューコメントを ${totalPostedCount} 件投稿しました。`);
    tl.setResult(tl.TaskResult.Succeeded, "AI レビューが完了しました。");
  } catch (err: unknown) {
    if (err instanceof Error) {
      tl.setResult(tl.TaskResult.Failed, err.message);
    } else {
      tl.setResult(tl.TaskResult.Failed, "不明なエラーが発生しました。");
    }
  }
}

run();
