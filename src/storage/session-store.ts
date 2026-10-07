import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Session, type SessionData } from "../core/session.ts";

export interface SessionMeta {
  readonly id: string;
  readonly messageCount: number;
  readonly updatedAt: number;
  readonly preview: string;
  readonly title: string;
  readonly epoch: number;
}

export interface SessionStore {
  save(session: Session): Promise<void>;
  load(id: string): Promise<Session | null>;
  list(): Promise<SessionMeta[]>;
  /** 压缩前归档原始会话（防不可逆丢失） */
  archive(session: Session, epoch: number): Promise<void>;
  /** 删除会话主文件；返回是否删除成功 */
  delete(id: string): Promise<boolean>;
  /** 删除该会话的全部归档文件（逐个删除），返回删除数量 */
  deleteArchives(id: string): Promise<number>;
}

/** JSON 文件存储 —— 每个会话一个文件，简单可靠，够用了 */
export class JsonFileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async save(session: Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(session.id);
    await writeFile(file, JSON.stringify(session.toData(), null, 2), "utf8");
  }

  async archive(session: Session, epoch: number): Promise<void> {
    const archiveDir = join(this.dir, "archive");
    await mkdir(archiveDir, { recursive: true });
    const file = join(archiveDir, `${session.id}_epoch${epoch}.json`);
    await writeFile(file, JSON.stringify(session.toData(), null, 2), "utf8");
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    try {
      await unlink(this.fileFor(id));
    } catch {
      return false;
    }
    return true;
  }

  async deleteArchives(id: string): Promise<number> {
    if (!isValidSessionId(id)) return 0;
    let count = 0;
    try {
      const names = await readdir(join(this.dir, "archive"));
      for (const name of names) {
        // 归档命名: <id>_epoch<N>.json —— 按明确路径逐个删除
        if (name.startsWith(`${id}_epoch`) && name.endsWith(".json")) {
          try {
            await unlink(join(this.dir, "archive", name));
            count += 1;
          } catch {
            // 单个归档删除失败不阻塞其余
          }
        }
      }
    } catch {
      // archive 目录不存在 = 没有归档
    }
    return count;
  }

  async load(id: string): Promise<Session | null> {
    if (!isValidSessionId(id)) return null;
    try {
      const raw = await readFile(this.fileFor(id), "utf8");
      const data = JSON.parse(raw) as SessionData;
      return Session.fromData(data);
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }

    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.dir, name), "utf8");
        const data = JSON.parse(raw) as SessionData;
        const last = data.messages.at(-1);
        const firstUser = data.messages.find((m) => m.role === "user");
        metas.push({
          id: data.id,
          messageCount: data.messages.length,
          updatedAt: last?.createdAt ?? 0,
          preview: last?.content.slice(0, 40) ?? "(空会话)",
          title: data.title ?? firstUser?.content.replace(/\s+/g, " ").slice(0, 40) ?? "(空会话)",
          epoch: data.epoch ?? 0,
        });
      } catch {
        // 单个损坏的会话文件不影响整体列表
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}

/**
 * 按用户输入查找会话，支持三种方式：
 * - 纯数字: 按列表序号（1 = 最新）
 * - 关键词: 标题包含（大小写不敏感）
 * - 会话 id: 精确或前缀匹配（向后兼容）
 * 返回所有匹配项；无匹配返回空数组。
 */
export function findSessions(
  metas: readonly SessionMeta[],
  query: string,
): SessionMeta[] {
  const trimmed = query.trim();
  if (trimmed === "") return [];

  // 1. 序号选择
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    const meta = metas[index];
    return meta === undefined ? [] : [meta];
  }

  const lower = trimmed.toLowerCase();
  const matches = new Map<string, SessionMeta>();

  // 2. id 精确/前缀匹配（兼容旧用法）
  for (const meta of metas) {
    if (meta.id === trimmed || meta.id.startsWith(trimmed)) {
      matches.set(meta.id, meta);
    }
  }

  // 3. 标题关键词匹配
  for (const meta of metas) {
    if (meta.title.toLowerCase().includes(lower)) {
      matches.set(meta.id, meta);
    }
  }

  return [...matches.values()];
}

/** 防路径穿越：会话 id 只允许字母数字下划线 */
function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
