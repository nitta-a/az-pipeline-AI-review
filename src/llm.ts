import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAi, { AzureOpenAI } from "openai";
import { ROUTING_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./constants";
import type { KnowledgeEntry } from "./knowledge";
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
export async function callLlm(params: ConnectionParams, diffText: string, knowledgeContext?: string): Promise<string> {
  const isDebug = params.debug === "true";

  const systemPrompt = isDebug ? "あなたはテスト用のアシスタントです。" : SYSTEM_PROMPT;

  let userMessage: string;
  if (isDebug) {
    userMessage = "Hello とだけ返してください。";
  } else if (knowledgeContext) {
    userMessage =
      `以下の技術的制約（Context）に基づき、PR の変更内容をレビューしてください。\n\n` +
      `### 技術的制約（ナレッジ）:\n${knowledgeContext}\n\n` +
      `### レビュー対象:\n${diffText}`;
  } else {
    userMessage = `以下の PR の変更内容をレビューしてください:\n\n${diffText}`;
  }

  if (isDebug) {
    console.log("⚠️ デバッグモード: テスト用の短いプロンプトを送信します。");
  }

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
        console.log("##[warning]Foundry レスポンスのコンテンツが空です。");
      }
      return content;
    }

    default:
      throw new Error(
        `未対応のプロバイダーです: "${params.provider}"。azure / openai / anthropic / bedrock / foundry のいずれかを指定してください。`,
      );
  }
}

/**
 * LLM のレスポンスから JSON 配列（ファイル名のリスト）を抽出する。
 * コードブロックや前後の説明文を除去して安全にパースする。
 */
function parseFilenameArray(response: string): string[] {
  // コードブロック記法を除去
  const stripped = response.replace(/```[a-z]*\n?/gi, "").trim();
  // 最初の "[" から最後の "]" までを抽出
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // JSON パース失敗は空配列として扱う
  }
  return [];
}

/**
 * Pass 1（ルーティング）: ナレッジインデックスと変更ファイル一覧を LLM へ送信し、
 * このレビューに最も関連性の高いナレッジファイル名の一覧を返す。
 * 選択ロジックはすべて LLM に委ねる。
 */
export async function selectKnowledgeFiles(
  params: ConnectionParams,
  knowledgeIndex: KnowledgeEntry[],
  changedFilesSummary: string,
): Promise<string[]> {
  if (knowledgeIndex.length === 0) {
    return [];
  }

  const knowledgeList = knowledgeIndex
    .map((entry) => {
      const tagStr = entry.tags.length > 0 ? ` [tags: ${entry.tags.join(", ")}]` : "";
      return `- ${entry.filename}${tagStr}`;
    })
    .join("\n");

  const userMessage = `## ナレッジファイル一覧:\n${knowledgeList}\n\n` + `## 変更ファイル一覧:\n${changedFilesSummary}`;

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
          { role: "system", content: ROUTING_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });
      return parseFilenameArray(res.choices[0]?.message?.content ?? "");
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
          { role: "system", content: ROUTING_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });
      return parseFilenameArray(res.choices[0]?.message?.content ?? "");
    }

    case "anthropic": {
      if (!params.key) {
        throw new Error("Anthropic には key が必要です。");
      }
      const client = new Anthropic({ apiKey: params.key });
      const maxTokens = 40960;
      const res = await client.messages.create({
        model: params.model,
        // biome-ignore lint/style/useNamingConvention: Anthropic SDK requires snake_case
        max_tokens: maxTokens,
        ...(temperature !== undefined && { temperature }),
        system: ROUTING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });
      const block = res.content[0];
      return parseFilenameArray(block?.type === "text" ? block.text : "");
    }

    case "bedrock": {
      if (!params.region || !params.accessKey || !params.secretKey) {
        throw new Error("AWS Bedrock には region, access_key, secret_key が必要です。");
      }
      const maxTokens = 40960;
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
        // biome-ignore lint/style/useNamingConvention: Bedrock API requires snake_case
        max_tokens: maxTokens,
        ...(temperature !== undefined && { temperature }),
        system: ROUTING_SYSTEM_PROMPT,
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
      return parseFilenameArray(decoded.content?.[0]?.text ?? "");
    }

    case "foundry": {
      if (!params.endpoint || !params.key) {
        throw new Error(
          "Foundry には endpoint (target URI) と key が必要です。例: provider=foundry;target=https://...;key=...;model=<model>",
        );
      }
      const base = params.endpoint.replace(/\/$/, "");
      let url: string;
      if (/\/v1\/chat\.completions|\/responses|openai/i.test(base)) {
        url = base;
      } else {
        url = `${base}/v1/chat/completions`;
      }

      const messages = [
        { role: "system", content: ROUTING_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ];

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

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // biome-ignore lint/style/useNamingConvention: false positive
          Authorization: `Bearer ${params.key}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Foundry routing request failed: ${res.status} ${txt}`);
      }
      const j = (await res.json()) as any;

      let content: string = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? "";

      if (!content && Array.isArray(j?.output)) {
        for (const item of j.output) {
          if (item?.type === "message" && Array.isArray(item?.content)) {
            for (const block of item.content) {
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

      if (!content) {
        const fallback = findFirstTextField(j);
        if (fallback) {
          content = fallback;
        }
      }

      return parseFilenameArray(content);
    }

    default:
      throw new Error(
        `未対応のプロバイダーです: "${params.provider}"。azure / openai / anthropic / bedrock / foundry のいずれかを指定してください。`,
      );
  }
}
