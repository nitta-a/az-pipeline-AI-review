import * as fs from "node:fs";
import * as path from "node:path";

/** ナレッジファイルのインデックスエントリ */
export interface KnowledgeEntry {
  /** Markdown ファイル名（例: security.md） */
  filename: string;
  /** Frontmatter から抽出したタグ一覧 */
  tags: string[];
}

/**
 * YAML Frontmatter の `tags:` フィールドからタグ一覧を抽出する。
 * 対応形式:
 *   tags: [tag1, tag2]
 *   tags: tag1, tag2
 */
function parseFrontmatterTags(content: string): string[] {
  const fmMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    return [];
  }
  const frontmatter = fmMatch[1];

  // tags: [tag1, tag2] または tags: tag1, tag2
  const tagsMatch = frontmatter.match(/^tags:\s*\[([^\]]*)\]|^tags:\s*(.+)$/m);
  if (!tagsMatch) {
    return [];
  }
  const raw = tagsMatch[1] ?? tagsMatch[2] ?? "";
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * `.knowledge/` フォルダ内のすべての Markdown ファイルをスキャンし、
 * ファイル名と Frontmatter の tags の一覧を返す。
 * ファイルの本文（本体）はこの段階では読み込まない。
 */
export function indexKnowledgeFiles(knowledgeDir: string): KnowledgeEntry[] {
  if (!fs.existsSync(knowledgeDir)) {
    return [];
  }

  let filenames: string[];
  try {
    filenames = fs.readdirSync(knowledgeDir).filter((f: string) => f.endsWith(".md"));
  } catch {
    return [];
  }

  return filenames.map((filename) => {
    const filePath = path.join(knowledgeDir, filename);
    try {
      // Frontmatter のタグ取得のためファイルの内容を読み込む
      const content = fs.readFileSync(filePath, "utf-8");
      const tags = parseFrontmatterTags(content);
      return { filename, tags };
    } catch {
      return { filename, tags: [] };
    }
  });
}

/**
 * 指定されたナレッジファイルの本文を読み込み、
 * 結合した「技術的制約（Context）」テキストとして返す。
 */
export function loadKnowledgeContents(knowledgeDir: string, filenames: string[]): string {
  const parts: string[] = [];
  for (const filename of filenames) {
    const filePath = path.join(knowledgeDir, filename);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      parts.push(`## ${filename}\n\n${content}`);
    } catch {
      // ファイルが存在しない場合はスキップ
    }
  }
  return parts.join("\n\n---\n\n");
}
