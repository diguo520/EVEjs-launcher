import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { resolveRepoRoot } from "./envDetector";
import { getServices } from "./processManager";

interface DatabaseOverview {
  ok: boolean;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  tables: Array<{ name: string; rows: number; columns: number; indexes: number; sizeBytes: number | null }>;
  tableCount: number;
  totalRows: number;
  pageCount: number;
  pageSize: number;
  journalMode: string;
  reason?: string;
}

interface DatabaseTableResult {
  ok: boolean;
  table?: string;
  columns?: Array<{ name: string; type: string; pk: number; notnull: number }>;
  primaryKeys?: Array<{ name: string; type: string; pk: number }>;
  rows?: Array<Record<string, unknown>>;
  total?: number;
  limit?: number;
  offset?: number;
  reason?: string;
}

interface DatabaseBackupResult {
  ok: boolean;
  name?: string;
  path?: string;
  sizeBytes?: number;
  createdAt?: number;
  directory?: string;
  reason?: string;
}

interface DatabaseBackupListResult {
  ok: boolean;
  directory?: string;
  backups?: Array<{ name: string; path: string; sizeBytes: number; createdAt: number }>;
  reason?: string;
}

function cliPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "database-cli.js");
  return path.join(__dirname, "..", "..", "..", "scripts", "database-cli.js");
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const script = cliPath();
    if (!fs.existsSync(script)) {
      resolve({ stdout: "", stderr: `database-cli.js 不存在: ${script}`, code: -1 });
      return;
    }
    execFile("node", [script, ...args], {
      cwd: resolveRepoRoot(),
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : -1) : 0 });
    });
  });
}

function activeServices(): string[] {
  return getServices()
    .filter((service) => service.state !== "idle" && service.state !== "error")
    .map((service) => service.name || service.id);
}

function parseResult<T>(stdout: string, stderr: string, code: number | null): T | { ok: false; reason: string } {
  if (code !== 0) return { ok: false, reason: (stderr || stdout || "数据库操作失败").trim() };
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch (error) {
    return { ok: false, reason: "数据库返回数据解析失败: " + (error instanceof Error ? error.message : String(error)) };
  }
}

export async function databaseOverview(): Promise<DatabaseOverview | { ok: false; reason: string }> {
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["overview", root]);
  return parseResult<DatabaseOverview>(stdout, stderr, code);
}

export async function databaseTable(table: string, limit = 100, offset = 0): Promise<DatabaseTableResult | { ok: false; reason: string }> {
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["table", root, table, String(limit), String(offset)]);
  return parseResult<DatabaseTableResult>(stdout, stderr, code);
}

export async function databaseCreateBackup(): Promise<DatabaseBackupResult> {
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["backup", root, "gamestore"]);
  return parseResult<DatabaseBackupResult>(stdout, stderr, code) as DatabaseBackupResult;
}

export async function databaseBackups(): Promise<DatabaseBackupListResult> {
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["backups", root]);
  return parseResult<DatabaseBackupListResult>(stdout, stderr, code) as DatabaseBackupListResult;
}

export async function databaseRestoreBackup(name: string): Promise<{ ok: boolean; reason?: string; restored?: string; safetyBackup?: string }> {
  const blocked = writeBlocked();
  if (blocked) return { ok: false, reason: blocked };
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["restore", root, name, "--apply"]);
  return parseResult<{ ok: boolean; reason?: string; restored?: string; safetyBackup?: string }>(stdout, stderr, code);
}

function writeBlocked(): string | null {
  const active = activeServices();
  return active.length ? `请先停止服务：${active.join("、")}` : null;
}

export async function databaseSaveRow(table: string, values: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const blocked = writeBlocked();
  if (blocked) return { ok: false, reason: blocked };
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["save", root, table, JSON.stringify(values || {})]);
  return parseResult<{ ok: boolean; reason?: string }>(stdout, stderr, code);
}

export async function databaseInsertRow(table: string, values: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const blocked = writeBlocked();
  if (blocked) return { ok: false, reason: blocked };
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["insert", root, table, JSON.stringify(values || {})]);
  return parseResult<{ ok: boolean; reason?: string }>(stdout, stderr, code);
}

export async function databaseDeleteRow(table: string, values: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
  const blocked = writeBlocked();
  if (blocked) return { ok: false, reason: blocked };
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["delete", root, table, JSON.stringify(values || {}), "--apply"]);
  return parseResult<{ ok: boolean; reason?: string }>(stdout, stderr, code);
}
