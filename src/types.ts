export interface ConnectionParams {
  provider: string;
  /** Azure OpenAI / カスタムエンドポイント */
  endpoint?: string;
  /** API キー */
  key?: string;
  /** モデル名 / デプロイ名 */
  model: string;
  /** 例: 2024-02-01 (Azure OpenAI のみ) */
  apiVersion?: string;
  /** AWS Bedrock リージョン */
  region?: string;
  /** AWS アクセスキー */
  accessKey?: string;
  /** AWS シークレットキー */
  secretKey?: string;
  [key: string]: string | undefined;
}

/**
 * "provider=azure;key=xxx;model=gpt-4o" のような文字列を
 * キーと値のマップへ変換する
 */
/** 接続文字列のスネークケースキーをキャメルケースプロパティへ変換するマップ */
const KEY_MAP: Record<string, string> = {
  ["api_version"]: "apiVersion",
  ["access_key"]: "accessKey",
  ["secret_key"]: "secretKey",
};

export function parseConnectionString(raw: string): ConnectionParams {
  const params: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const rawKey = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    const k = KEY_MAP[rawKey] ?? rawKey;
    if (k) {
      params[k] = v;
    }
  }
  if (!params.provider) {
    throw new Error("接続文字列に provider が含まれていません。例: provider=azure;endpoint=...;key=...;model=...");
  }
  if (!params.model) {
    throw new Error("接続文字列に model が含まれていません。例: model=gpt-4o");
  }
  return params as ConnectionParams;
}
