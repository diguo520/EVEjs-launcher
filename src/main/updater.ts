import { app, BrowserWindow, net } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { getServices } from "./processManager";
import { readSettings } from "./configStore";
import { launcherTempDir } from "./runtimePaths";

export interface UpdateAsset {
  type: string;
  url: string;
  sha256: string;
  size?: number;
  signature?: string;
}

export interface UpdateManifest {
  schemaVersion: number;
  channel: string;
  version: string;
  minimumVersion?: string;
  publishedAt?: string;
  releaseNotesUrl?: string;
  changelog?: Array<{ type: string; text: string }>;
  platforms: Record<string, UpdateAsset>;
}

export interface UpdateState {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "applying" | "error";
  currentVersion: string;
  latestVersion?: string;
  channel?: string;
  size?: number;
  downloaded?: number;
  percent?: number;
  speed?: number;
  message?: string;
}

export interface UpdateCheckResult {
  ok: boolean;
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  size?: number;
  date?: string;
  channel?: string;
  changelog?: Array<{ type: string; text: string }>;
  manifestUrl?: string;
  targetPath?: string;
  reason?: string;
}

const DEFAULT_UPDATE_MANIFEST_URL = "https://github.com/diguo520/EVEjs-launcher/releases/latest/download/update-manifest.json";
let manifestUrl = "";
let manifest: UpdateManifest | null = null;
let asset: UpdateAsset | null = null;
let downloadedPath = "";
let activeDownload: AbortController | null = null;
let state: UpdateState = { state: "idle", currentVersion: app.getVersion() };

function emit(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("update:changed", state);
  }
}

export function currentUpdateState(): UpdateState { return { ...state }; }

function targetPath(): string {
  if (process.env.EVEJS_UPDATE_TARGET_PATH) return process.env.EVEJS_UPDATE_TARGET_PATH;
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function configBaseDir(): string {
  return process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath("exe")) : process.cwd());
}

function parseJson<T>(text: string): T {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
}

function resolveManifestUrl(): string {
  if (process.env.EVEJS_UPDATE_MANIFEST_URL) return process.env.EVEJS_UPDATE_MANIFEST_URL.trim();
  const settings = readSettings();
  if (typeof settings.updateManifestUrl === "string" && settings.updateManifestUrl.trim()) return settings.updateManifestUrl.trim();
  try {
    const config = parseJson<Record<string, unknown>>(fs.readFileSync(path.join(configBaseDir(), "launcher.config.json"), "utf8"));
    if (typeof config.updateManifestUrl === "string" && config.updateManifestUrl.trim()) return config.updateManifestUrl.trim();
  } catch { /* ignore */ }
  return DEFAULT_UPDATE_MANIFEST_URL;
}

