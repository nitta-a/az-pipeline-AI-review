import { callLlm } from "../src/llm";
import type { ConnectionParams } from "../src/types";

// ─── LLM SDK をモック ──────────────────────────────────────────────────────────
jest.mock("openai", () => {
  const mockCreate = jest.fn();
  const MockOpenAi = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })) as any;
  const MockAzureOpenAI = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })) as any;
  // モックの create 関数をテストから参照できるよう static プロパティに格納
  MockOpenAi._mockCreate = mockCreate;
  MockAzureOpenAI._mockCreate = mockCreate;
  return { __esModule: true, default: MockOpenAi, AzureOpenAI: MockAzureOpenAI, _mockCreate: mockCreate };
});

jest.mock("@anthropic-ai/sdk", () => {
  const mockCreate = jest.fn();
  const MockAnthropic = jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })) as any;
  MockAnthropic._mockCreate = mockCreate;
  return { __esModule: true, default: MockAnthropic, _mockCreate: mockCreate };
});

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const mockSend = jest.fn();
  const MockClient = jest.fn().mockImplementation(() => ({ send: mockSend })) as any;
  const MockCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
  MockClient._mockSend = mockSend;
  return {
    __esModule: true,
    BedrockRuntimeClient: MockClient,
    InvokeModelCommand: MockCommand,
    _mockSend: mockSend,
  };
});

// ─── ヘルパー: モジュールの _mockCreate / _mockSend を取得 ────────────────────
function getOpenAiCreate() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("openai") as any)._mockCreate as jest.Mock;
}
function getAnthropicCreate() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@anthropic-ai/sdk") as any)._mockCreate as jest.Mock;
}
function getBedrockSend() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@aws-sdk/client-bedrock-runtime") as any)._mockSend as jest.Mock;
}

// ─── Azure OpenAI ──────────────────────────────────────────────────────────────
describe("callLlm – azure", () => {
  const baseParams: ConnectionParams = {
    provider: "azure",
    endpoint: "https://example.openai.azure.com",
    key: "azure-key",
    model: "gpt-4o",
    apiVersion: "2024-02-01",
  };

  test("LLM の回答文字列を返す", async () => {
    getOpenAiCreate().mockResolvedValue({
      choices: [{ message: { content: "Azure レビュー結果" } }],
    });

    const result = await callLlm(baseParams, "diff text");
    expect(result).toBe("Azure レビュー結果");
    expect(getOpenAiCreate()).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ]),
      }),
    );
  });

  test("endpoint がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, endpoint: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("endpoint");
  });

  test("key がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, key: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("key");
  });

  test("choices が空の場合は空文字列を返す", async () => {
    getOpenAiCreate().mockResolvedValue({ choices: [] });
    const result = await callLlm(baseParams, "diff");
    expect(result).toBe("");
  });
});

// ─── OpenAI ────────────────────────────────────────────────────────────────────
describe("callLlm – openai", () => {
  const baseParams: ConnectionParams = {
    provider: "openai",
    key: "sk-test",
    model: "gpt-4o-mini",
  };

  test("LLM の回答文字列を返す", async () => {
    getOpenAiCreate().mockResolvedValue({
      choices: [{ message: { content: "OpenAI レビュー結果" } }],
    });

    const result = await callLlm(baseParams, "diff text");
    expect(result).toBe("OpenAI レビュー結果");
  });

  test("key がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, key: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("key");
  });

  test("message.content が null の場合は空文字列を返す", async () => {
    getOpenAiCreate().mockResolvedValue({
      choices: [{ message: { content: null } }],
    });
    const result = await callLlm(baseParams, "diff");
    expect(result).toBe("");
  });
});

// ─── Anthropic ─────────────────────────────────────────────────────────────────
describe("callLlm – anthropic", () => {
  const baseParams: ConnectionParams = {
    provider: "anthropic",
    key: "sk-ant-test",
    model: "claude-3-5-sonnet-20241022",
  };

  test("text ブロックの内容を返す", async () => {
    getAnthropicCreate().mockResolvedValue({
      content: [{ type: "text", text: "Anthropic レビュー結果" }],
    });

    const result = await callLlm(baseParams, "diff text");
    expect(result).toBe("Anthropic レビュー結果");
    expect(getAnthropicCreate()).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-3-5-sonnet-20241022",
        // biome-ignore lint/style/useNamingConvention: Anthropic SDK requires snake_case
        max_tokens: 4096,
      }),
    );
  });

  test("key がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, key: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("key");
  });

  test("content が空の場合は空文字列を返す", async () => {
    getAnthropicCreate().mockResolvedValue({ content: [] });
    const result = await callLlm(baseParams, "diff");
    expect(result).toBe("");
  });

  test("content[0] が text 以外のブロックの場合は空文字列を返す", async () => {
    getAnthropicCreate().mockResolvedValue({
      content: [{ type: "tool_use", id: "tu_01", name: "get_weather", input: {} }],
    });
    const result = await callLlm(baseParams, "diff");
    expect(result).toBe("");
  });
});

// ─── AWS Bedrock ───────────────────────────────────────────────────────────────
describe("callLlm – bedrock", () => {
  const baseParams: ConnectionParams = {
    provider: "bedrock",
    region: "us-east-1",
    accessKey: "AKIAIOSFODNN7",
    secretKey: "wJalrXUtnFEMI",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  };

  function makeBedrockResponse(text: string): { body: Uint8Array } {
    const payload = JSON.stringify({ content: [{ type: "text", text }] });
    return { body: new TextEncoder().encode(payload) };
  }

  test("Bedrock の回答文字列を返す", async () => {
    getBedrockSend().mockResolvedValue(makeBedrockResponse("Bedrock レビュー結果"));

    const result = await callLlm(baseParams, "diff text");
    expect(result).toBe("Bedrock レビュー結果");
  });

  test("region がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, region: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("region");
  });

  test("accessKey がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, accessKey: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("access_key");
  });

  test("secretKey がない場合はエラーをスロー", async () => {
    const params = { ...baseParams, secretKey: undefined };
    await expect(callLlm(params, "diff")).rejects.toThrow("secret_key");
  });

  test("content が空の場合は空文字列を返す", async () => {
    getBedrockSend().mockResolvedValue(makeBedrockResponse(""));
    // content[0].text が空文字
    const result = await callLlm(baseParams, "diff");
    expect(result).toBe("");
  });

  test("InvokeModelCommand に正しい modelId が渡される", async () => {
    getBedrockSend().mockResolvedValue(makeBedrockResponse("ok"));
    await callLlm(baseParams, "diff");

    const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime") as any;
    expect(InvokeModelCommand).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0" }),
    );
  });
});

// ─── 未対応プロバイダー ────────────────────────────────────────────────────────
describe("callLlm – 未対応プロバイダー", () => {
  test("未知の provider はエラーをスロー", async () => {
    const params: ConnectionParams = { provider: "unknown", model: "some-model" };
    await expect(callLlm(params, "diff")).rejects.toThrow("未対応のプロバイダーです");
  });

  test("エラーメッセージにプロバイダー名が含まれる", async () => {
    const params: ConnectionParams = { provider: "gcp-vertex", model: "gemini" };
    await expect(callLlm(params, "diff")).rejects.toThrow("gcp-vertex");
  });
});
