import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAi, { AzureOpenAI } from "openai";
import { SYSTEM_PROMPT } from "./constants";
import type { ConnectionParams } from "./types";

/**
 * JSON オブジェクトを深さ優先で探索し、最初に見つかった非空の `text` 文字列を返す。
 * Responses API など階層が深い/不定なレスポンスへのフォールバック用。
 */
function findFirstTextField(obj: unknown): string | undefined {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstTextField(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    if (typeof record.text === "string" && record.text) {
      return record.text;
    }
    for (const key of Object.keys(record)) {
      if (key === "text") {
        continue;
      }
      const found = findFirstTextField(record[key]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** 接続文字列の temperature を数値に変換する（デフォルト: undefined＝プロバイダー任せ） */
function resolveTemperature(params: ConnectionParams): number | undefined {
  if (params.temperature) {
    const n = Number(params.temperature);
    if (!Number.isNaN(n)) {
      return n;
    }
  }
  return undefined;
}

/**
 * 指定されたプロバイダーの LLM へ差分テキストを送信し、
 * レビュー結果の文字列を返す
 */
export async function callLlm(params: ConnectionParams, diffText: string): Promise<string> {
  const isDebug = params.debug === "true";

  const systemPrompt = isDebug ? "あなたはテスト用のアシスタントです。" : SYSTEM_PROMPT;
  const userMessage = isDebug
    ? "Hello とだけ返してください。"
    : `以下の PR の変更内容をレビューしてください:\n\n${diffText}`;

  if (isDebug) {
    console.log("⚠️ デバッグモード: テスト用の短いプロンプトを送信します。");
  }

  // デバッグ: LLM に送信するプロンプト全文をログに出力
  console.log("##[group]📤 LLM 送信プロンプト");
  console.log(`[System]\n${systemPrompt}`);
  console.log(`[User]\n${userMessage}`);
  console.log("##[endgroup]");

  const maxTokens = 40960;
  const temperature = resolveTemperature(params);

  switch (params.provider) {
    case "azure": {
      if (!params.endpoint || !params.key) {
        throw new Error("Azure OpenAI には endpoint と key が必要です。");
      }
      const client = new AzureOpenAI({
        endpoint: params.endpoint,
        apiKey: params.key,
        apiVersion: params.apiVersion ?? "2024-10-21",
        deployment: params.model,
      });
      const res = await client.chat.completions.create({
        model: params.model,
        ...(temperature !== undefined && { temperature }),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      return res.choices[0]?.message?.content ?? "";
    }

    case "openai": {
      if (!params.key) {
        throw new Error("OpenAI には key が必要です。");
      }
      const client = new OpenAi({ apiKey: params.key });
      const res = await client.chat.completions.create({
        model: params.model,
        ...(temperature !== undefined && { temperature }),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      return res.choices[0]?.message?.content ?? "";
    }

    case "anthropic": {
      if (!params.key) {
        throw new Error("Anthropic には key が必要です。");
      }
      const client = new Anthropic({ apiKey: params.key });
      const res = await client.messages.create({
        model: params.model,
        // biome-ignore lint/style/useNamingConvention: Anthropic SDK requires snake_case
        max_tokens: maxTokens,
        ...(temperature !== undefined && { temperature }),
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const block = res.content[0];
      return block?.type === "text" ? block.text : "";
    }

    case "bedrock": {
      if (!params.region || !params.accessKey || !params.secretKey) {
        throw new Error("AWS Bedrock には region, access_key, secret_key が必要です。");
      }
      const client = new BedrockRuntimeClient({
        region: params.region,
        credentials: {
          accessKeyId: params.accessKey,
          secretAccessKey: params.secretKey,
        },
      });
      const body = JSON.stringify({
        // biome-ignore lint/style/useNamingConvention: Bedrock API requires snake_case
        anthropic_version: "bedrock-2023-05-31",
        ...(temperature !== undefined && { temperature }),
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const command = new InvokeModelCommand({
        modelId: params.model,
        contentType: "application/json",
        accept: "application/json",
        body: Buffer.from(body),
      });
      const raw = await client.send(command);
      const decoded = JSON.parse(new TextDecoder().decode(raw.body)) as {
        content?: Array<{ type: string; text: string }>;
      };
      return decoded.content?.[0]?.text ?? "";
    }

    case "foundry": {
      if (!params.endpoint || !params.key) {
        throw new Error(
          "Foundry には endpoint (target URI) と key が必要です。例: provider=foundry;target=https://...;key=...;model=<model>",
        );
      }
      // Many Foundry endpoints are OpenAI-compatible. Try a generic OpenAI-compatible HTTP call.
      const base = params.endpoint.replace(/\/$/, "");
      // If the provided endpoint already includes a model-specific path (e.g. "/chat/completions" or
      // "/responses"), assume it's the full URL and use it directly. This allows Azure/Foundry
      // customers to specify the OpenAI-compatible path including query parameters like
      // `?api-version=...`.
      let url: string;
      if (/\/v1\/chat\.completions|\/responses|openai/i.test(base)) {
        url = base;
      } else {
        url = `${base}/v1/chat/completions`;
      }

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];

      // Responses API (used by newer Foundry/Cognitive Services endpoints) expects the input
      // in an `input` field instead of `messages`.
      const isResponsesApi = /\/responses\b/i.test(url);
      const payload: Record<string, unknown> = {
        model: params.model,
        ...(temperature !== undefined && { temperature }),
      };
      if (isResponsesApi) {
        payload.input = messages;
      } else {
        payload.messages = messages;
      }

      console.log(`Foundry リクエスト URL: ${url}`);
      console.log(`Foundry ペイロード (temperature=${temperature ?? "default"})`);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // biome-ignore lint/style/useNamingConvention: false positive
          Authorization: `Bearer ${params.key}`,
        },
        body: JSON.stringify(payload),
      });

      // 詳細なレスポンス情報をログ出力
      console.log(`Foundry HTTP ステータス: ${res.status} ${res.statusText}`);
      const errorCode = res.headers.get("x-ms-error-code");
      if (errorCode) {
        console.log(`Foundry x-ms-error-code: ${errorCode}`);
      }

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Foundry request failed: ${res.status} ${txt}`);
      }
      const j = (await res.json()) as any;

      // 1. OpenAI-compatible: choices[0].message.content
      let content: string = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? "";

      // 2. Responses API: output 配列を走査し type=message かつ content 内に
      //    type=output_text を持つ要素から text を抽出する。
      //    gpt-5-mini などは output[0] が type=reasoning のため 0 番目ではなく
      //    配列全体をスキャンする必要がある。
      if (!content && Array.isArray(j?.output)) {
        console.log(`Foundry output 配列の要素数: ${j.output.length}`);
        for (const item of j.output) {
          console.log(`  output item type: ${item?.type}`);
          if (item?.type === "message" && Array.isArray(item?.content)) {
            for (const block of item.content) {
              console.log(`    content block type: ${block?.type}`);
              if (block?.type === "output_text" && block?.text) {
                content = block.text;
                break;
              }
            }
          }
          if (content) {
            break;
          }
        }
      }

      // 3. フォールバック: JSON 全体から text フィールドを再帰的に探す
      if (!content) {
        const fallback = findFirstTextField(j);
        if (fallback) {
          console.log("##[warning]Foundry: 想定パスでテキストが見つからなかったため、再帰探索で取得しました。");
          content = fallback;
        }
      }

      if (!content) {
        console.log("##[warning]Foundry レスポンスのコンテンツが空です。レスポンスボディ全体:");
        console.log(JSON.stringify(j, null, 2));
      }
      return content;
    }

    default:
      throw new Error(
        `未対応のプロバイダーです: "${params.provider}"。azure / openai / anthropic / bedrock / foundry のいずれかを指定してください。`,
      );
  }
}
