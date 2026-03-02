import * as azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi";
import * as tl from "azure-pipelines-task-lib/task";
import { deleteExistingAiReviewComments, getPrDiff } from "./azureDevOps";
import { AI_REVIEW_MARKER } from "./constants";
import { callLlm } from "./llm";
import { parseConnectionString } from "./types";

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

    // 5. LLM へレビューを依頼
    console.log(`LLM (${connParams.provider}) にレビューを依頼しています...`);
    const reviewResult = await callLlm(connParams, diffText);

    // 6. 新規コメントを投稿（マーカー付き）
    const commentBody = `${AI_REVIEW_MARKER}\n## 🤖 AI コードレビュー\n\n${reviewResult}`;
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
