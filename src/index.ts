import * as azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import * as tl from "azure-pipelines-task-lib/task";
import { deleteExistingAiReviewComments, getChangedFiles } from "./azureDevOps";
import { AI_REVIEW_MARKER, RATE_LIMIT_DELAY_MS } from "./constants";
import { callLlm } from "./llm";
import { parseConnectionString } from "./types";

export function formatReviewComment(reviewResult: string): string {
  // LLM からの返信が空文字の場合は明示的に "コメントはありません。" と表示する
  const body = reviewResult.trim() || "コメントはありません。";
  return `${AI_REVIEW_MARKER}\n## 🤖 AI コードレビュー\n\n${body}`;
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

    // 5. 1 ファイルずつ LLM へレビューを依頼し、結果を収集
    const reviewParts: string[] = [];

    for (let i = 0; i < changedFiles.length; i++) {
      const file = changedFiles[i];

      console.log(`##[group]📄 ファイル処理中 (${i + 1}/${changedFiles.length}): ${file.path}`);
      console.log(`変更種別: ${file.changeLabel}`);

      // 削除ファイルや取得失敗はスキップ
      if (file.content === null) {
        console.log("コンテンツが取得できなかったため LLM へのリクエストをスキップします。");
        console.log("##[endgroup]");
        reviewParts.push(`### [${file.changeLabel}] \`${file.path}\`\n*(コンテンツを取得できませんでした)*`);
        continue;
      }

      const ext = file.path.split(".").pop() ?? "";
      const fileDiffText = `### [${file.changeLabel}] \`${file.path}\`\n` + "```" + ext + "\n" + file.content + "\n```";

      console.log(`LLM (${connParams.provider}) にレビューを依頼しています...`);
      const fileReview = await callLlm(connParams, fileDiffText);

      // デバッグ: このファイルに対する LLM の生レスポンスをログに出力
      console.log("🤖 LLM レスポンス (生):");
      console.log(fileReview || "(レスポンスが空です)");
      console.log("##[endgroup]");

      if (fileReview.trim()) {
        reviewParts.push(`### [${file.changeLabel}] \`${file.path}\`\n\n${fileReview.trim()}`);
      }

      // レート制限への配慮: 次のリクエストまで待機
      if (i < changedFiles.length - 1) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }

    // 6. 全ファイルのレビュー結果を結合して PR コメントとして投稿
    const combinedReview = reviewParts.join("\n\n---\n\n");
    const commentBody = formatReviewComment(combinedReview);

    // デバッグ: PR コメントとして投稿する最終本文をログに出力
    console.log("##[group]📝 PR コメント投稿内容");
    console.log(commentBody);
    console.log("##[endgroup]");

    console.log("PR にコメントスレッドを投稿しています...");
    await gitApi.createThread(
      {
        comments: [
          {
            content: commentBody,
            commentType: 1, // Text
          },
        ],
        status: 1, // Active
      },
      repoId,
      prId,
    );

    console.log("AI レビューコメントを投稿しました。");
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
