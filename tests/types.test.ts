import { parseConnectionString } from "../src/types";

describe("parseConnectionString", () => {
  // ─── 正常系 ───────────────────────────────────────────────

  test("Azure OpenAI の接続文字列をパースできる", () => {
    const result = parseConnectionString(
      "provider=azure;endpoint=https://example.openai.azure.com;key=my-key;model=gpt-4o;api_version=2024-02-01",
    );
    expect(result.provider).toBe("azure");
    expect(result.endpoint).toBe("https://example.openai.azure.com");
    expect(result.key).toBe("my-key");
    expect(result.model).toBe("gpt-4o");
    expect(result.apiVersion).toBe("2024-02-01");
    // スネークケースキーはそのままは残らない
    expect((result as Record<string, unknown>).api_version).toBeUndefined();
  });

  test("OpenAI の接続文字列をパースできる", () => {
    const result = parseConnectionString("provider=openai;key=sk-test;model=gpt-4o-mini");
    expect(result.provider).toBe("openai");
    expect(result.key).toBe("sk-test");
    expect(result.model).toBe("gpt-4o-mini");
  });

  test("Anthropic の接続文字列をパースできる", () => {
    const result = parseConnectionString(
      "provider=anthropic;key=sk-ant-test;model=claude-3-5-sonnet-20241022",
    );
    expect(result.provider).toBe("anthropic");
    expect(result.key).toBe("sk-ant-test");
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
  });

  test("AWS Bedrock の接続文字列をパースできる", () => {
    const result = parseConnectionString(
      "provider=bedrock;region=us-east-1;access_key=AKIAIOSFODNN7;secret_key=wJalrXUtnFEMI;model=anthropic.claude-3-5-sonnet-20241022-v2:0",
    );
    expect(result.provider).toBe("bedrock");
    expect(result.region).toBe("us-east-1");
    expect(result.accessKey).toBe("AKIAIOSFODNN7");
    expect(result.secretKey).toBe("wJalrXUtnFEMI");
    expect(result.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    // スネークケースキーはそのままは残らない
    expect((result as Record<string, unknown>).access_key).toBeUndefined();
    expect((result as Record<string, unknown>).secret_key).toBeUndefined();
  });

  test("Azure AI Foundry の接続文字列を endpoint キーでパースできる", () => {
    const result = parseConnectionString(
      "provider=foundry;endpoint=https://my-project.services.ai.azure.com;key=my-key;model=gpt-4o",
    );
    expect(result.provider).toBe("foundry");
    expect(result.endpoint).toBe("https://my-project.services.ai.azure.com");
    expect(result.key).toBe("my-key");
    expect(result.model).toBe("gpt-4o");
  });

  test("Azure AI Foundry の接続文字列を target キーでパースできる", () => {
    const result = parseConnectionString(
      "provider=foundry;target=https://my-project.services.ai.azure.com;key=my-key;model=gpt-4o",
    );
    expect(result.provider).toBe("foundry");
    expect(result.endpoint).toBe("https://my-project.services.ai.azure.com");
    expect(result.key).toBe("my-key");
    expect(result.model).toBe("gpt-4o");
    expect((result as Record<string, unknown>).target).toBeUndefined();
  });

  test("Azure AI Foundry の接続文字列を target_uri キーでパースできる", () => {
    const result = parseConnectionString(
      "provider=foundry;target_uri=https://my-project.services.ai.azure.com;key=my-key;model=gpt-4o",
    );
    expect(result.provider).toBe("foundry");
    expect(result.endpoint).toBe("https://my-project.services.ai.azure.com");
    expect(result.key).toBe("my-key");
    expect(result.model).toBe("gpt-4o");
    expect((result as Record<string, unknown>).target_uri).toBeUndefined();
  });

  test("value に = を含む URL でも正しくパースできる", () => {
    // endpoint=https://example.com の部分は idx=最初の = の位置で分割されるべき
    const result = parseConnectionString(
      "provider=azure;endpoint=https://example.openai.azure.com;key=key=withequal;model=gpt-4o",
    );
    expect(result.provider).toBe("azure");
    expect(result.endpoint).toBe("https://example.openai.azure.com");
    // 最初の = 以降すべてが value になる
    expect(result.key).toBe("key=withequal");
    expect(result.model).toBe("gpt-4o");
  });

  test("= のないセグメントは無視される", () => {
    const result = parseConnectionString("provider=openai;no-equals-here;key=sk-test;model=gpt-4o");
    expect(result.provider).toBe("openai");
    expect(result.key).toBe("sk-test");
    expect(result.model).toBe("gpt-4o");
  });

  test("値が空文字のキーも受け入れる", () => {
    const result = parseConnectionString("provider=openai;key=;model=gpt-4o");
    expect(result.provider).toBe("openai");
    expect(result.key).toBe("");
    expect(result.model).toBe("gpt-4o");
  });

  test("前後のスペースをトリムする", () => {
    const result = parseConnectionString(" provider = openai ; key = sk-test ; model = gpt-4o ");
    expect(result.provider).toBe("openai");
    expect(result.key).toBe("sk-test");
    expect(result.model).toBe("gpt-4o");
  });

  test("max_tokens と temperature をパースできる", () => {
    const result = parseConnectionString(
      "provider=openai;key=sk-test;model=gpt-4o;max_tokens=8192;temperature=0.2",
    );
    expect(result.maxTokens).toBe("8192");
    expect(result.temperature).toBe("0.2");
    // スネークケースキーはそのままは残らない
    expect((result as Record<string, unknown>).max_tokens).toBeUndefined();
  });

  test("debug パラメータをパースできる", () => {
    const result = parseConnectionString(
      "provider=openai;key=sk-test;model=gpt-4o;debug=true",
    );
    expect(result.debug).toBe("true");
  });

  // ─── 異常系 ───────────────────────────────────────────────

  test("provider がない場合はエラーをスロー", () => {
    expect(() => parseConnectionString("key=sk-test;model=gpt-4o")).toThrow("provider");
  });

  test("model がない場合はエラーをスロー", () => {
    expect(() => parseConnectionString("provider=openai;key=sk-test")).toThrow("model");
  });

  test("空文字列の場合は provider/model エラーをスロー", () => {
    expect(() => parseConnectionString("")).toThrow();
  });
});
