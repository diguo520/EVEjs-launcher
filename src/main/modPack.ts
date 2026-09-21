import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * 模组打包：把一个模组目录压成 ZIP，并算好 sha256 / sizeBytes。
 *
 * 用 .NET 的 ZipFile 而不是 Compress-Archive：部分 PowerShell 版本的
 * Compress-Archive 会用反斜杠当 ZIP 内的路径分隔符，别的工具解压就出错。
 */

function psQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export interface PackResult {
  ok: boolean;
  zipPath?: string;
  sha256?: string;
  sizeBytes?: number;
  reason?: string;
}

/** 目录 → ZIP（ZIP 内根就是模组根，不含外层目录） */
export async function packModZip(sourceDir: string, destZip: string): Promise<PackResult> {
  if (!fs.existsSync(sourceDir)) return { ok: false, reason: "源目录不存在：" + sourceDir };
  try {
    const stat = fs.statSync(sourceDir);
    if (!stat.isDirectory()) return { ok: false, reason: "源路径不是目录：" + sourceDir };
  } catch (e) {
    return { ok: false, reason: "读不到源目录：" + (e instanceof Error ? e.message : String(e)) };
  }

  try {
    fs.mkdirSync(path.dirname(destZip), { recursive: true });
    if (fs.existsSync(destZip)) fs.rmSync(destZip, { force: true });
  } catch (e) {
    return { ok: false, reason: "准备目标文件失败：" + (e instanceof Error ? e.message : String(e)) };
  }

  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::CreateFromDirectory(" +
      psQuote(sourceDir) +
      ", " +
      psQuote(destZip) +
      ", [System.IO.Compression.CompressionLevel]::Optimal, $false)"
  ].join("; ");

  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 120000 });
  } catch (e) {
    return { ok: false, reason: "打包失败：" + (e instanceof Error ? e.message : String(e)) };
  }

  if (!fs.existsSync(destZip)) return { ok: false, reason: "打包命令执行完了但没生成 ZIP" };

  const hashed = sha256File(destZip);
  if (!hashed.ok || !hashed.sha256) return { ok: false, reason: hashed.reason || "计算 sha256 失败" };
  return { ok: true, zipPath: destZip, sha256: hashed.sha256, sizeBytes: hashed.sizeBytes };
}

/** 文件的 sha256 与体积 */
export function sha256File(file: string): { ok: boolean; sha256?: string; sizeBytes?: number; reason?: string } {
  try {
    const buf = fs.readFileSync(file);
    return { ok: true, sha256: crypto.createHash("sha256").update(buf).digest("hex"), sizeBytes: buf.length };
  } catch (e) {
    return { ok: false, reason: "读取文件失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}