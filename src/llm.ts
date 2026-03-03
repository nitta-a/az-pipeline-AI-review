import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAi, { AzureOpenAI } from "openai";
import { SYSTEM_PROMPT } from "./constants";
import type { ConnectionParams } from "./types";

/**
 * 指定されたプロバイダーの LLM へ差分テキストを送信し、
 * レビュー結果の文字列を返す
 */
export async function callLlm(params: ConnectionParams, diffText: string): Promise<string> {
  const userMessage = `以下の PR の変更内容をレビューしてください:\n\n${diffText}`;

  switch (params.provider) {
    case "azure": {
      if (!params.endpoint || !params.key) {
        throw new Error("Azure OpenAI には endpoint と key が必要です。");
      }
      const client = new AzureOpenAI({
        endpoint: params.endpoint,
        apiKey: params.key,
        apiVersion: params.apiVersion ?? "2024-02-01",
        deployment: params.model,
      });
      const res = await client.chat.completions.create({
        model: params.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
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
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
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
        // biome-ignore lint/style/useNamingConvention: Bedrock API requires snake_case
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
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
      const url = `${base}/v1/chat/completions`;
      const payload = {
        model: params.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.key}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Foundry request failed: ${res.status} ${txt}`);
      }
      const j = (await res.json()) as any;
      // OpenAI-compatible responses usually provide choices[0].message.content
      // Fallbacks attempt common alternative shapes.
      const content =
        j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? j?.outputs?.[0]?.content?.[0]?.text ?? "";
      return content;
    }

    default:
      throw new Error(
        `未対応のプロバイダーです: "${params.provider}"。azure / openai / anthropic / bedrock のいずれかを指定してください。`,
      );
  }
}
