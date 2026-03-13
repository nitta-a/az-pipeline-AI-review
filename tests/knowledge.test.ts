import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { indexKnowledgeFiles, loadKnowledgeContents } from "../src/knowledge";

// ─── ヘルパー: 一時ディレクトリを生成して Markdown ファイルを配置する ──────────
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-test-"));
}

function writeMd(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

// ─── indexKnowledgeFiles ───────────────────────────────────────────────────────
describe("indexKnowledgeFiles", () => {
  test("存在しないディレクトリは空配列を返す", () => {
    const result = indexKnowledgeFiles("/nonexistent/path/.knowledge");
    expect(result).toEqual([]);
  });

  test("Markdown ファイルが 0 件の場合は空配列を返す", () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, "not-md.txt"), "content");
      const result = indexKnowledgeFiles(dir);
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("Frontmatter の tags を正しく解析する（配列形式）", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "react.md", "---\ntags: [react, typescript, component]\n---\n# React patterns");
      const result = indexKnowledgeFiles(dir);
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe("react.md");
      expect(result[0].tags).toEqual(["react", "typescript", "component"]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("Frontmatter がない場合は tags が空配列", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "no-fm.md", "# No frontmatter\n\nContent here.");
      const result = indexKnowledgeFiles(dir);
      expect(result).toHaveLength(1);
      expect(result[0].tags).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("tags フィールドがない Frontmatter は tags が空配列", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "no-tags.md", "---\ntitle: Security Guide\nauthor: dev\n---\n# Content");
      const result = indexKnowledgeFiles(dir);
      expect(result[0].tags).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("複数ファイルをすべてインデックス化する", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "security.md", "---\ntags: [security, auth]\n---\n# Security");
      writeMd(dir, "react.md", "---\ntags: [react, hooks]\n---\n# React");
      writeMd(dir, "api.md", "---\ntags: [api, rest]\n---\n# API");
      const result = indexKnowledgeFiles(dir);
      expect(result).toHaveLength(3);
      const filenames = result.map((e) => e.filename).sort();
      expect(filenames).toEqual(["api.md", "react.md", "security.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test(".md 以外のファイルはスキップされる", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "guide.md", "---\ntags: [guide]\n---\n# Guide");
      fs.writeFileSync(path.join(dir, "readme.txt"), "text file");
      fs.writeFileSync(path.join(dir, "config.json"), "{}");
      const result = indexKnowledgeFiles(dir);
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe("guide.md");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("Windows 改行コード（CRLF）の Frontmatter を解析できる", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "crlf.md", "---\r\ntags: [crlf, windows]\r\n---\r\n# Content");
      const result = indexKnowledgeFiles(dir);
      expect(result[0].tags).toEqual(["crlf", "windows"]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("インデックス段階ではファイル名とタグのみを含む", () => {
    const dir = createTempDir();
    try {
      const longContent = "---\ntags: [test]\n---\n" + "x".repeat(10000);
      writeMd(dir, "large.md", longContent);
      const result = indexKnowledgeFiles(dir);
      // インデックスにはファイル名とタグのみが含まれる
      expect(result[0].filename).toBe("large.md");
      expect(result[0].tags).toEqual(["test"]);
      // result にコンテンツフィールドは存在しない
      expect(Object.keys(result[0])).toEqual(["filename", "tags"]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ─── loadKnowledgeContents ─────────────────────────────────────────────────────
describe("loadKnowledgeContents", () => {
  test("指定ファイルの内容を結合して返す", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "security.md", "---\ntags: [security]\n---\n# Security Guide\nDo not hardcode secrets.");
      writeMd(dir, "react.md", "---\ntags: [react]\n---\n# React Guide\nUse hooks.");
      const result = loadKnowledgeContents(dir, ["security.md", "react.md"]);
      expect(result).toContain("## security.md");
      expect(result).toContain("Do not hardcode secrets.");
      expect(result).toContain("## react.md");
      expect(result).toContain("Use hooks.");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("空のファイル名リストは空文字列を返す", () => {
    const dir = createTempDir();
    try {
      const result = loadKnowledgeContents(dir, []);
      expect(result).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("存在しないファイルはスキップされる", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "valid.md", "---\ntags: [valid]\n---\n# Valid content");
      const result = loadKnowledgeContents(dir, ["nonexistent.md", "valid.md"]);
      expect(result).toContain("## valid.md");
      expect(result).toContain("Valid content");
      expect(result).not.toContain("nonexistent");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("複数ファイルをセパレーターで区切って結合する", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "a.md", "---\ntags: [a]\n---\n# A");
      writeMd(dir, "b.md", "---\ntags: [b]\n---\n# B");
      const result = loadKnowledgeContents(dir, ["a.md", "b.md"]);
      expect(result).toContain("---");
      expect(result.indexOf("## a.md")).toBeLessThan(result.indexOf("## b.md"));
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("1 件のファイルのみの場合もセパレーターなしで返す", () => {
    const dir = createTempDir();
    try {
      writeMd(dir, "only.md", "# Only file");
      const result = loadKnowledgeContents(dir, ["only.md"]);
      expect(result).toBe("## only.md\n\n# Only file");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
