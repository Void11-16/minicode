import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: number;
}

export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/**
 * 本地账号与会话。
 * 密码只保存 scrypt 派生值；登录 Cookie 只保存随机 token，数据库里保存其 SHA-256。
 */
export class AuthStore {
  private readonly database: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_id ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expires_at ON auth_sessions(expires_at);
    `);
  }

  async register(input: {
    email: unknown;
    password: unknown;
    displayName?: unknown;
  }): Promise<AuthUser> {
    const email = requireEmail(input.email);
    const password = requirePassword(input.password);
    const displayName = normalizeDisplayName(input.displayName, email);
    const existing = this.database.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
    if (existing !== undefined) throw new AuthError(409, "该邮箱已经注册，请直接登录");

    const user: AuthUser = {
      id: `usr_${randomUUID()}`,
      email,
      displayName,
      createdAt: Date.now(),
    };
    const passwordHash = await hashPassword(password);
    try {
      this.database
        .prepare(
          "INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(user.id, user.email, user.displayName, passwordHash, user.createdAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.email")) {
        throw new AuthError(409, "该邮箱已经注册，请直接登录");
      }
      throw error;
    }
    return user;
  }

  async authenticate(emailInput: unknown, passwordInput: unknown): Promise<AuthUser> {
    const email = requireEmail(emailInput);
    const password = requirePassword(passwordInput);
    const row = this.database
      .prepare("SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = ?")
      .get(email) as
      | {
          id: string;
          email: string;
          display_name: string;
          password_hash: string;
          created_at: number;
        }
      | undefined;
    if (row === undefined || !(await verifyPassword(password, row.password_hash))) {
      throw new AuthError(401, "邮箱或密码不正确");
    }
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
    this.database
      .prepare(
        "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hashToken(token), userId, now, now + SESSION_TTL_MS);
    return token;
  }

  userForToken(token: string): AuthUser | null {
    if (token === "") return null;
    const row = this.database
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.created_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), Date.now()) as
      | { id: string; email: string; display_name: string; created_at: number }
      | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  }

  revokeSession(token: string): void {
    if (token === "") return;
    this.database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
  }

  close(): void {
    this.database.close();
  }
}

export function parseCookie(header: string | undefined, name: string): string {
  if (header === undefined) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export function authCookie(token: string): string {
  return `minicode_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedAuthCookie(): string {
  return "minicode_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requireEmail(value: unknown): string {
  const email = normalizeEmail(value);
  if (email === "" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError(400, "请输入有效的邮箱地址");
  }
  return email;
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8) {
    throw new AuthError(400, "密码至少需要 8 个字符");
  }
  if (value.length > 128) throw new AuthError(400, "密码不能超过 128 个字符");
  return value;
}

function normalizeDisplayName(value: unknown, email: string): string {
  const fallback = email.split("@")[0]?.replace(/[._-]+/g, " ").trim().slice(0, 40) || "旅行者";
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new AuthError(400, "称呼格式不正确");
  const name = value.replace(/\s+/g, " ").trim().slice(0, 40);
  return name === "" ? fallback : name;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltHex, hashHex] = encoded.split("$");
  if (algorithm !== "scrypt" || saltHex === undefined || hashHex === undefined) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== PASSWORD_BYTES) return false;
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(actual, expected);
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
