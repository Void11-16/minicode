import { inflateRawSync } from "node:zlib";

/**
 * 最小 ZIP 读取器（零依赖）：只做一件事——把 .docx / .xlsx 这类 zip 容器
 * 解成 文件名 → 内容Buffer 的映射，供 OOXML 文本提取用。
 *
 * 只支持单磁盘、非 zip64 的常规压缩包（Word/WPS/Excel 导出的文件都满足）；
 * 遇到 zip64 会明确报错而不是静默给错数据。
 */
export function unzip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error("暂不支持 zip64 格式的文档");
  }

  const files = new Map<string, Buffer>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP 目录损坏（中央目录签名不匹配）");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("暂不支持 zip64 格式的文档");
    }
    // 本地头部的 name/extra 长度可能与中央目录不同，必须按本地头部定位数据起点
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("ZIP 目录损坏（本地头签名不匹配）");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);

    const content = method === 0 ? Buffer.from(payload) : method === 8 ? inflateRawSync(payload) : null;
    if (content !== null) files.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD 有 22 字节固定部分 + 最多 65535 字节注释：从尾部向前扫描签名
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("不是有效的 ZIP 文档（未找到目录结尾标记）");
}
