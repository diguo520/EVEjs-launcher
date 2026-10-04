"use strict";
/**
 * EveJS 静态数据热重载 host（启动器自带功能，不是模组，也不改服务端任何文件）。
 *
 * 由启动器写进 `<exe 同级>/_launcher/hotreload/host.js`，并作为 `NODE_OPTIONS`
 * 里的第二条 `--require` 注入主服务器（第一条是模组总线 mod-host.js）。
 *
 * 为什么必须是注入而不是启动器直接改文件：
 *   `server/src/gameStore` 的 `preloadAll()` 一旦跑过就 `if (preloaded) return`，
 *   数据全部躺在**服务端进程的内存**里。启动器在进程外怎么写盘都到不了那份内存，
 *   所以重载必须发生在服务端进程内部。
 *
 * 为什么不打补丁改源码：
 *   服务端 `gameStore.write(table, "/", data)` 是公开导出，`segments.length === 0`
 *   时会整表覆盖 `cache[table]`（见 index.js L2116-2133），主服务器进程的角色是
 *   `world`（index.js L15 自己设的），对静态表有写权限。用它就够，服务端零改动。
 *
 * 边界（谁会被拒绝）：
 *   - 只认真正的服务端入口进程（entry 是 index.js），`NODE_OPTIONS` 会顺着
 *     npm → node → fork/worker 一路继承，别的进程 require 到本文件只会立刻退出；
 *   - 拒绝 `SQLITE_TABLES` 里的运行时表：那份内存缓存就是活的世界状态，覆盖它等于
 *     用磁盘上的旧副本回退玩家数据；
 *   - JSON 解析失败的表直接跳过并报 INVALID_JSON，不会动内存里的旧副本；
 *   - `EVEJS_HOTRELOAD=0` 可以整体关闭。
 *
 * 通道：请求 / 结果都走文件（`<dir>/request.json` → `<dir>/result.json`），
 * 不开监听端口，方向与「只允许本机」一致。轮询是 400ms 一次的 statSync，开销可忽略。
 */
