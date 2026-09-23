import { app, BrowserWindow, shell, session, screen } from "electron";
import * as fs from "fs";
import * as path from "path";
import { registerIpc, pushTerminalLine } from "./ipc";
import { initLogger, log } from "./logger";
import { resolveRepoRoot } from "./envDetector";
import { readSettings, writeSettings } from "./configStore";
import { ensureLauncherRuntimePaths } from "./runtimePaths";
import { ensureModAuthoringDoc, ensureAllModAuthoringDocs } from "./modManager";
import { listMyMods, prepareSubmission } from "./modSubmit";
import { createMod } from "./modScaffold";
import { getAuthor, readAuthorPrivateKey } from "./authorStore";
import { signManifest } from "./modSigner";
import * as pty from "./ptyManager";
import { getServices, onServicesChanged, onProgress, onOutput, cleanupAll } from "./processManager";

app.commandLine.appendSwitch("disable-spell-checking");
const runtimePaths = ensureLauncherRuntimePaths();
app.setPath("userData", runtimePaths.userData);
app.setPath("sessionData", runtimePaths.sessionData);
app.setPath("cache", runtimePaths.cache);
app.setPath("temp", runtimePaths.temp);
app.setPath("logs", runtimePaths.logs);
app.setPath("crashDumps", runtimePaths.crashDumps);

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
  const savedWindow = readSettings().windowBounds as {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    maximized?: boolean;
  } | undefined;
  const defaultBounds = { width: 1280, height: 800 };
  const savedWidth = Number(savedWindow?.width);
  const savedHeight = Number(savedWindow?.height);
  const hasSavedSize = Number.isFinite(savedWidth) && savedWidth >= 1024 && Number.isFinite(savedHeight) && savedHeight >= 640;
  const candidate = {
    x: Number(savedWindow?.x),
    y: Number(savedWindow?.y),
    width: hasSavedSize ? savedWidth : defaultBounds.width,
    height: hasSavedSize ? savedHeight : defaultBounds.height
  };
  const hasSavedPosition = Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
  let restoredBounds: { x?: number; y?: number; width: number; height: number } = {
    width: candidate.width,
    height: candidate.height
  };
  if (hasSavedPosition) {
    try {
      const workArea = screen.getDisplayMatching(candidate).workArea;
      const visible = candidate.x < workArea.x + workArea.width - 100 &&
        candidate.x + candidate.width > workArea.x + 100 &&
        candidate.y < workArea.y + workArea.height - 100 &&
        candidate.y + candidate.height > workArea.y + 100;
      if (visible) restoredBounds = candidate;
    } catch {
      /* fall back to default position */
    }
  }

  mainWindow = new BrowserWindow({
    ...restoredBounds,
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

  const saveWindowBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getNormalBounds();
    writeSettings({
      windowBounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: mainWindow.isMaximized()
      }
    });
  };
  let boundsTimer: NodeJS.Timeout | null = null;
  const scheduleBoundsSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveWindowBounds, 400);
  };
  mainWindow.on("resize", scheduleBoundsSave);
  mainWindow.on("move", scheduleBoundsSave);
  mainWindow.on("maximize", scheduleBoundsSave);
  mainWindow.on("unmaximize", scheduleBoundsSave);
  mainWindow.on("close", saveWindowBounds);

  mainWindow.once("ready-to-show", () => {
    if (savedWindow?.maximized) mainWindow?.maximize();
    mainWindow?.show();
  });
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
  onOutput((tabId, data) => broadcastToWindow("terminal:data", tabId, data));

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
              updateModalTitle: document.getElementById("updTitle")?.textContent?.trim() ?? "",
              updateChangelogRows: [...document.querySelectorAll("#updBody .upd-changelog li")].map((item) => item.textContent?.replace(/\\s+/g, " ").trim()),
              updateChangelogFirst: document.querySelector("#updBody .upd-changelog li")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""
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
            const firstAccount = acc.ok && acc.data ? acc.data[0] : null;
            const firstCharacter = firstAccount && firstAccount.roles ? firstAccount.roles[0] : null;
            if (firstAccount && firstCharacter && typeof launchChar === "function") {
              launchChar(firstAccount.accountKey, firstCharacter.characterName);
            }
            const launchModalOpen = !!document.getElementById("launchCharacterModal")?.classList.contains("open");
            closeModal("launchCharacterModal");
            const sponsor = document.querySelector(".admin");
            const sponsorCard = document.querySelector(".admin-card");
            return JSON.stringify({
              opened: !!document.querySelector("#view-accounts.active"),
              addAccountModal: !!document.getElementById("addAccountModal"),
              addAccountApi: typeof window.api.accountsCreate === "function",
              launchModal: !!document.getElementById("launchCharacterModal"),
              launchModalOpen,
              launchApi: typeof window.api.loginStart === "function",
              sponsorPopover: !!document.querySelector(".sponsor-pop img"),
              sponsorParentClipped: sponsor ? getComputedStyle(sponsor).clipPath !== "none" : null,
              sponsorCardClipped: sponsorCard ? getComputedStyle(sponsorCard).clipPath !== "none" : null,
              metrics: await (async () => { await new Promise((r) => setTimeout(r, 2500)); return window.api.metricsGet(); })(),
              cards: document.querySelectorAll("#accTable .acc-block").length,
              names: [...document.querySelectorAll("#accTable .ac-name")].map((el) => el.textContent?.replace(/\\s+/g, " ").trim()).slice(0, 8),
              gmLinks: [...document.querySelectorAll("#accTable .gm-tag")].map((el) => el.textContent?.trim()),
              listOk: acc.ok,
              apiAccounts: acc.ok && acc.data ? acc.data.map((a) => a.accountKey + ":" + (a.roles[0]?.characterName ?? "?")) : [],
              firstRole: acc.ok && acc.data?.[0]?.roles?.[0] ? {
                isk: acc.data[0].roles[0].isk,
                skillPoints: acc.data[0].roles[0].skillPoints,
                shipName: acc.data[0].roles[0].shipName,
                location: acc.data[0].roles[0].location?.label,
                securityStatus: acc.data[0].roles[0].securityStatus,
                hasAvatar: !!acc.data[0].roles[0].avatar
              } : null
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

        // 数据库管理探针：真实表清单、统计和分页行读取。
        try {
          const dbState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const item = document.querySelector('.nav-item[data-view="database"]');
            if (!item) return JSON.stringify({ opened: false, reason: "no nav item" });
            item.click();
            if (typeof closeModal === "function") closeModal("updateModal");
            await new Promise((r) => setTimeout(r, 1500));
            const overview = await window.api.databaseOverview();
            const table = await window.api.databaseTable("accounts", 2, 0);
            const backups = await window.api.databaseBackups();
            return JSON.stringify({
              opened: !!document.querySelector("#view-database.active"),
              tableCount: overview.tableCount,
              totalRows: overview.totalRows,
              journalMode: overview.journalMode,
              tableRows: document.querySelectorAll("#dbTableList .db-table-item").length,
              hasEditor: !!document.getElementById("dbInspectorFields"),
              hasGrid: !!document.getElementById("dbGridBody"),
              hasStructureTab: !!document.getElementById("dbTabStructure"),
              backupButton: !!document.getElementById("dbBackupBtn"),
              restoreButton: !!document.getElementById("dbRestoreBtn"),
              restoreModal: !!document.getElementById("dbRestoreModal"),
              backupCount: backups.backups ? backups.backups.length : 0,
              accountRows: table.rows ? table.rows.length : 0,
              accountTotal: table.total
            });
          })()`);
          console.log("[SMOKE] database-state:", dbState);
          const image3 = await mainWindow?.webContents.capturePage();
          if (image3) {
            const shotDir = path.resolve(__dirname, "../../../docs");
            fs.mkdirSync(shotDir, { recursive: true });
            const shot = path.join(shotDir, "ui-database.png");
            fs.writeFileSync(shot, image3.toPNG());
            console.log("[SMOKE] database screenshot saved:", shot);
          }
        } catch (e) {
          console.log("[SMOKE] database-state ERROR:", e);
        }
        // 模组页三页签探针：**用真实 DOM 点击**（走 inline onclick 那条路）确认页签真的会换列表。
        try {
          const modsState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const beforeNav = { tab: typeof MOD_TAB === "string" ? MOD_TAB : "?", active: document.querySelector("#modTabs .mod-tab.active")?.dataset?.mtab ?? "", modalOpen: !!document.getElementById("updateModal")?.classList.contains("open") };
            const item = document.querySelector('.nav-item[data-view="modules"]');
            if (!item) return JSON.stringify({ opened: false, reason: "no nav item" });
            item.click();
            if (typeof closeModal === "function") closeModal("updateModal");
            await new Promise((r) => setTimeout(r, 1200));
            const flat = (txt) => String(txt || "").split("\\n").join(" ").split("\\r").join(" ").trim().slice(0, 46);
            const snap = () => ({
              tab: typeof MOD_TAB === "string" ? MOD_TAB : "?",
              active: document.querySelector("#modTabs .mod-tab.active")?.dataset?.mtab ?? "",
              mkCards: document.querySelectorAll("#modsGrid .mk-card").length,
              modCards: document.querySelectorAll("#modsGrid .mod").length,
              firstText: flat(document.getElementById("modsGrid")?.textContent)
            });
            const clickTab = async (name) => {
              const el = document.querySelector('#modTabs .mod-tab[data-mtab="' + name + '"]');
              if (!el) return "no tab element";
              el.click();
              await new Promise((r) => setTimeout(r, 900));
              return "ok";
            };
            const out = {
              beforeNav: beforeNav,
              hasSwitch: typeof switchModTab === "function",
              hasActions: document.querySelectorAll("#modTabActions .mini-btn").length,
              installed: snap()
            };
            try {
              const authorBtn = document.getElementById("modActAuthor");
              if (authorBtn) { authorBtn.click(); await new Promise((r) => setTimeout(r, 700)); }
              out.authorModalOpened = !!document.getElementById("authorModal")?.classList.contains("open");
              if (typeof closeModal === "function") closeModal("authorModal");
              const statText = () => (document.getElementById("modStats")?.textContent ?? "").split(String.fromCharCode(10)).join(" ").replace(/ +/g, " ").trim().slice(0, 70);
              out.statsInstalled = statText();
              out.clickMine = await clickTab("mine");
              out.mine = snap();
              out.statsMine = statText();
              out.clickMarket = await clickTab("market");
              out.market = snap();
              out.statsMarket = statText();
              out.clickInstalled = await clickTab("installed");
              out.backToInstalled = snap();
            } catch (e) {
              out.error = String(e && e.message ? e.message : e);
            }
            // 维护者审核链路：真实索引里被 reject/delist 的模组，市场不该再出现，作者在「我创建的」要能看到原因
            try {
              if (typeof loadMarket === "function") await loadMarket(true, true);
              if (typeof loadMyMods === "function") await loadMyMods();
              await new Promise((r) => setTimeout(r, 400));
              const mineItems = (MY_MODS || []).map((m) => ({
                id: m.id,
                status: m.status,
                action: m.moderationAction || "",
                reason: typeof modReasonText === "function" ? modReasonText(m.moderationReason) : ""
              }));
              MOD_TAB = "mine";
              if (typeof updateModTabs === "function") updateModTabs();
              if (typeof renderMyMods === "function") renderMyMods();
              await new Promise((r) => setTimeout(r, 250));
              const row = document.querySelector("#modsGrid .mk-reason");
              out.moderation = {
                marketIds: (MARKET || []).map((m) => m.id),
                delistedIds: (typeof MARKET_DELISTED !== "undefined" ? MARKET_DELISTED : []).map((d) => d.id),
                mine: mineItems,
                reasonBlock: row ? (row.textContent || "").trim().slice(0, 120) : "",
                reasonHasCjk: row ? /[\u4e00-\u9fff]/.test(row.textContent || "") : false
              };
            } catch (e) {
              out.moderationError = String(e && e.message ? e.message : e).slice(0, 200);
            }
            // 用一条真实形状的数据直接测 renderMyMods（这是唯一没被覆盖到的渲染路径）
            try {
              MY_MODS = [{ id: "fake-mod", displayName: "假模组", version: "1.0.0", category: "玩法", status: "local", folder: "fake-mod", localVersion: "1.0.0", listedVersion: "", signed: true, sourceRepo: "", prUrl: "", sizeBytes: 100, updatedAt: 0 }];
              MOD_TAB = "mine";
              if (typeof renderMyMods === "function") renderMyMods();   // 直接渲染，避免被 loadMyMods 覆盖
              await new Promise((r) => setTimeout(r, 200));
              out.synthetic = snap();
              // 审核中状态：徽章变蓝 + 提交按钮禁用（防止重复提交）
              MY_MODS = [{ id: "review-mod", displayName: "审核中假模组", version: "1.0.0", category: "玩法", status: "submitted", folder: "review-mod", localVersion: "1.0.0", listedVersion: "", signed: true, sourceRepo: "me/review-mod", prUrl: "", sizeBytes: 1, updatedAt: 0 }];
              MOD_TAB = "mine";
              if (typeof renderMyMods === "function") renderMyMods();
              await new Promise((r) => setTimeout(r, 200));
              const reviewHtml = document.getElementById("modsGrid")?.innerHTML ?? "";
              out.reviewCard = {
                badgeReview: reviewHtml.includes("mk-badge review"),
                btnDisabled: /<button class="mk-btn" disabled/.test(reviewHtml),
                text: (document.getElementById("modsGrid")?.textContent ?? "").split(String.fromCharCode(10)).join(" ").trim().slice(0, 80)
              };
              // 收尾停在市场页（含两张假模组卡片），方便截图核对描述/标签/元信息行是否对齐
              MOD_TAB = "market";
              if (typeof updateModTabs === "function") updateModTabs();
              if (typeof renderMarket === "function") renderMarket();
              await new Promise((r) => setTimeout(r, 250));
              document.querySelector("#modsGrid .mk-meta")?.scrollIntoView({ block: "center" });
              await new Promise((r) => setTimeout(r, 250));
              out.syntheticHtml = (document.getElementById("modsGrid")?.innerHTML ?? "").slice(0, 200);
              // 市场网格同样要能用真实形状的数据渲染（renderMarket 也用了 esc）
              const realMarketSnapshot = Array.isArray(MARKET) ? MARKET.slice() : [];
              MARKET = [
                { id: "fake-market", displayName: "市场假模组", version: "2.0.0", author: { id: "au-x", name: "某人" }, description: "描述", category: "经济", tags: ["标签"], requiresRestart: true, sizeBytes: 7340032, downloads: 12345, updatedAt: "2026-09-01T00:00:00.000Z", downloadUrls: [{ mirror: "github", url: "https://example.com/a.zip", priority: 1 }] },
                { id: "fake-nodl", displayName: "没统计到下载", version: "1.0.0", author: { name: "某人" }, description: "描述", category: "工具", tags: ["标签"], downloadUrls: [{ mirror: "github", url: "https://example.com/b.zip", priority: 1 }] }
              ];
              MOD_TAB = "market";
              if (typeof renderMarket === "function") renderMarket();
              await new Promise((r) => setTimeout(r, 200));
              out.syntheticMarket = snap();
              out.metaIcons = {
                svgSpans: document.querySelectorAll("#modsGrid .mk-meta .meta-i svg").length,
                icons: [...document.querySelectorAll("#modsGrid .mk-meta .meta-i")].map((el) => ({
                  kindTitle: el.getAttribute("title"),
                  hasSvg: !!el.querySelector("svg"),
                  text: (el.querySelector(".v")?.textContent ?? "").trim()
                })),
                dateOnly: [...document.querySelectorAll("#modsGrid .mk-meta .meta-i")].map((el) => (el.querySelector(".v")?.textContent ?? "").trim()).filter((t) => /^\\d{4}-\\d{2}-\\d{2}$/.test(t)),
                noIsoTime: !/\\d{2}:\\d{2}:\\d{2}/.test(document.querySelector("#modsGrid .mk-meta")?.textContent ?? "")
              };
              if (realMarketSnapshot && realMarketSnapshot.length) { MARKET = realMarketSnapshot.slice(); }
              if (typeof renderMarket === "function") renderMarket();
              if (typeof goView === "function") goView("modules");
              await new Promise((r) => setTimeout(r, 300));
              out.syntheticMarketHtml = (document.getElementById("modsGrid")?.innerHTML ?? "").slice(0, 160);
              // 每张市场卡片都要有自己的下载次数行；没有 downloads 字段时显示「待统计」
              const marketCards = Array.from(document.querySelectorAll("#modsGrid .mk-card"));
              const dlTexts = marketCards.map((c) => (c.querySelector(".mk-dl")?.textContent ?? "").trim());
              out.marketDownloadRow = {
                cards: marketCards.length,
                dlSpans: document.querySelectorAll("#modsGrid .mk-dl").length,
                dlTexts: dlTexts,
                noSourceBtn: !document.querySelector("#modsGrid")?.innerHTML.includes("源码"),
                statsRegions: document.querySelectorAll("#view-modules .mod-stats").length
              };
              // 已安装卡片：字段应为 分类 / 标签 / MOD大小 / 本地版本，并有「详情」按钮
              MODS.push({ folder: "fake-installed", id: "fake-installed", displayName: "已装假模组", version: "3.1.4", description: "这是简介字段", category: "经济", tags: ["经济", "工具"], kind: "loader", restart: "game_server", enabled: true, supported: true, valid: true, sizeBytes: 7340032, signatureState: "valid", signatureTrusted: true, signatureKeyId: "abc", authorId: "au-x", authorName: "某人", conflicts: [] });
              MOD_TAB = "installed";
              if (typeof renderInstalledMods === "function") renderInstalledMods();
              await new Promise((r) => setTimeout(r, 200));
              const cardHtml = document.getElementById("modsGrid")?.innerHTML ?? "";
              out.card = {
                hasDetailBtn: cardHtml.includes("data-detail-folder"),
                hasUninstallBtn: cardHtml.includes("data-uninstall-folder"),
                showsCategory: cardHtml.includes("经济"),
                hasLoaderWord: cardHtml.includes("LOADER"),
                hasSize: cardHtml.includes("MOD"),
                noRestartField: !cardHtml.includes("restart:")
              };
              out.cardText = (document.getElementById("modsGrid")?.textContent ?? "").split(String.fromCharCode(10)).join(" ").trim().slice(0, 120);
              // 分类图标：再来一张「玩法」卡片，两张卡的图标应该不同
              MODS.push({ folder: "fake-gameplay", id: "fake-gameplay", displayName: "玩法假模组", version: "1.0.0", description: "简介", category: "玩法", tags: ["玩法"], kind: "loader", restart: "game_server", enabled: false, supported: true, valid: true, sizeBytes: 1024, signatureState: "valid", signatureTrusted: true, conflicts: [] });
              if (typeof renderInstalledMods === "function") renderInstalledMods();
              await new Promise((r) => setTimeout(r, 200));
              const iconHtml = [...document.querySelectorAll("#modsGrid .mod-icon")].map((el) => el.innerHTML);
              out.categoryIconHeads = iconHtml.map((h) => (h.match(/d="([^"]{0,18})/) || [])[1] || h.slice(0, 24));
              out.categoryIcons = { cards: iconHtml.length, uniqueIcons: new Set(iconHtml).size };
              out.appVersion = { brand: document.querySelector(".logo-text .t2")?.textContent ?? "", currentVer: typeof CURRENT_VER !== "undefined" ? CURRENT_VER : "" };
              // 市场页签的「N 可更新」徽章（模拟 4 个可更新）
              MOD_UPDATES = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
              if (typeof updateModTabs === "function") updateModTabs();
              await new Promise((r) => setTimeout(r, 150));
              // 作者按钮标签：切语言后应直接是当前语言（修掉「先中文再被翻译」的闪烁）
              out.authorLabel = {
                text: (document.getElementById("authorBtnLabel")?.textContent ?? "").trim(),
                hasCjk: /[\u4e00-\u9fff]/.test(document.getElementById("authorBtnLabel")?.textContent ?? "")
              };
              out.tabBadge = {
                text: (document.getElementById("mtMarketUp")?.textContent ?? "").trim(),
                visible: (document.getElementById("mtMarketUp")?.style.display ?? "none") !== "none",
                marketCount: (document.getElementById("mtMarket")?.textContent ?? "").trim()
              };
              MOD_UPDATES = [];
              if (typeof updateModTabs === "function") updateModTabs();
              // 详情弹窗：打开并检查内容
              if (typeof openInstalledModDetail === "function") await openInstalledModDetail("fake-installed");
              await new Promise((r) => setTimeout(r, 300));
              out.detail = {
                open: !!document.getElementById("modDetailModal")?.classList.contains("open"),
                title: document.getElementById("mdTitle")?.textContent ?? "",
                hasHighlightSection: (document.getElementById("mdBody")?.textContent ?? "").includes("功能"),
                cells: document.querySelectorAll("#mdBody .md-cell").length,
                text: (document.getElementById("mdBody")?.textContent ?? "").split(String.fromCharCode(10)).join(" ").trim().slice(0, 140)
              };
              if (typeof closeModal === "function") closeModal("modDetailModal");
              // 收尾停在市场页签：主进程紧接着截图，用来肉眼核对卡片布局
              MOD_TAB = "market";
              if (typeof updateModTabs === "function") updateModTabs();
              if (typeof renderMarket === "function") renderMarket();
              await new Promise((r) => setTimeout(r, 250));
              // 滚到卡片区，让截图能看到卡片底部的下载次数行
              document.getElementById("modsGrid")?.scrollIntoView({ block: "start" });
              document.querySelector("#view-modules .view-scroll, #view-modules")?.scrollBy?.(0, 700);
              await new Promise((r) => setTimeout(r, 250));
            } catch (e) {
              out.syntheticError = String(e && e.stack ? e.stack : e).slice(0, 300);
            }
            return JSON.stringify(out);
          })()`);
        // 构建选项行布局探针：复选框不应被撑宽、标签不应被压成逐字换行
        try {
          const layoutState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            if (typeof openCreateModDialog === "function") await openCreateModDialog();
            await new Promise((r) => setTimeout(r, 400));
            const row = document.querySelector("#createModModal .cm-opts");
            if (!row) return JSON.stringify({ found: false });
            const labels = [...row.querySelectorAll("label")].map((el) => ({
              w: el.offsetWidth,
              h: el.offsetHeight,
              text: (el.textContent || "").trim()
            }));
            const boxes = [...row.querySelectorAll('input[type="checkbox"]')].map((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
            const out = {
              found: true,
              rowW: row.offsetWidth,
              rowH: row.offsetHeight,
              labels: labels,
              boxes: boxes,
              oneLine: labels.every((l) => l.h <= 30),
              boxNotStretched: boxes.every((b) => b.w <= 30)
            };
            if (typeof closeModal === "function") closeModal("createModModal");
            return JSON.stringify(out);
          })()`);
          console.log("[SMOKE] build-options-layout:", layoutState);
        } catch (e) {
          console.log("[SMOKE] build-options-layout ERROR:", e);
        }        // 语言残留探针：切英文后，模组相关弹窗里不该再出现中文（这些是用户实际截图反馈过的位置）
        try {
          const i18nState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const cjk = /[\\u4e00-\\u9fff]/;
            const clean = (s) => String(s || "").split(" ").join(" ").trim().slice(0, 40);
            if (typeof setLang === "function") setLang("en");
            await wait(500);
            const out = { lang: typeof curLang === "string" ? curLang : "?", leftovers: [], spots: {} };
            const scanModal = (id, label) => {
              const modal = document.getElementById(id);
              if (!modal) { out.spots[label] = "no modal"; return; }
              const bad = [];
              modal.querySelectorAll("span,label,b,code,pre,li,h4,p,div").forEach((el) => {
                if (el.children.length) return;
                // 跳过「数据」节点：模组名/作者名/仓库名是用户内容，不算界面文案残留
                if (el.closest("#smPickerMenu,.sm-picker-item,.mk-card,.db-inspector")) return;
                const txt = (el.textContent || "").trim();
                if (txt && cjk.test(txt)) bad.push(clean(txt));
              });
              modal.querySelectorAll("input,textarea").forEach((el) => {
                const ph = el.getAttribute("placeholder") || "";
                if (ph && cjk.test(ph)) bad.push("placeholder:" + clean(ph));
              });
              modal.querySelectorAll("option").forEach((el) => {
                const txt = (el.textContent || "").trim();
                if (txt && cjk.test(txt) && txt.length <= 6) bad.push("option:" + clean(txt));
              });
              out.spots[label] = bad;
              bad.forEach((x) => out.leftovers.push(label + " → " + x));
            };
            try {
              if (typeof openCreateModDialog === "function") { await openCreateModDialog(); await wait(400); scanModal("createModModal", "创建模组"); closeModal("createModModal"); }
              if (typeof openSubmitModDialog === "function") { await openSubmitModDialog(); await wait(400); scanModal("submitModModal", "提交模组"); closeModal("submitModModal"); }
              if (typeof openAuthorDialog === "function") { await openAuthorDialog(); await wait(400); scanModal("authorModal", "作者身份"); closeModal("authorModal"); }
              if (typeof openAuthorDialog === "function") { await openAuthorDialog(); await wait(400); scanModal("authorModal", "作者身份"); closeModal("authorModal"); }
              scanModal("modsMissingPanel", "mods缺失提示");
            } catch (e) {
              out.error = String(e && e.message ? e.message : e);
            }
            return JSON.stringify(out);
          })()`);
          console.log("[SMOKE] i18n-leftovers:", i18nState);
        // 冲突横幅本地化探针：切英文后横幅文案里不该有中文（词条 + {1} 参数替换）
        try {
          const conflictState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const cjk = /[\\u4e00-\\u9fff]/;
            const out = {};
            const sample = { kind: "shared-module", folders: ["a", "b"], detail: "都引用了服务端模块 chatHub.js（可能互相影响）", i18nKey: "conflict.sharedModule", i18nArgs: ["chatHub.js"], active: true };
            if (typeof setLang === "function") setLang("en");
            await wait(400);
            out.text = typeof conflictText === "function" ? conflictText(sample) : "(no conflictText)";
            out.hasCjk = cjk.test(out.text);
            out.noPlaceholder = !/\\{\\d\\}/.test(out.text);
            // 再真的渲染一次横幅
            if (typeof MOD_CONFLICTS !== "undefined") {
              const backup = MOD_CONFLICTS.slice();
              MOD_CONFLICTS.length = 0;
              MOD_CONFLICTS.push(sample);
              if (typeof updateModBanner === "function") updateModBanner();
              await wait(200);
              out.banner = (document.getElementById("modBanner")?.textContent ?? "").split(String.fromCharCode(10)).join(" ").trim().slice(0, 90);
              out.bannerHasCjk = cjk.test(out.banner);
              MOD_CONFLICTS.length = 0; backup.forEach((x) => MOD_CONFLICTS.push(x));
              if (typeof updateModBanner === "function") updateModBanner();
            }
            if (typeof setLang === "function") setLang("zh");
            return JSON.stringify(out);
          })()`);
          console.log("[SMOKE] conflict-i18n:", conflictState);
        } catch (e) {
          console.log("[SMOKE] conflict-i18n ERROR:", e);
        }
        } catch (e) {
          console.log("[SMOKE] i18n-leftovers ERROR:", e);
        }
        try {
        // 市场截图前再确认一次强制切回模组视图，避免其他异步渲染把视图换掉
        let modsShotReady = false;
        try {
          const shotPrep = await mainWindow?.webContents.executeJavaScript(`(async () => {
            MOD_TAB = "market";
            if (typeof updateModTabs === "function") updateModTabs();
            if (typeof renderMarket === "function") renderMarket();
            if (typeof goView === "function") goView("modules");
            await new Promise((r) => setTimeout(r, 400));
            document.querySelector("#modsGrid .mk-meta")?.scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 400));
            return JSON.stringify({
              active: document.querySelector("#view-modules")?.classList.contains("active"),
              cards: document.querySelectorAll("#modsGrid .mk-card").length,
              metaSvg: document.querySelectorAll("#modsGrid .mk-meta .meta-i svg").length
            });
          })()`);
          console.log("[SMOKE] mods-screenshot-prep:", shotPrep);
          modsShotReady = true;
        } catch (e) {
          console.log("[SMOKE] mods-screenshot-prep ERROR:", e);
        }
          const modsImage = await mainWindow?.webContents.capturePage();
          if (modsImage) {
            const modsShotDir = path.resolve(__dirname, "../../../docs");
            fs.mkdirSync(modsShotDir, { recursive: true });
            const modsShot = path.join(modsShotDir, "ui-mods-market.png");
            fs.writeFileSync(modsShot, modsImage.toPNG());
            console.log("[SMOKE] mods screenshot saved:", modsShot);
          }
        } catch (e) {
          console.log("[SMOKE] mods screenshot ERROR:", e);
        }
        // 审核效果截图：用真实索引数据渲染「我创建的」，把维护者给的下架/拒绝原因拍下来
        try {
          await mainWindow?.webContents.executeJavaScript(`(async () => {
            if (typeof loadMyMods === "function") await loadMyMods();
            await new Promise((r) => setTimeout(r, 400));
            MOD_TAB = "mine";
            if (typeof updateModTabs === "function") updateModTabs();
            if (typeof renderMyMods === "function") renderMyMods();
            document.querySelector("#view-modules .acc-toolbar")?.scrollIntoView({ block: "start" });
            await new Promise((r) => setTimeout(r, 250));
            return "ok";
          })()`);
          const moderationImage = await mainWindow?.webContents.capturePage();
          if (moderationImage) {
            const modShotDir = path.resolve(__dirname, "../../../docs");
            fs.mkdirSync(modShotDir, { recursive: true });
            const modShot = path.join(modShotDir, "ui-moderation.png");
            fs.writeFileSync(modShot, moderationImage.toPNG());
            console.log("[SMOKE] moderation screenshot saved:", modShot);
          }
        } catch (e) {
          console.log("[SMOKE] moderation screenshot ERROR:", e);
        }
        // 模组制作规范：内嵌 Markdown 阅读器（标题导航树 / 表格 / 代码块）
        try {
          const docState = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const out = {};
            if (typeof openModAuthoringDoc !== "function") return JSON.stringify({ error: "no openModAuthoringDoc" });
            await openModAuthoringDoc();
            await wait(700);
            const modal = document.getElementById("docModal");
            const body = document.getElementById("docBody");
            const toc = document.getElementById("docToc");
            out.opened = !!(modal && modal.classList.contains("open"));
            out.headings = body ? body.querySelectorAll("h1,h2,h3").length : 0;
            out.h1 = body && body.querySelector("h1") ? body.querySelector("h1").textContent.slice(0, 40) : "";
            out.tables = body ? body.querySelectorAll("table").length : 0;
            out.preBlocks = body ? body.querySelectorAll("pre").length : 0;
            out.tocItems = toc ? toc.querySelectorAll(".doc-toc-item").length : 0;
            out.tocFirst = toc && toc.querySelector(".doc-toc-item") ? toc.querySelector(".doc-toc-item").textContent.slice(0, 30) : "";
            out.tocActive = toc ? toc.querySelectorAll(".doc-toc-item.active").length : 0;
            out.hasColorLegend = body ? body.textContent.includes("颜色 / 标记图例") : false;
            const dmodal = document.querySelector("#docModal .doc-modal");
            out.docFont = dmodal ? getComputedStyle(dmodal).getPropertyValue("--doc-fs").trim() : "";
            out.docSize = dmodal ? Math.round(dmodal.offsetWidth) + "x" + Math.round(dmodal.offsetHeight) : "";
            out.resizable = dmodal ? getComputedStyle(dmodal).resize : "";
            out.tools = document.querySelectorAll("#docModal .doc-tools button").length;
            out.tools = document.querySelectorAll("#docModal .doc-tools button").length;
            const langBtn = document.getElementById("docLangBtn");
            out.langBtn = langBtn ? langBtn.textContent : "";
            if (typeof docToggleLang === "function") {
              await docToggleLang();
              await wait(600);
              const h1b = document.querySelector("#docBody h1");
              out.afterToggleH1 = h1b ? h1b.textContent.slice(0, 46) : "";
              out.tocAfterToggle = document.querySelectorAll("#docToc .doc-toc-item").length;
              await docToggleLang();
              await wait(400);
            }
            return JSON.stringify(out);
          })()`);
          console.log("[SMOKE] authoring-doc:", docState);
          const docImage = await mainWindow?.webContents.capturePage();
          if (docImage) {
            const dir = path.resolve(__dirname, "../../../docs");
            fs.mkdirSync(dir, { recursive: true });
            const shot = path.join(dir, "ui-authoring-doc.png");
            fs.writeFileSync(shot, docImage.toPNG());
            console.log("[SMOKE] authoring-doc screenshot saved:", shot);
          }
          await mainWindow?.webContents.executeJavaScript(`(() => { if (typeof closeModal === "function") closeModal("docModal"); return "ok"; })()`);
        } catch (e) {
          console.log("[SMOKE] authoring-doc ERROR:", e);
        }
        console.log("[SMOKE] mods-state:", modsState);
        } catch (e) {
          console.log("[SMOKE] mods-state ERROR:", e);
        }
        // 探针：审核结论（拒绝收录 / 已下架）在作者删掉本地 mods/<id> 后必须仍然可见且带原因
        try {
          const author = getAuthor();
          const pem = readAuthorPrivateKey();
          const builtIndexPath = path.join(__dirname, "..", "..", "..", "..", "..", "evejs-mods-index", "docs", "mod-index.json");
          const builtIndex = JSON.parse(fs.readFileSync(builtIndexPath, "utf8"));
          const authorId = author.author.id;
          const mods = (builtIndex.mods || []) as Array<{ id?: string; source?: string; delisted?: boolean; delistReason?: unknown }>;
          const rejectTarget = mods.find((m) => m.id === "evejs-cntext-fix") || mods[0];
          const delistTarget = mods.find((m) => m.id === "evejs-autolockfire") || mods[1] || mods[0];
          const rejectReason = { zh: "[SMOKE] 拒绝原因测试", en: "[SMOKE] reject reason" };
          const delistReason = { zh: "[SMOKE] 下架原因测试", en: "[SMOKE] delist reason" };
          builtIndex.moderation = {};
          if (rejectTarget && rejectTarget.id) builtIndex.moderation[rejectTarget.id] = { id: rejectTarget.id, source: rejectTarget.source || "", authorId, action: "reject", reason: rejectReason, at: new Date().toISOString(), by: "smoke" };
          if (delistTarget) {
            delistTarget.delisted = true;
            delistTarget.delistReason = delistReason;
            builtIndex.moderation[delistTarget.id as string] = { id: delistTarget.id, source: delistTarget.source || "", authorId, action: "delist", reason: delistReason, at: new Date().toISOString(), by: "smoke" };
          }
          if (pem) {
            const sig = signManifest(builtIndex, pem);
            builtIndex.signature = { alg: "ed25519", keyId: author.author.keyId, sig, signedAt: new Date().toISOString() };
          }
          const cacheDir = ensureLauncherRuntimePaths().cache;
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, "mod-index.json"), JSON.stringify({ index: builtIndex, fetchedAt: Date.now() }), "utf8");
          const mine = await listMyMods(resolveRepoRoot());
          const find = (s: string) => mine.items.find((m) => m.status === s);
          console.log("[SMOKE] mods-visibility:", JSON.stringify({
            usedKey: !!pem,
            hidden: mine.hidden,
            statuses: mine.items.map((m) => m.id + "=" + m.status),
            rejectedVisible: !!find("rejected"),
            rejectedFolderEmpty: !find("rejected") || !find("rejected")!.folder,
            rejectedReasonZh: find("rejected")?.moderationReason?.zh || "",
            delistedVisible: !!find("delisted"),
            delistedFolderEmpty: !find("delisted") || !find("delisted")!.folder,
            delistedReasonZh: find("delisted")?.moderationReason?.zh || "",
          }));
        } catch (e) {
          console.log("[SMOKE] mods-visibility ERROR:", e);
        }

        // 探针：创建模组的「将生成」预览必须与真实落地文件一致（默认 loader.js.disabled），并且三级配色各不相同
        try {
          const preview = await mainWindow?.webContents.executeJavaScript(`(async () => {
            if (typeof openCreateModDialog === "function") await openCreateModDialog();
            await new Promise((r) => setTimeout(r, 500));
            const pre = document.getElementById("cmPreview");
            const enabled = document.getElementById("cmEnabled");
            if (enabled) { enabled.checked = false; if (typeof cmPreview === "function") cmPreview(); }
            await new Promise((r) => setTimeout(r, 150));
            const offText = pre ? pre.textContent : "";
            const colors = {
              root: pre && pre.querySelector(".cm-root") ? getComputedStyle(pre.querySelector(".cm-root")).color : "",
              file: pre && pre.querySelector(".cm-file") ? getComputedStyle(pre.querySelector(".cm-file")).color : "",
              tpl: pre && pre.querySelector(".cm-tpl") ? getComputedStyle(pre.querySelector(".cm-tpl")).color : "",
            };
            const fileRows = pre ? Array.from(pre.querySelectorAll(".cm-file")).map((el) => Math.round(el.getBoundingClientRect().top)) : [];
            const rowsOnSeparateLines = new Set(fileRows).size === fileRows.length && fileRows.length > 1;
            if (enabled) { enabled.checked = true; if (typeof cmPreview === "function") cmPreview(); }
            await new Promise((r) => setTimeout(r, 150));
            const onText = pre ? pre.textContent : "";
            if (typeof closeModal === "function") closeModal("createModModal");
            return JSON.stringify({
              rowsOnSeparateLines,
              disabledListed: offText.includes("loader.js.disabled"),
              plainLoaderAbsentWhenDisabled: !/\bloader\.js\b(?!\.disabled)/.test(offText),
              loaderListedWhenEnabled: onText.includes("loader.js"),
              colors,
              threeDistinct: colors.root !== colors.file && colors.file !== colors.tpl && colors.root !== colors.tpl,
              sample: offText.split(String.fromCharCode(10)).filter(Boolean).slice(0, 6),
            });
          })()`);
          console.log("[SMOKE] create-preview:", preview);
        } catch (e) {
          console.log("[SMOKE] create-preview ERROR:", e);
        }
        // 探针：创建模组时填的「详细介绍」必须跟着 README.md 进入上架清单（否则市场详情里模组说明是空的）
        try {
          console.log("[SMOKE] listing-readme probe start");
          const probeRoot = path.join(ensureLauncherRuntimePaths().userData, "readme-probe-root");
          fs.mkdirSync(path.join(probeRoot, "server", "src", "services", "chat"), { recursive: true });
          fs.writeFileSync(path.join(probeRoot, "server", "src", "services", "chat", "chatHub.js"), "", "utf8");
          fs.writeFileSync(path.join(probeRoot, "server", "src", "services", "chat", "sessionRegistry.js"), "", "utf8");
          const created = createMod(probeRoot, {
            id: "smoke-readme-mod",
            displayName: "Smoke README Mod",
            version: "1.0.0",
            description: "one-line summary",
            templateId: "blank",
            category: "工具",
            tags: [],
            readme: "段落一：这是详细介绍的第一段。\n\n段落二：这是第二段，用来验证段落分割。",
            highlights: ["亮点一", "亮点二"],
            conflicts: [],
            requiresRestart: true,
            enabled: false,
            sign: false,
          }, "0.12.8");
          const prep = created.ok
            ? await prepareSubmission(probeRoot, { folder: "smoke-readme-mod", changelog: "smoke", category: "工具", tags: [], repo: "", downloadUrls: [] })
            : { ok: false, reason: "createMod failed: " + created.reason };
          const draft = prep && prep.ok && prep.item ? (prep.item.indexDraft as { readme?: unknown; highlights?: unknown }) : {};
          console.log("[SMOKE] listing-readme:", JSON.stringify({
            created: created.ok,
            prepOk: !!prep.ok,
            readmeIsArray: Array.isArray(draft.readme),
            readmeParagraphs: Array.isArray(draft.readme) ? draft.readme.length : 0,
            readmeFirst: Array.isArray(draft.readme) ? String(draft.readme[0] || "").slice(0, 40) : "",
            readmeHasOnlyBody: Array.isArray(draft.readme) ? draft.readme.every((x) => !String(x).startsWith("##")) : false,
            highlights: Array.isArray(draft.highlights) ? draft.highlights : [],
            prepReason: prep.ok ? "" : String(prep.reason || created.reason || "").slice(0, 120),
          }));
        } catch (e) {
          console.log("[SMOKE] listing-readme ERROR:", e);
        }

        // 探针：服务端根目录识别必须支持现版 server/index.js（不再只认 server/autostart.js）
        try {
          const fake = path.join(ensureLauncherRuntimePaths().userData, "root-probe");
          const real = path.join(fake, "EveJS-real");
          fs.mkdirSync(path.join(real, "server"), { recursive: true });
          fs.writeFileSync(path.join(real, "StartServer.bat"), "@echo off", "utf8");
          fs.writeFileSync(path.join(real, "server", "index.js"), "", "utf8");
          fs.writeFileSync(path.join(real, "server", "package.json"), "{}\n", "utf8");
          const legacy = path.join(fake, "EveJS-legacy");
          fs.mkdirSync(path.join(legacy, "server"), { recursive: true });
          fs.writeFileSync(path.join(legacy, "StartServer.bat"), "@echo off", "utf8");
          fs.writeFileSync(path.join(legacy, "server", "autostart.js"), "", "utf8");
          const rootProbe = await mainWindow?.webContents.executeJavaScript(`(async () => {
            const real = ${JSON.stringify(real)};
            const parent = ${JSON.stringify(fake)};
            const sub = ${JSON.stringify(path.join(real, "server"))};
            const legacyRoot = ${JSON.stringify(path.join(fake, "EveJS-legacy"))};
            const legacyRes = await window.api.configSetRepoRoot(legacyRoot);
            const bad = ${JSON.stringify(path.join(fake, "not-a-server"))};
            const exact = await window.api.configSetRepoRoot(real);
            const parentRes = await window.api.configSetRepoRoot(parent);
            const subRes = await window.api.configSetRepoRoot(sub);
            const badRes = await window.api.configSetRepoRoot(bad);
            return JSON.stringify({
              exactOk: !!exact.ok,
              parentCorrected: !!parentRes.ok && parentRes.corrected === true,
              parentRoot: (parentRes && parentRes.repoRoot) || "",
              subdirCorrected: !!subRes.ok && subRes.corrected === true,
              badRejected: !badRes.ok,
              legacyOk: !!legacyRes.ok,
              badReason: badRes.ok ? "" : String(badRes.reason || "").slice(0, 80),
              configWritten: !!exact.path,
            });
          })()`);
          console.log("[SMOKE] repo-root-probe:", rootProbe);
        } catch (e) {
          console.log("[SMOKE] repo-root-probe ERROR:", e);
        }

        // 探针：防御“本机自己签名的模组，下载方也能验证通过”（市场兼容性）
        try {
          const { scanMods, readModDir, signModFolder } = require("./modManager");
          const root = path.join(ensureLauncherRuntimePaths().userData, "signed-probe");
          fs.mkdirSync(path.join(root, "server", "src", "services", "chat"), { recursive: true });
          fs.writeFileSync(path.join(root, "StartServer.bat"), "@echo off", "utf8");
          fs.writeFileSync(path.join(root, "server", "index.js"), "", "utf8");
          fs.writeFileSync(path.join(root, "server", "package.json"), "{}\n", "utf8");
          const made = createMod(root, {
            id: "signed-probe-mod",
            displayName: "Signed Probe",
            version: "1.0.0",
            description: "probe",
            templateId: "blank",
            category: "工具",
            tags: [],
            readme: "probe readme",
            highlights: [],
            conflicts: [],
            requiresRestart: true,
            enabled: false,
            sign: true
          }, "0.12.8");
          const dir = path.join(root, "mods", "signed-probe-mod");
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, "evejs-launcher.mod.json"), "utf8"));
          const scanned = scanMods(root).mods.find((m: { id?: string }) => m.id === "signed-probe-mod");
          console.log("[SMOKE] signed-installed-probe:", JSON.stringify({
            created: made.ok,
            hasSignature: !!manifest.signature,
            authorHasPublicKey: !!(manifest.author && manifest.author.publicKey),
            signatureStateOnRescan: scanned ? scanned.signatureState : "?",
            signatureTrustedOnRescan: scanned ? scanned.signatureTrusted : "?",
          }));
        } catch (e) {
          console.log("[SMOKE] signed-installed-probe ERROR:", e);
        }

        // 探针：已安装模组的「来源」必须区分市场下载与本机创建
        try {
          const { scanMods } = require("./modManager");
          const root = path.join(ensureLauncherRuntimePaths().userData, "source-probe");
          fs.mkdirSync(path.join(root, "server"), { recursive: true });
          fs.writeFileSync(path.join(root, "StartServer.bat"), "@echo off", "utf8");
          fs.writeFileSync(path.join(root, "server", "index.js"), "", "utf8");
          const localMade = createMod(root, { id: "local-mod", displayName: "Local Mod", version: "1.0.0", description: "d", templateId: "blank", category: "工具", tags: [], readme: "", highlights: [], conflicts: [], requiresRestart: true, enabled: false, sign: false }, "0.12.8");
          const marketDir = path.join(root, "mods", "market-mod");
          fs.mkdirSync(marketDir, { recursive: true });
          fs.writeFileSync(path.join(marketDir, "evejs-launcher.mod.json"), JSON.stringify({ schemaVersion: 3, id: "market-mod", displayName: "Market Mod", version: "2.0.0", description: "d", kind: "loader", restart: "game_server", activation: { strategy: "loader_rename" } }, null, 2), "utf8");
          fs.writeFileSync(path.join(marketDir, "loader.js.disabled"), "\"use strict\";\n", "utf8");
          fs.writeFileSync(path.join(marketDir, ".evejs-source.json"), JSON.stringify({ source: "market", repo: "someone/evejs-mod-market-mod", version: "2.0.0", id: "market-mod" }, null, 2), "utf8");
          const mods = scanMods(root).mods;
          const byId = (id: string) => mods.find((m: { id?: string }) => m.id === id);
          console.log("[SMOKE] mod-source-probe:", JSON.stringify({
            localCreated: !!localMade.ok,
            localSource: byId("local-mod") ? byId("local-mod").source : "?",
            marketSource: byId("market-mod") ? byId("market-mod").source : "?",
            marketRepo: byId("market-mod") ? byId("market-mod").sourceRepo : "",
          }));
        } catch (e) {
          console.log("[SMOKE] mod-source-probe ERROR:", e);
        }

        // 探针：新增的两条签名提示必须在切英文后也是英文（不能漏翻）
        try {
          const sigI18n = await mainWindow?.webContents.executeJavaScript(`(async () => {
            if (typeof setLang === "function") setLang("en");
            await new Promise((r) => setTimeout(r, 500));
            const chip = typeof t === "function" ? t("未签名（旧版包未含作者公钥）") : "";
            const note = typeof t === "function" ? t("这可能是旧版模组包：签名里没有附带作者公钥，本机无法验证，但不影响启用。作者用新版启动器重新发布后即可正常校验。") : "";
            const cjk = /[\u4e00-\u9fff]/;
            if (typeof setLang === "function") setLang("zh");
            return JSON.stringify({ keyInDict: !!(typeof TRANSLATE !== "undefined" && TRANSLATE["未签名（旧版包未含作者公钥）"]), chip, chipHasCjk: cjk.test(chip), note: note.slice(0, 70), noteHasCjk: cjk.test(note) });
          })()`);
          console.log("[SMOKE] sig-i18n-probe:", sigI18n);
        } catch (e) {
          console.log("[SMOKE] sig-i18n-probe ERROR:", e);
        }

        // 探针：根目录自动修正的提示也要跟随语言
        try {
          const rootToast = await mainWindow?.webContents.executeJavaScript(`(async () => {
            if (typeof setLang === "function") setLang("en");
            await new Promise((r) => setTimeout(r, 400));
            const en = typeof t === "function" ? t("服务端根目录已自动修正为") : "";
            if (typeof setLang === "function") setLang("zh");
            await new Promise((r) => setTimeout(r, 200));
            const zh = typeof t === "function" ? t("服务端根目录已自动修正为") : "";
            return JSON.stringify({ en, zh, enHasCjk: /[\u4e00-\u9fff]/.test(en), zhIsCn: zh.indexOf("服务端") === 0 });
          })()`);
          console.log("[SMOKE] root-toast-i18n-probe:", rootToast);
        } catch (e) {
          console.log("[SMOKE] root-toast-i18n-probe ERROR:", e);
        }
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
    // 每次启动把内置的模组制作规范释放到 _launcher/mods/，方便模组作者查阅
    ensureAllModAuthoringDocs();
    const authoringDoc = ensureModAuthoringDoc();
    if (authoringDoc.ok) {
      log("launcher", (authoringDoc.written ? "已释放" : "已是最新") + "模组制作规范: " + authoringDoc.path);
    } else {
      log("launcher", "模组制作规范释放失败: " + authoringDoc.reason);
    }
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