async function readManifest(url: string): Promise<UpdateManifest> {
  if (url.startsWith("file://")) return parseJson<UpdateManifest>(fs.readFileSync(new URL(url), "utf8"));
  if (path.isAbsolute(url) && fs.existsSync(url)) return parseJson<UpdateManifest>(fs.readFileSync(url, "utf8"));
  const response = await net.fetch(url, { headers: { "User-Agent": `EvEJS-Launcher/${app.getVersion()}` } });
  if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}`);
  return (await response.json()) as UpdateManifest;
}
function parseVersion(value: string): number[] {
  return String(value || "0.0.0").replace(/^v/i, "").split(".").map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ""), 10) || 0);
}

function compareVersion(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function platformAsset(value: UpdateManifest): UpdateAsset | null {
  const key = `${process.platform}-${process.arch}`;
  return value.platforms?.[key] || (process.platform === "win32" ? value.platforms?.["win32-x64"] : null) || null;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  emit({ state: "checking", currentVersion, message: "正在检查更新…" });
  manifestUrl = resolveManifestUrl();
  if (!manifestUrl) {
    const reason = "未配置 updateManifestUrl";
    emit({ state: "error", currentVersion, message: reason });
    return { ok: false, available: false, currentVersion, reason };
  }
  try {
    const remote = await readManifest(manifestUrl);
    const nextAsset = platformAsset(remote);
    if (!nextAsset) throw new Error("更新清单中没有当前平台");
    if (remote.minimumVersion && compareVersion(currentVersion, remote.minimumVersion) < 0) throw new Error(`当前版本过低，最低要求 ${remote.minimumVersion}`);
    const available = compareVersion(remote.version, currentVersion) > 0;
    manifest = remote;
    asset = nextAsset;
    emit({
      state: available ? "available" : "idle",
      currentVersion,
      latestVersion: remote.version,
      channel: remote.channel,
      size: nextAsset.size,
      message: available ? "发现新版本" : "已是最新版本"
    });
    return {
      ok: true,
      available,
      currentVersion,
      latestVersion: remote.version,
      size: nextAsset.size,
      date: remote.publishedAt,
      channel: remote.channel,
      changelog: remote.changelog || [],
      manifestUrl,
      targetPath: targetPath()
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit({ state: "error", currentVersion, message: reason });
    return { ok: false, available: false, currentVersion, reason };
  }
}
function tempUpdateDir(version: string): string {
  return path.join(app.getPath("temp"), "EveJS-Launcher-Updater", version);
}

async function downloadToFile(url: string, destination: string, expectedSize: number | undefined): Promise<string> {
  const hash = crypto.createHash("sha256");
  const output = fs.createWriteStream(destination);
  let downloaded = 0;
  const startedAt = Date.now();
  const writeChunk = async (chunk: Uint8Array) => {
    if (!output.write(Buffer.from(chunk))) await new Promise<void>((resolve) => output.once("drain", () => resolve()));
    downloaded += chunk.byteLength;
    hash.update(chunk);
    const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000);
    const total = expectedSize || downloaded;
    emit({
      state: "downloading",
      downloaded,
      size: expectedSize,
      percent: total > 0 ? Math.min(100, downloaded / total * 100) : 0,
      speed: downloaded / elapsed,
      message: "正在下载更新…"
    });
  };

  try {
    if (path.isAbsolute(url) && fs.existsSync(url)) {
      for await (const chunk of fs.createReadStream(url)) await writeChunk(chunk as Buffer);
    } else if (url.startsWith("file://")) {
      for await (const chunk of fs.createReadStream(new URL(url))) await writeChunk(chunk as Buffer);
    } else {
      activeDownload = new AbortController();
      const response = await net.fetch(url, { signal: activeDownload.signal, headers: { "User-Agent": `EvEJS-Launcher/${app.getVersion()}` } });
      if (!response.ok || !response.body) throw new Error(`下载更新失败: HTTP ${response.status}`);
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await writeChunk(value);
      }
    }
    await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
    return hash.digest("hex");
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(destination); } catch { /* ignore */ }
    throw error;
  } finally {
    activeDownload = null;
  }
}

export async function downloadUpdate(): Promise<{ ok: boolean; path?: string; reason?: string }> {
  if (!manifest || !asset) {
    const checked = await checkForUpdates();
    if (!checked.ok || !checked.available) return { ok: false, reason: checked.reason || "没有可用更新" };
  }
  const currentManifest = manifest as UpdateManifest;
  const currentAsset = asset as UpdateAsset;
  try {
    const directory = tempUpdateDir(currentManifest.version);
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `launcher-${currentManifest.version}.exe`);
    const digest = await downloadToFile(currentAsset.url, destination, currentAsset.size);
    const expected = String(currentAsset.sha256 || "").toLowerCase();
    if (expected && digest.toLowerCase() !== expected) {
      fs.unlinkSync(destination);
      throw new Error("更新包 SHA256 校验失败");
    }
    downloadedPath = destination;
    emit({ state: "ready", downloaded: currentAsset.size || fs.statSync(destination).size, percent: 100, message: "更新已下载完成" });
    return { ok: true, path: destination };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit({ state: "error", message: reason });
    return { ok: false, reason };
  }
}
function updaterHelperPath(): string {
  const packaged = path.join(process.resourcesPath, "evejs-updater.exe");
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, "../../../updater/bin/evejs-updater.exe");
}

export async function applyUpdate(): Promise<{ ok: boolean; reason?: string }> {
  if (!downloadedPath || !fs.existsSync(downloadedPath)) return { ok: false, reason: "尚未下载更新包" };
  if (!app.isPackaged && !process.env.EVEJS_UPDATE_TARGET_PATH) {
    return { ok: false, reason: "开发模式不支持自动替换，请使用打包后的便携版测试更新" };
  }
  const active = getServices().filter((service) => service.state !== "idle" && service.state !== "error");
  if (active.length > 0) return { ok: false, reason: "请先停止主服务器和市场服务" };
  const helper = updaterHelperPath();
  if (!fs.existsSync(helper)) return { ok: false, reason: "更新器不存在" };
  try {
    const tempRoot = launcherTempDir();
    const tempDir = path.join(tempRoot, "EveJS-Launcher-Updater", manifest?.version || "current");
    fs.mkdirSync(tempDir, { recursive: true });
    const helperCopy = path.join(tempDir, "evejs-updater.exe");
    fs.copyFileSync(helper, helperCopy);
    const args = [
      "--target", targetPath(),
      "--source", downloadedPath,
      "--pid", String(process.pid),
      "--parent-pid", String(process.ppid),
      "--from", app.getVersion(),
      "--to", manifest?.version || "",
      "--restart"
    ];
    const child = spawn(helperCopy, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot }
    });
    child.unref();
    emit({ state: "applying", message: "正在安装更新…" });
    setTimeout(() => app.quit(), 500);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit({ state: "error", message: reason });
    return { ok: false, reason };
  }
}

export function cancelUpdateDownload(): void {
  activeDownload?.abort();
  activeDownload = null;
  emit({ state: "idle", message: "已取消下载" });
}