(function bootstrap() {
  try {
    const fs = require("node:fs");
    const path = require("node:path");

    const TAG = "[EveJS-HOTRELOAD]";
    const API = 1;
    const HOST_VERSION = "1.0.0";
    const POLL_MS = 400;

    const dir = String(process.env.EVEJS_HOTRELOAD_DIR || "").trim();
    if (!dir) return;
    if (String(process.env.EVEJS_HOTRELOAD || "").trim() === "0") return;
    try {
      if (!require("node:worker_threads").isMainThread) return;
    } catch (error) {
      return;
    }

    /** 进程入口文件；preload 阶段 require.main 还没就绪，回退到 argv[1]（口径同 mod-host.js）。 */
    function entryFile() {
      try {
        if (require.main && require.main.filename) return String(require.main.filename);
      } catch (error) {
        /* 预加载阶段没有主模块 */
      }
      const argv1 = process.argv && process.argv[1] ? String(process.argv[1]) : "";
      if (!argv1) return "";
      try {
        if (fs.statSync(argv1).isDirectory()) {
          const pkg = JSON.parse(fs.readFileSync(path.join(argv1, "package.json"), "utf8"));
          return path.join(argv1, String(pkg.main || "index.js"));
        }
      } catch (error) {
        /* 不是目录 / 读不到 package.json */
      }
      return argv1;
    }

    const entry = entryFile();
    if (!/(^|[\\/])index\.js$/i.test(entry)) return;
    const serverDir = path.dirname(path.resolve(entry));

    const requestFile = path.join(dir, "request.json");
    const processingFile = path.join(dir, "request.processing.json");
    const resultFile = path.join(dir, "result.json");
    const sessionFile = path.join(dir, "session.json");
    const bootFile = path.join(dir, "boot.json");

    function readJson(file) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        return null;
      }
    }

    function writeJsonAtomic(file, value) {
      const text = JSON.stringify(value, null, 2) + "\n";
      const temp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(temp, text, "utf8");
      fs.renameSync(temp, file);
    }

    function safeLog(message) {
      try {
        console.log(TAG + " " + message);
      } catch (error) {
        /* 日志写不了不能影响服务端 */
      }
    }

    const boot = readJson(bootFile) || {};
    const bootId = String(boot.bootId || "");

    // 挂牌：启动器据此判断「这一轮服务端是不是自己带 host 起来的」。
    writeJsonAtomic(sessionFile, {
      api: API,
      hostVersion: HOST_VERSION,
      pid: process.pid,
      entry: entry,
      serverDir: serverDir.replace(/\\/g, "/"),
      bootId: bootId,
      armedAt: Date.now(),
    });
    safeLog("已就绪 · 静态数据可直接重载（pid " + process.pid + "）");

    /**
     * 服务端模块级派生缓存的重置入口。
     *
     * 静态表之上几乎每个模块都自己再建一层索引（`if (cached) return cached`），而且
     * **大多没有对外重置入口** —— 那份索引就是「改了盘、游戏里还是旧值」的根因。
     * 这里只登记服务端**自己导出**的 `clear* / reset* / refresh*` 钩子：
     * 调用前先查 `require.cache`，模块没被加载过就跳过（未加载 = 还没建缓存，
     * 主动 require 只会把冷模块提前拉起来并触发它的顶层副作用）。
     *
     * 没有钩子的表，启动器如实标成「需重启服务端」，见 mod.rs 的 FROZEN_TABLES。
     */
    const DERIVED_RESETS = [
      { tables: ["agentAuthority"], mod: ["src", "services", "agent", "agentAuthority"], fn: "clearCache" },
      { tables: ["clientTypeLists"], mod: ["src", "services", "inventory", "typeListAuthority"], fn: "clearClientTypeListAuthorityCache" },
      { tables: ["explorationAuthority"], mod: ["src", "services", "exploration", "explorationAuthority"], fn: "clearCache" },
      { tables: ["mapTagsAuthority"], mod: ["src", "services", "map", "mapTagsAuthority"], fn: "clearCache" },
      { tables: ["missionAuthority"], mod: ["src", "services", "agent", "missionAuthority"], fn: "clearCache" },
      { tables: ["npcStandingsAuthority"], mod: ["src", "services", "character", "npcStandingsAuthority"], fn: "clearCache" },
      { tables: ["planetSchematics"], mod: ["src", "services", "planet", "planetStaticData"], fn: "clearCaches" },
      { tables: ["stationStandingsRestrictions"], mod: ["src", "services", "_shared", "stationStaticData"], fn: "clearStationStaticDataCache" },
      { tables: ["researchFieldAuthority"], mod: ["src", "services", "agent", "researchAuthority"], fn: "clearResearchAuthorityCaches" },
      { tables: ["evermarksCatalog"], mod: ["src", "services", "evermarks", "evermarksCatalog"], fn: "resetCache" },
      { tables: ["expertSystems"], mod: ["src", "services", "skills", "expertSystems", "expertSystemCatalog"], fn: "refreshExpertSystemCatalog" },
      { tables: ["dbuffCollections"], mod: ["src", "space", "modules", "commandBurstRuntime"], fn: "refreshCommandBurstStaticData" },
      { tables: ["stationGraphicLocators"], mod: ["src", "services", "station", "stationLocatorGeometry"], fn: "clearStationLocatorGeometryCache" },
      { tables: ["structureGraphicLocators"], mod: ["src", "services", "structure", "structureLocatorGeometry"], fn: "clearStructureLocatorGeometryCache" },
      { tables: ["shipInsurancePrices"], mod: ["src", "services", "insurance", "insurancePriceAuthority"], fn: "_testing.resetInsurancePriceCacheForTests" },
      { tables: ["stargateVisualOverrides"], mod: ["src", "space", "stargateVisualOverrides"], fn: "_testing.clearCacheForTests" },
      { tables: ["skillTypes", "typeDogma"], mod: ["src", "services", "skills", "skillState"], fn: "refreshSkillReference" },
    ];

    /* ------------------------------ 重载 ------------------------------ */

    function resolveDataDir(database) {
      const fromModule = database && typeof database._dataDir === "string" ? database._dataDir : "";
      const fromEnv = String(process.env.EVEJS_GAMESTORE_DATA_DIR || "");
      return path.resolve(fromModule || fromEnv || path.join(serverDir, "..", "_local", "gameStore", "data"));
    }

    function sqliteTableSet(database) {
      const raw = database && database._sqliteTables;
      if (raw instanceof Set) return raw;
      if (Array.isArray(raw)) return new Set(raw.map(String));
      return new Set();
    }

    function listAllTables(dataDir) {
      try {
        return fs
          .readdirSync(dataDir, { withFileTypes: true })
          .filter(function (item) {
            return item.isDirectory() && fs.existsSync(path.join(dataDir, item.name, "data.json"));
          })
          .map(function (item) {
            return item.name;
          });
      } catch (error) {
        return [];
      }
    }

    function handle(request) {
      const startedAt = Date.now();
      const out = {
        api: API,
        hostVersion: HOST_VERSION,
        pid: process.pid,
        entry: entry,
        requestId: String((request && request.requestId) || ""),
        bootId: bootId,
        ok: false,
        startedAt: startedAt,
        finishedAt: 0,
        elapsedMs: 0,
        scope: null,
        requestedCount: 0,
        reloaded: [],
        skipped: [],
        failed: [],
        derivedRefreshed: [],
      };

      function finish() {
        out.finishedAt = Date.now();
        out.elapsedMs = out.finishedAt - out.startedAt;
        out.ok = out.failed.length === 0;
        try {
          writeJsonAtomic(resultFile, out);
        } catch (error) {
          safeLog("结果写盘失败：" + ((error && error.message) || error));
        }
        safeLog(
          (out.ok ? "重载完成" : "重载有失败项") +
            " · 成功 " +
            out.reloaded.length +
            " · 跳过 " +
            out.skipped.length +
            " · 失败 " +
            out.failed.length +
            " · " +
            out.elapsedMs +
            "ms",
        );
      }

      try {
        if (String((request && request.bootId) || "") !== bootId) {
          out.failed.push({
            table: "*",
            reason: "STALE_REQUEST",
            error: "这次请求属于上一轮服务端进程，已忽略",
          });
          finish();
          return;
        }

        let database;
        try {
          database = require(path.join(serverDir, "src", "gameStore"));
        } catch (error) {
          out.failed.push({
            table: "*",
            reason: "GAMESTORE_UNAVAILABLE",
            error: String((error && error.message) || error),
          });
          finish();
          return;
        }
        if (!database || typeof database.write !== "function") {
          out.failed.push({
            table: "*",
            reason: "GAMESTORE_UNSUPPORTED",
            error: "这个服务端版本的 gameStore 没有 write()",
          });
          finish();
          return;
        }

        const dataDir = resolveDataDir(database);
        const sqlite = sqliteTableSet(database);
        const rawList = request && Array.isArray(request.tables) ? request.tables : null;
        let requested = rawList
          ? rawList
              .map(function (name) {
                return String(name === null || name === undefined ? "" : name).trim();
              })
              .filter(Boolean)
          : [];
        if (!requested.length) {
          requested = listAllTables(dataDir);
          out.scope = "ALL_STATIC_TABLES";
        } else {
          out.scope = requested.slice();
        }
        out.requestedCount = requested.length;

        const seen = new Set();
        const reloadedTables = [];
        for (const table of requested) {
          if (seen.has(table)) continue;
          seen.add(table);
          if (!/^[A-Za-z0-9_]+$/.test(table)) {
            out.skipped.push({ table: table, reason: "UNSAFE_TABLE_NAME" });
            continue;
          }
          if (sqlite.has(table)) {
            out.skipped.push({ table: table, reason: "SQLITE_RUNTIME_TABLE" });
            continue;
          }
          const file = path.join(dataDir, table, "data.json");
          let text;
          try {
            text = fs.readFileSync(file, "utf8");
          } catch (error) {
            out.skipped.push({ table: table, reason: "DATA_FILE_MISSING" });
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            out.failed.push({
              table: table,
              reason: "INVALID_JSON",
              error: String((error && error.message) || error),
            });
            continue;
          }
          const at = Date.now();
          try {
            const result = database.write(table, "/", parsed);
            if (result && result.success === true) {
              out.reloaded.push({
                table: table,
                bytes: Buffer.byteLength(text, "utf8"),
                ms: Date.now() - at,
              });
              reloadedTables.push(table);
            } else {
              out.failed.push({
                table: table,
                reason: "WRITE_FAILED",
                error: String((result && result.errorMsg) || "WRITE_ERROR"),
                ms: Date.now() - at,
              });
            }
          } catch (error) {
            out.failed.push({
              table: table,
              reason: "WRITE_FAILED",
              error: String((error && error.message) || error),
              ms: Date.now() - at,
            });
          }
        }

        // 派生缓存：静态表之上还有一层通用读缓存 + 一批模块级索引，只清这次真正换掉的那些表。
        if (reloadedTables.length) {
          const reloadedSet = new Set(reloadedTables);
          try {
            const referenceData = require(path.join(serverDir, "src", "services", "_shared", "referenceData"));
            if (referenceData && typeof referenceData.clearReferenceCache === "function") {
              referenceData.clearReferenceCache(reloadedTables);
            }
          } catch (error) {
            /* 没有这层缓存就跳过 */
          }
          for (const spec of DERIVED_RESETS) {
            if (!spec.tables.some(function (name) { return reloadedSet.has(name); })) continue;
            try {
              const file = path.join(serverDir, ...spec.mod);
              const loaded = require.cache[require.resolve(file)];
              // 模块没被加载过就没有缓存可清；主动 require 会拉起它的顶层副作用，不做。
              if (!loaded) continue;
              const parts = spec.fn.split(".");
              let owner = loaded.exports;
              for (let index = 0; index < parts.length - 1; index += 1) {
                owner = owner ? owner[parts[index]] : null;
              }
              const hook = owner ? owner[parts[parts.length - 1]] : null;
              if (typeof hook !== "function") continue;
              hook.call(owner);
              // 带上模块名：好几个模块的钩子都叫 clearCache，只报函数名等于没报。
              out.derivedRefreshed.push(spec.mod[spec.mod.length - 1] + "." + spec.fn);
            } catch (error) {
              /* 防御性：钩子抛错不能连累重载结果 */
            }
          }
        }
      } catch (error) {
        out.failed.push({
          table: "*",
          reason: "HOTRELOAD_ERROR",
          error: String((error && error.message) || error),
        });
      }

      finish();
    }

    /* ------------------------------ 轮询 ------------------------------ */

    let lastSignature = "";
    function requestSignature() {
      try {
        const stat = fs.statSync(requestFile);
        return stat.size + ":" + stat.mtimeMs;
      } catch (error) {
        return "";
      }
    }

    function drain() {
      for (;;) {
        try {
          fs.renameSync(requestFile, processingFile);
        } catch (error) {
          return;
        }
        const request = readJson(processingFile);
        try {
          fs.unlinkSync(processingFile);
        } catch (error) {
          /* 删不掉也无所谓，下次 rename 会覆盖 */
        }
        if (request) handle(request);
      }
    }

    const timer = setInterval(function () {
      const signature = requestSignature();
      if (!signature) {
        lastSignature = "";
        return;
      }
      if (signature === lastSignature) return;
      lastSignature = signature;
      try {
        drain();
      } catch (error) {
        safeLog("轮询出错：" + ((error && error.message) || error));
      }
    }, POLL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch (error) {
    try {
      console.error("[EveJS-HOTRELOAD] host 初始化失败（不影响服务端）：" + ((error && error.message) || error));
    } catch (inner) {
      /* 连 console 都没有就直接放弃 */
    }
  }
})();
