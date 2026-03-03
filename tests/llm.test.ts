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

// ─── Foundry (generic) ─────────────────────────────────────────────────────────
describe("callLlm – foundry", () => {
  const baseParams: ConnectionParams = {
    provider: "foundry",
    endpoint: "https://example.com",
    key: "foundry-key",
    model: "gpt-5-mini",
  };

  beforeEach(() => {
    // reset global fetch mock
    (global as any).fetch = jest.fn();
  });

  test("デフォルトエンドポイントには /v1/chat/completions を付与", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Foundry result" } }] }),
    };
    (global as any).fetch.mockResolvedValue(mockResponse);

    const result = await callLlm(baseParams, "diff text");
    expect(result).toBe("Foundry result");
    expect((global as any).fetch).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.any(Object),
    );
  });

  test("すでに /responses パスを含むエンドポイントはそのまま使用", async () => {
    const params = { ...baseParams, endpoint: "https://example.com/openai/responses?api-version=2025-04-01-preview" };
    const mockResponse = {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "OK" } }] }),
    };
    (global as any).fetch.mockResolvedValue(mockResponse);

    const result = await callLlm(params, "diff");
    expect(result).toBe("OK");
    expect((global as any).fetch).toHaveBeenCalledWith(
      "https://example.com/openai/responses?api-version=2025-04-01-preview",
      expect.any(Object),
    );
  });

  test("Responses API エンドポイントでは input パラメータを使う", async () => {
    const params = { ...baseParams, endpoint: "https://example.com/openai/responses?api-version=2025-04-01-preview" };
    const mockResponse = {
      ok: true,
      json: async () => ({ choices: [] }),
    };
    (global as any).fetch.mockResolvedValue(mockResponse);

    await callLlm(params, "diff text");
    const callArgs = (global as any).fetch.mock.calls[0];
    const sentBody = JSON.parse(callArgs[1].body);
    expect(sentBody.input).toBeDefined();
    expect(sentBody.messages).toBeUndefined();
  });

  test("endpoint がない場合はエラー", async () => {
    const p = { ...baseParams, endpoint: undefined } as any;
    await expect(callLlm(p, "diff")).rejects.toThrow("endpoint");
  });

  test("key がない場合はエラー", async () => {
    const p = { ...baseParams, key: undefined } as any;
    await expect(callLlm(p, "diff")).rejects.toThrow("key");
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

// ─── Azure AI Foundry ──────────────────────────────────────────────────────────
describe("callLlm – foundry", () => {
  const baseParams: ConnectionParams = {
    provider: "foundry",
    endpoint: "https://my-project.services.ai.azure.com",
    key: "foundry-key",
    model: "gpt-4o",
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("LLM の回答文字列を返す (choices[0].message.content)", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Foundry レビュー結果" } }] }),
    });

    const result = await callLlm(baseParams, "diff text");
    expect(result).toBe("Foundry レビュー結果");
  });

  test("fetch に正しい URL と Authorization ヘッダーが渡される", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    await callLlm(baseParams, "diff");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://my-project.services.ai.azure.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer foundry-key",
        }),
      }),
    );
  });

  test("末尾スラッシュ付き endpoint でも /v1/chat/completions が正しく組み立てられる", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const params = { ...baseParams, endpoint: "https://my-project.services.ai.azure.com/" };
    await callLlm(params, "diff");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://my-project.services.ai.azure.com/v1/chat/completions",
      expect.anything(),
    );
  });

  test("HTTP エラー時は例外をスロー", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(callLlm(baseParams, "diff")).rejects.toThrow("401");
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
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const result = await callLlm(baseParams, "diff");
    expect(result).toBe("");
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

  test("エラーメッセージに foundry が候補として含まれる", async () => {
    const params: ConnectionParams = { provider: "unknown", model: "some-model" };
    await expect(callLlm(params, "diff")).rejects.toThrow("foundry");
  });
});
