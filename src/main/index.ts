import { app, BrowserWindow, shell, session } from "electron";
import * as fs from "fs";
import * as path from "path";
import { registerIpc, pushTerminalLine } from "./ipc";
import { initLogger, log } from "./logger";
import { resolveRepoRoot } from "./envDetector";
import * as pty from "./ptyManager";
import { getServices, onServicesChanged, onProgress, cleanupAll } from "./processManager";

app.commandLine.appendSwitch("disable-spell-checking");
const userDataOverride = process.env.EVEJS_USER_DATA_DIR;
if (userDataOverride) {
  app.setPath("userData", path.resolve(userDataOverride));
}

const APP_VERSION = app.getVersion();
const isSmokeTest = process.argv.includes("--smoke-test");
const isServiceSmoke = process.argv.includes("--service-smoke");
const isEngageSmoke = process.argv.includes("--engage-smoke");
const isUpdateSmoke = process.argv.includes("--update-smoke");

let mainWindow: BrowserWindow | null = null;

function broadcastToWindow(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: "#0b0e14",
    title: "EvEJS 启动器",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl.replace(/\/$/, "") + "/eve-launcher.html");
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../renderer/eve-launcher.html"));
  }

  // 主进程 → 渲染层：启动横幅（演示 xterm 数据流）
  mainWindow.webContents.once("did-finish-load", () => {
    const root = resolveRepoRoot();
    setTimeout(() => {
      pushTerminalLine(
        "system",
        "\r\n\x1b[36m[启动器] EvEJS Launcher v" + APP_VERSION + "\x1b[0m 仓库: " + root + "\r\n"
      );
      pushTerminalLine("system", "\x1b[90m[启动器] Phase 3-4 已接入 · ENGAGE 一键启动 / 停止全部 · 服务页签实时日志\x1b[0m\r\n");
    }, 400);
  });

  // 服务状态变更 → 渲染层；进度日志 → system 页签
  onServicesChanged((list) => broadcastToWindow("services:changed", list));
  onProgress((line) => pushTerminalLine("system", line + "\r\n"));

  if (isServiceSmoke) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const shotDir = path.resolve(__dirname, "../../../docs");
        fs.mkdirSync(shotDir, { recursive: true });
        const waitForState = async (state: string, timeoutMs: number) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const info = getServices().find((item) => item.id === "mainServer");
            if (info?.state === state) return true;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          return false;
        };
        try {
          await mainWindow?.webContents.executeJavaScript(`document.querySelector('#svcCards .svc-card[data-key="node"] .mini-btn.start')?.click()`);
          const started = await waitForState("running", 90000);
          console.log("[SERVICE-SMOKE] start via UI:", started);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const runningShot = await mainWindow?.webContents.capturePage();
          if (runningShot) fs.writeFileSync(path.join(shotDir, "ui-service-start.png"), runningShot.toPNG());
          await mainWindow?.webContents.executeJavaScript(`document.querySelector('#svcCards .svc-card[data-key="node"] .mini-btn.stop')?.click()`);
          const stopped = await waitForState("idle", 30000);
          console.log("[SERVICE-SMOKE] stop via UI:", stopped);
          await new Promise((resolve) => setTimeout(resolve, 800));
          const stoppedShot = await mainWindow?.webContents.capturePage();
          if (stoppedShot) fs.writeFileSync(path.join(shotDir, "ui-service-stop.png"), stoppedShot.toPNG());
          app.exit(started && stopped ? 0 : 1);
        } catch (error) {
          console.error("[SERVICE-SMOKE] error:", error);
          app.exit(1);
        }
      }, 1500);
    });
  }

  if (isEngageSmoke) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const shotDir = path.resolve(__dirname, "../../../docs");
        fs.mkdirSync(shotDir, { recursive: true });
        const waitForStates = async (states: Record<string, string>, timeoutMs: number) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const services = getServices();
            const ok = Object.entries(states).every(([id, state]) => services.find((item) => item.id === id)?.state === state);
            if (ok) return true;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          return false;
        };
        try {
          await mainWindow?.webContents.executeJavaScript(`document.getElementById('launchAll')?.click()`);
          const started = await waitForStates({ mainServer: "running", marketServer: "running", client: "idle" }, 120000);
          console.log("[ENGAGE-SMOKE] start main+market only:", started);
          const runningShot = await mainWindow?.webContents.capturePage();
          if (runningShot) fs.writeFileSync(path.join(shotDir, "ui-engage-start.png"), runningShot.toPNG());
          await mainWindow?.webContents.executeJavaScript(`document.getElementById('launchAll')?.click()`);
          const stopped = await waitForStates({ mainServer: "idle", marketServer: "idle", client: "idle" }, 60000);
          console.log("[ENGAGE-SMOKE] stop:", stopped);
          const stoppedShot = await mainWindow?.webContents.capturePage();
          if (stoppedShot) fs.writeFileSync(path.join(shotDir, "ui-engage-stop.png"), stoppedShot.toPNG());
          app.exit(started && stopped ? 0 : 1);
        } catch (error) {
          console.error("[ENGAGE-SMOKE] error:", error);
          app.exit(1);
        }
      }, 1800);
    });
  }

  if (isUpdateSmoke) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow?.webContents.executeJavaScript(`window.api.updateDownload()`);
          console.log("[UPDATE-SMOKE] download:", JSON.stringify(result));
          app.exit(result?.ok ? 0 : 1);
        } catch (error) {
          console.error("[UPDATE-SMOKE] error:", error);
          app.exit(1);
        }
      }, 2000);
    });
  }

  if (isSmokeTest) {
    mainWindow.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) console.log("[SMOKE][console]", message);
    });
    mainWindow.webContents.once("did-finish-load", () => {
      console.log("[SMOKE] window loaded OK, repoRoot =", resolveRepoRoot());
      setTimeout(async () => {
        try {
          const state = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const q = (s) => document.querySelectorAll(s).length;
            const envReport = await window.api.envCheck();
            const updateReport = await window.api.updateCheck();
            if (typeof checkUpdate === "function") await checkUpdate();
            await new Promise((r) => setTimeout(r, 250));
            await new Promise((r) => setTimeout(r, 150));
            return JSON.stringify({
              navItems: q(".nav-item"),
              svcCards: q("#svcCards .svc-card"),
              svcChips: q("#svcStrip .svc-chip"),
              envCards: q("#checkList .check-card"),
              hasApi: typeof window.api === "object",
              hasBridge: typeof window.__eveBridge === "object",
              consoleLines: q("#dashConsole .log-line"),
              consoleReadOnly: !!document.getElementById("cmdInput")?.readOnly,
              fullTabCount: q("#fullTabs .tab"),
              serverLogCount: document.getElementById("cntServer")?.textContent ?? "",
              ansiSpans: q("#dashConsole .msg span[class^='ansi-']"),
              serverColorSpans: q("#fullConsole .msg span"),
              ipSpans: q("#dashConsole .msg .ip") + q("#fullConsole .msg .ip"),
              portSpans: q("#dashConsole .msg .port") + q("#fullConsole .msg .port"),
              exitSpans: q("#dashConsole .msg .exit-code") + q("#fullConsole .msg .exit-code"),
              clientStartButtons: q('#svcCards .svc-card[data-key="client"] .mini-btn.start'),
              statusBar: document.querySelector(".statusbar")?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
              envSummary: document.getElementById("envPct")?.textContent ?? "",
              envApiPass: envReport.passCount + "/" + envReport.totalCount,
              envClientPathOk: envReport.checks.find((item) => item.key === "clientPath")?.ok ?? null,
              envClientPathMessage: envReport.checks.find((item) => item.key === "clientPath")?.message ?? "",
              updateOk: updateReport.ok,
              updateAvailable: updateReport.available,
              updateLatestVersion: updateReport.latestVersion ?? "",
              updateReason: updateReport.reason ?? "",
              updateModalOpen: !!document.getElementById("updateModal")?.classList.contains("open"),
              updateModalTitle: document.getElementById("updTitle")?.textContent?.trim() ?? ""
            });
          })()`);
          console.log("[SMOKE] renderer-state:", state);
        } catch (e) {
          console.log("[SMOKE] renderer-state ERROR:", e);
        }
        try {
          const image = await mainWindow?.webContents.capturePage();
          if (image) {
            const shotDir = path.resolve(__dirname, "../../../docs");
            fs.mkdirSync(shotDir, { recursive: true });
            const shot = path.join(shotDir, "ui-preview.png");
            fs.writeFileSync(shot, image.toPNG());
            console.log("[SMOKE] screenshot saved:", shot);
            const updateShot = path.join(shotDir, "ui-update.png");
            fs.writeFileSync(updateShot, image.toPNG());
          }
        } catch (e) {
          console.log("[SMOKE] screenshot ERROR:", e);
        }
        // 数据视图探针：切换到指令手册并加载物品 JSON。
        try {
          const dataState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            if (typeof goView === "function") goView("commands");
            const rowCount = () => document.querySelectorAll("#cmdTable tr").length;
            switchContent("commands", "none", "none");
            const noneRows = rowCount();
            switchContent("commands", "dock", "dock");
            const dockRows = rowCount();
            switchContent("commands", "space", "space");
            const spaceRows = rowCount();
            switchContent("commands", "gm", "gm");
            const gmRows = rowCount();
            const activeFilter = document.querySelector("#cmdStats .cmd-stat.active .l")?.textContent?.trim() ?? "";
            switchContent("item");
            await new Promise((r) => setTimeout(r, 2200));
            return JSON.stringify({
              noneRows,
              dockRows,
              spaceRows,
              gmRows,
              activeFilter,
              items: typeof ITEMS_MAP !== "undefined" && ITEMS_MAP ? Object.keys(ITEMS_MAP).length : 0,
              templates: typeof TEMPLATES_DATA !== "undefined" && TEMPLATES_DATA ? TEMPLATES_DATA.length : 0,
              npcs: typeof NPCS_DATA !== "undefined" && NPCS_DATA ? NPCS_DATA.length : 0,
              qa: typeof QA_DATA !== "undefined" && QA_DATA ? QA_DATA.length : 0
            });
          })()`);
          console.log("[SMOKE] data-state:", dataState);
        } catch (e) {
          console.log("[SMOKE] data-state ERROR:", e);
        }

        // 账号面板探针：点击「账号」导航 → 等待加载 → 检查列表/头像 → 截图
        try {
          const accState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const item = document.querySelector('.nav-item[data-view="accounts"]');
            if (!item) return JSON.stringify({ opened: false, reason: "no nav item" });
            item.click();
            await new Promise((r) => setTimeout(r, 2500));
            const acc = await window.api.accountsList();
            return JSON.stringify({
              opened: !!document.querySelector("#view-accounts.active"),
              cards: document.querySelectorAll("#accTable .acc-block").length,
              names: [...document.querySelectorAll("#accTable .ac-name")].map((el) => el.textContent?.replace(/\\s+/g, " ").trim()).slice(0, 8),
              gmLinks: [...document.querySelectorAll("#accTable .gm-tag")].map((el) => el.textContent?.trim()),
              listOk: acc.ok,
              apiAccounts: acc.ok && acc.data ? acc.data.map((a) => a.accountKey + ":" + (a.roles[0]?.characterName ?? "?")) : []
            });
          })()`);
          console.log("[SMOKE] accounts-state:", accState);
          const image2 = await mainWindow?.webContents.capturePage();
          if (image2) {
            const shotDir = path.resolve(__dirname, "../../../docs");
            const shot = path.join(shotDir, "ui-accounts.png");
            fs.writeFileSync(shot, image2.toPNG());
            console.log("[SMOKE] accounts screenshot saved:", shot);
          }
        } catch (e) {
          console.log("[SMOKE] accounts-state ERROR:", e);
        }
        console.log("[SMOKE] quit");
        app.exit(0);
      }, 2800);
    });
  }
}

// PTY 数据 → 渲染层终端
pty.setCallbacks(
  (tabId, data) => broadcastToWindow("terminal:data", tabId, data),
  (tabId, exitCode) => broadcastToWindow("terminal:exit", tabId, exitCode)
);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    initLogger();
    log("launcher", `EvEJS 启动器 v${APP_VERSION} 启动（smoke=${isSmokeTest}）`);
    try {
      session.defaultSession.setSpellCheckerLanguages([]);
    } catch { /* spellcheck disabled */ }
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    // 仅清理本启动器拉起的服务进程
    cleanupAll();
  });
}
