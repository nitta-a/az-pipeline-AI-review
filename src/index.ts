import * as azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import * as tl from "azure-pipelines-task-lib/task";
import { deleteExistingAiReviewComments, getPrDiff } from "./azureDevOps";
import { AI_REVIEW_MARKER } from "./constants";
import { callLlm } from "./llm";
import { parseConnectionString } from "./types";

export function formatReviewComment(reviewResult: string): string {
  // LLM からの返信が空文字の場合は明示的に "コメントはありません。" と表示する
  const body = reviewResult.trim() || "コメントはありません。";
  return `${AI_REVIEW_MARKER}\n## 🤖 AI コードレビュー\n\n${body}`;
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

    // 4. PR 差分を取得
    console.log("PR の差分を取得しています...");
    const diffText = await getPrDiff(gitApi, repoId, prId);
    console.log(`差分テキスト長: ${diffText.length} 文字`);

    // デバッグ: 取得した差分の全文をログに出力
    console.log("##[group]🔍 Git Diff (LLM 送信前)");
    console.log(diffText || "(差分が空です)");
    console.log("##[endgroup]");

    // 5. LLM へレビューを依頼
    console.log(`LLM (${connParams.provider}) にレビューを依頼しています...`);
    console.log(
      `接続パラメータ: provider=${connParams.provider}, model=${connParams.model}, apiVersion=${connParams.apiVersion ?? "(default)"}, maxTokens=${connParams.maxTokens ?? "(default:4096)"}, temperature=${connParams.temperature ?? "(default)"}, debug=${connParams.debug ?? "false"}`,
    );
    const reviewResult = await callLlm(connParams, diffText);

    // デバッグ: LLM からの生レスポンスをログに出力
    console.log("##[group]🤖 LLM レスポンス (生)");
    console.log(reviewResult || "(レスポンスが空です)");
    console.log("##[endgroup]");

    // 6. 新規コメントを投稿（マーカー付き）
    const commentBody = formatReviewComment(reviewResult);

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
