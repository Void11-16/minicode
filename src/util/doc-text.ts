import { unzip } from "./zip.ts";

/**
 * 从 .docx / .xlsx（OOXML）里提取文本与"两列表格行"（标签 → 填写值）。
 * 专为表单类文档设计：够用就好，不追求完整还原排版。
 */

export interface DocExtractResult {
  /** [标签, 填写] 行（取每个表格行的第 1、2 个单元格） */
  readonly rows: ReadonlyArray<readonly [string, string]>;
  /** 整篇可见文本（按段落/单元格换行） */
  readonly text: string;
}

export function extractDocx(buffer: Buffer): DocExtractResult {
  const files = unzip(buffer);
  const xml = files.get("word/document.xml");
  if (xml === undefined) throw new Error("不是有效的 Word 文档（缺少 document.xml）");
  const document = xml.toString("utf8");

  const rows: Array<readonly [string, string]> = [];
  for (const table of document.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)) {
    for (const tr of table[0].matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)) {
      const cells: string[] = [];
      for (const tc of tr[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)) {
        cells.push(plainText(tc[0]));
      }
      if (cells.length >= 2) {
        const label = cells[0].split("\n")[0].trim();
        const value = cells[1].trim();
        if (label !== "") rows.push([label, value] as const);
      }
    }
  }

  const text = [...document.matchAll(/<w:p[\s\S]*?<\/w:p>/g)]
    .map((match) => plainText(match[0]))
    .filter((line) => line.trim() !== "")
    .join("\n");
  return { rows, text };
}

export function extractXlsx(buffer: Buffer): DocExtractResult {
  const files = unzip(buffer);
  const shared = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const sheetName = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (sheetName === undefined) throw new Error("不是有效的 Excel 文件（缺少工作表）");
  const sheet = files.get(sheetName)!.toString("utf8");

  const rows: Array<readonly [string, string]> = [];
  const allText: string[] = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const byColumn = new Map<string, string>();
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const reference = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const body = cellMatch[2] ?? "";
      const value = cellValue(body, type, shared);
      if (reference !== "" && value !== "") byColumn.set(reference, value);
    }
    const a = byColumn.get("A") ?? "";
    const b = byColumn.get("B") ?? "";
    if (a !== "" && (b !== "" || byColumn.has("B"))) rows.push([a, b] as const);
    for (const value of byColumn.values()) allText.push(value);
  }
  return { rows, text: allText.join("\n") };
}

function cellValue(body: string, type: string, shared: readonly string[]): string {
  if (type === "s") {
    const index = Number.parseInt(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "", 10);
    return Number.isNaN(index) ? "" : shared[index] ?? "";
  }
  if (type === "inlineStr") return plainText(body);
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  return decodeEntities(raw).trim();
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    strings.push(plainText(match[1]));
  }
  return strings;
}

/** 去掉 XML 标签、还原换行与转义（w:br / w:tab / </w:p> 视为分隔） */
function plainText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<w:br[^>]*\/?>/g, "\n")
    .replace(/<w:tab[^>]*\/?>/g, "\t")
    .replace(/<\/w:p>/g, "\n");
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
