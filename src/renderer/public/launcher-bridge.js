(() => {
  const api = window.api;
  if (!api) {
    console.error("EvEJS bridge: window.api missing");
    return;
  }

  const serviceDefs = [
    { id: "mainServer", key: "node", name: "主服务器", tech: "NODE.JS", icon: "server", ver: "Node", path: "server/", extra: "npm start", port: 26000 },
    { id: "marketServer", key: "market", name: "市场服务", tech: "RUST", icon: "market", ver: "release", path: "market-server.exe", extra: "cargo release", port: 40110 },
    { id: "client", key: "client", name: "游戏客户端", tech: "EXEFILE", icon: "client", ver: "", path: "Play.bat", extra: "exefile.exe", port: 0 }
  ];

  const stateMap = {
    running: "run",
    starting: "pending",
    stopping: "pending",
    error: "err",
    idle: "stop"
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const ensureArrayLength = (array, length, factory) => {
    while (array.length < length) array.push(factory(array.length));
    if (array.length > length) array.length = length;
  };

  let latestServices = [];
  let pendingLaunchCharacterId = "";
  let mainServerStartedAt = 0;
  let nextLogId = 1;
  let lastClientState = null;
  function applyServices(list) {
    latestServices = Array.isArray(list) ? list : [];
    const byId = new Map(latestServices.map((item) => [item.id, item]));
    const mainServer = byId.get("mainServer");
    if (mainServer?.state === "running") {
      if (!mainServerStartedAt) mainServerStartedAt = Date.now();
    } else if (mainServer?.state !== "starting") {
      mainServerStartedAt = 0;
    }
    const clientInfo = byId.get("client");
    const clientState = clientInfo?.state ?? null;
    if (
      lastClientState &&
      (lastClientState === "running" || lastClientState === "starting") &&
      (clientState === "idle" || clientState === "error")
    ) {
      // 客户端退出：可能刚在游戏里创建了新角色，刷新账号列表
      void loadAccountsFromBackend();
    }
    if (clientState) lastClientState = clientState;

    ensureArrayLength(SVC, serviceDefs.length, (index) => ({ ...serviceDefs[index], state: "stop" }));
    serviceDefs.forEach((def, index) => {
      const info = byId.get(def.id) || {};
      Object.assign(SVC[index], def, {
        state: stateMap[info.state] || "stop",
        extra: info.message || def.extra
      });
    });
    renderSvcCards();
    updateSvcStatus();
    updateLaunchButtonState();
    updateAlerts();
  }

  function updateLaunchButtonState() {
    const eligible = SVC.filter((item) => item.key === "node" || item.key === "market");
    const running = eligible.filter((item) => item.state === "run").length;
    const busy = eligible.some((item) => item.state === "pending");
    if (busy) setLaunchBtn("starting");
    else if (running === eligible.length) setLaunchBtn("running");
    else setLaunchBtn("idle");
  }

  async function refreshServices() {
    try {
      applyServices(await api.servicesList());
    } catch (error) {
      console.error("servicesList failed", error);
    }
  }

  toggleSvc = function (index) {
    const def = serviceDefs[index];
    const item = SVC[index];
    if (!def || !item) return;
    const start = item.state !== "run";
    item.state = "pending";
    renderSvcCards();
    updateSvcStatus();
    (start ? api.serviceStart(def.id) : api.serviceStop(def.id))
      .then((result) => {
        if (!result?.ok) toast(`${item.name}: ${result?.reason || t("操作失败")}`, "err");
      })
      .catch((error) => toast(`${item.name}: ${String(error)}`, "err"))
      .finally(refreshServices);
  };

  startAllServices = async function () {
    if (launching) return;
    launching = true;
    setLaunchBtn("starting");
    try {
      const report = await api.envCheck();
      const critical = new Set(["node", "serverDeps", "localDb"]);
      const failed = (report.checks || []).filter((item) => !item.ok && critical.has(item.key));
      if (failed.length) {
        toast(t("关键环境未通过，已中止启动"), "err");
        return;
      }
      const result = await api.engageStart();
      toast(result.ok ? t("一键启动序列完成") : `${t("启动失败")}: ${result.reason}`, result.ok ? "ok" : "err");
    } catch (error) {
      toast(t("一键启动失败") + ": " + String(error), "err");
    } finally {
      launching = false;
      await refreshServices();
    }
  };

  stopAllServices = async function () {
    if (launching) return;
    launching = true;
    setLaunchBtn("stopping");
    try {
      const result = await api.engageStop();
      toast(result.ok ? t("全部服务已停止") : `${t("停止失败")}: ${result.reason}`, result.ok ? "warn" : "err");
    } catch (error) {
      toast(t("停止失败") + ": " + String(error), "err");
    } finally {
      launching = false;
      await refreshServices();
    }
  };

  LOGS.sys.length = 0;
  LOGS.node.length = 0;
  LOGS.market.length = 0;
  LOGS.client.length = 0;
  pushRandomLog = function () {};
  seedLogs = function () {};

  const tabToLog = { system: "sys", mainServer: "node", market: "market", client: "client" };
  const ansiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

  function ansiClass(code) {
    if ([31, 91].includes(code)) return "ansi-red";
    if ([32, 92].includes(code)) return "ansi-green";
    if ([33, 93].includes(code)) return "ansi-yellow";
    if ([34, 94].includes(code)) return "ansi-blue";
    if ([35, 95].includes(code)) return "ansi-magenta";
    if ([36, 96].includes(code)) return "ansi-cyan";
    if ([37, 97].includes(code)) return "ansi-white";
    if ([90, 2].includes(code)) return "ansi-gray";
    return null;
  }

  function colorizeAnsi(rawLine) {
    let html = "";
    let activeClass = "";
    let lastIndex = 0;
    const re = /\x1b\[([0-9;]*)m/g;
    let match;
    const append = (text) => {
      if (!text) return;
      html += activeClass ? `<span class="${activeClass}">${esc(text)}</span>` : esc(text);
    };
    while ((match = re.exec(rawLine))) {
      append(rawLine.slice(lastIndex, match.index));
      const codes = match[1].split(";").filter(Boolean).map(Number);
      if (!codes.length || codes.includes(0)) activeClass = "";
      for (const code of codes) {
        if (code === 0) { activeClass = ""; continue; }
        const cls = ansiClass(code);
        if (cls) activeClass = cls;
      }
      lastIndex = re.lastIndex;
    }
    append(rawLine.slice(lastIndex));
    return html;
  }

  function colorizeAddresses(html) {
    html = html.replace(/\b((?:\d{1,3}\.){3}\d{1,3})(?::(\d{2,5}))?\b/g, (match, ip, port) => {
      return `<span class="ip">${ip}</span>${port ? ':<span class="port">' + port + '</span>' : ""}`;
    });
    html = html.replace(/\b(port|端口)\s*[:=：]?\s*(\d{2,5})\b/gi, '$1 <span class="port">$2</span>');
    html = html.replace(/(^|[\s(]):(\d{2,5})\b/g, '$1:<span class="port">$2</span>');
    html = html.replace(/(exit\s*code\s*)(-?\d+)/gi, '$1<span class="exit-code">$2</span>');
    return html;
  }

  function formatLogMessage(rawLine, severity, useAnsi) {
    const plain = String(rawLine ?? "").replace(ansiPattern, "");
    let level = severity || "INFO";
    if (/进程退出|exit\s*code/i.test(plain)) level = "ERR";
    let html = useAnsi ? colorizeAnsi(rawLine) : esc(rawLine);
    html = colorizeAddresses(html);
    if (level === "ERR") return `<span class="log-err">${html}</span>`;
    if (level === "WARN") return `<span class="log-warn">${html}</span>`;
    return html;
  }

  /** 模组加载/跳过日志：在模组名后加彩色 MOD 徽章，便于在系统日志里一眼区分 */
  const MOD_LOAD_LINE = /^\[主服务器\]\s+·\s+(.+?)\s*$/;
  const MOD_SKIP_LINE = /^\[主服务器\]\s+跳过模组\s+(.+?)\s*[:：]\s*(.+)$/;
  function decorateModLine(plainLine) {
    const load = MOD_LOAD_LINE.exec(plainLine);
    if (load) {
      return '<span class="hi">[主服务器]</span> · <span class="mod-name-inline">' + esc(load[1]) + '</span><span class="mod-tag">MOD</span>';
    }
    const skip = MOD_SKIP_LINE.exec(plainLine);
    if (skip) {
      return '<span class="hi">[主服务器]</span> 跳过模组 <span class="mod-name-inline">' + esc(skip[1]) + '</span><span class="mod-tag skip">MOD</span>：' + esc(skip[2]);
    }
    return null;
  }

  function appendTerminalData(tabId, data) {
    const category = tabToLog[tabId] || "sys";
    const text = String(data ?? "").replace(/\r/g, "");
    text.split("\n").filter((line) => line.length > 0).forEach((rawLine) => {
      const plainLine = rawLine.replace(ansiPattern, "");
      const upper = plainLine.toUpperCase();
      let level = "INFO";
      if (upper.includes("ERROR") || upper.includes("ERR ") || upper.includes("FAIL")) level = "ERR";
      else if (upper.includes("WARN")) level = "WARN";
      else if (upper.includes(" OK ") || upper.startsWith("OK ") || upper.includes("READY")) level = "OK";
      else if (upper.includes("SYS")) level = "SYS";
      const decorated = decorateModLine(plainLine);
      logTo(category, level, decorated || formatLogMessage(rawLine, level, true));
    });
  }

  api.onModDownloadProgress((p) => {
    if (!p || !p.id) return;
    MARKET_PROGRESS[p.id] = typeof p.percent === "number" ? p.percent : Math.min(99, Math.round((p.downloaded / Math.max(p.total || p.downloaded, 1)) * 100));
    if (MOD_TAB === "market") renderMarket();
  });
  api.onServicesChanged(applyServices);
  api.onTerminalData(appendTerminalData);
  api.onTerminalExit((tabId, code) => appendTerminalData(tabId, `[进程退出] exit code ${code}\n`));
  const mockLogFragments = [
    "cluster[TRANQUILITY]", "launcher env check", "backup snapshot verified", "memory pressure",
    "market engine (rust) ready", "matched ", "esi-bridge synced", "exefile patched",
    "client handshake", "client reconnect from"
  ];
  for (const category of Object.keys(LOGS)) {
    LOGS[category] = LOGS[category].filter((line) => !mockLogFragments.some((fragment) => String(line.msg || "").includes(fragment)));
  }

  LOGS.server = LOGS.server || [];
  curFullLog = "server";

  const baseLogTo = logTo;
  logTo = function (cat, lvl, msg) {
    if (!LOGS[cat]) LOGS[cat] = [];
    LOGS[cat].push({ id: nextLogId++, ts: ts(), lvl, msg });
    if (LOGS[cat].length > 200) LOGS[cat].shift();
    if (cat === curDashLog) renderLog("dashConsole", cat);
    updateLogCounts();
  };

  const consoleInput = document.getElementById("cmdInput");
  if (consoleInput) {
    const readonlyInput = consoleInput.cloneNode(true);
    readonlyInput.value = "";
    readonlyInput.readOnly = true;
    readonlyInput.placeholder = "服务器日志只读模式";
    consoleInput.replaceWith(readonlyInput);
  }

  function serverLogLevel(line) {
    const upper = String(line).toUpperCase();
    if (upper.includes(" ERROR ") || upper.includes("[ERR") || upper.includes("FAIL")) return "ERR";
    if (upper.includes(" WARN ") || upper.includes("[WRN") || upper.includes("WARN")) return "WARN";
    if (upper.includes(" OK ") || upper.includes("[SUC") || upper.includes("SUCCESS")) return "OK";
    return "INFO";
  }

  async function pollServerLog() {
    try {
      const result = await api.readServerLog();
      const lines = result?.exists ? (result.lines || []).slice(-5000) : [];
      LOGS.server = lines.map((line, index) => { const level = serverLogLevel(line); return { id: `server:${index}`, ts: "", lvl: level, msg: formatLogMessage(line, level, false) }; });
      const counter = document.getElementById("cntServer");
      if (counter) counter.textContent = String(lines.length);
      renderLog("fullConsole", "server");
    } catch (error) {
      console.error("readServerLog failed", error);
    }
  }

  setInterval(pollServerLog, 1000);
  pollServerLog();

  window.__eveBridge = { applyServices, refreshServices, appendTerminalData };
  const envKeyMap = {
    serverDeps: "deps",
    localDb: "db",
    market: "market",
    clientPath: "client",
    caCert: "ca"
  };
  const envInitMessages = {
    deps: "npm ci · 安装主服务器依赖",
    db: "CreateDatabase.bat /force · 初始化数据库",
    market: "cargo build --release · 构建市场服务",
    client: "自动探测 EVE 客户端路径",
    ca: "打开 ClientSETUP 证书与补丁向导"
  };

  function envStatus(item) {
    if (item.ok) return "ok";
    if (item.initKey) return "pending";
    return item.warn ? "pending" : "fail";
  }

  function applyEnvReport(report) {
    ENV.length = 0;
    if (report?.sys) {
      ENV.push({
        name: "系统资源",
        detail: report.sys.message,
        status: report.sys.level === "ok" ? "ok" : (report.sys.level === "warn" ? "pending" : "fail"),
        _key: "system"
      });
    }
    for (const item of report?.checks || []) {
      const initKey = envKeyMap[item.key] || item.initKey || null;
      ENV.push({
        name: item.label,
        detail: item.message,
        status: envStatus({ ...item, initKey }),
        _key: item.key,
        _initKey: initKey,
        initMsg: initKey ? envInitMessages[initKey] || item.hint || "初始化" : "初始化"
      });
    }
    renderEnvCheck();
    const pass = ENV.filter((item) => item.status === "ok").length;
    const status = document.getElementById("sbEnv");
    if (status) status.textContent = `环境自检 ${pass}/${ENV.length}`;
  }

  runEnvCheck = async function () {
    const list = document.getElementById("checkList");
    if (list) list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--txt-mute);font-family:Share Tech Mono">扫描中…</div>';
    try {
      applyEnvReport(await api.envCheck());
      toast(t("环境自检完成"), "ok");
    } catch (error) {
      toast(t("环境自检失败") + ": " + String(error), "err");
      renderEnvCheck();
    }
  };

  initEnvItem = async function (index) {
    const item = ENV[index];
    if (!item || !item._initKey) {
      toast(t("该项暂不支持启动器内初始化"), "warn");
      return;
    }
    item.status = "init";
    item.progress = 0;
    item._overrideDetail = (item.initMsg || "初始化") + " · 进行中…";
    renderEnvCheck();
    const result = await api.initRun(item._initKey);
    if (!result?.ok) {
      item.status = "fail";
      item._overrideDetail = result?.reason || "初始化启动失败";
      renderEnvCheck();
    }
  };

  initAllEnv = async function () {
    const pending = ENV.map((item, index) => ({ item, index })).filter(({ item }) => item.status === "pending" && item._initKey);
    if (!pending.length) {
      toast(t("当前没有可初始化项目"), "ok");
      return;
    }
    for (const { index } of pending) {
      await initEnvItem(index);
      while (true) {
        const state = await api.initState();
        if (!state?.busy) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await api.envCheck().then(applyEnvReport);
    }
  };

  api.onInitChanged((state) => {
    if (!state?.busy) {
      api.envCheck().then(applyEnvReport).catch(() => {});
      return;
    }
    const entry = ENV.find((item) => item._initKey === state.key);
    if (entry) {
      entry.status = "init";
      entry.progress = state.progress ?? 0;
      entry._overrideDetail = state.message || state.label || "初始化中…";
      renderEnvCheck();
    }
  });
  function mapAccountToUI(account, index) {
    const roles = Array.isArray(account.roles) ? account.roles : [];
    const numberText = (value) => Number(value || 0).toLocaleString("en-US");
    return {
      id: account.accountKey,
      name: account.accountKey,
      gm: !!account.isGM,
      hasCredential: !!account.hasStoredCredential,
      expanded: index === 0,
      chars: roles.map((role) => ({
        id: role.characterId,
        name: role.characterName || role.characterId || "未知角色",
        avatar: role.avatar || "",
        ship: role.shipName || "未知舰船",
        status: account.banned ? "offline" : "ready",
        sp: numberText(role.skillPoints),
        isk: numberText(role.isk),
        location: role.location?.label || "—",
        security: role.securityStatus == null ? "—" : Number(role.securityStatus).toFixed(2)
      }))
    };
  }

  async function loadAccountsFromBackend() {
    try {
      const result = await api.accountsList();
      if (!result?.ok) {
        toast(result?.reason || t("账号读取失败"), "err");
        return;
      }
      ACC.length = 0;
      (result.data || []).forEach((account, index) => ACC.push(mapAccountToUI(account, index)));
      accExpanded = {};
      renderAccounts();
    } catch (error) {
      toast(t("账号读取失败") + ": " + String(error), "err");
    }
  }

  delAccount = async function (index) {
    const account = ACC[index];
    if (!account) return;
    try {
      const running = await api.accountsCheckRunning();
      if (running?.running) {
        toast(t("服务运行中，请先停止全部服务"), "warn");
        return;
      }
      const preview = await api.accountsDelete(account.id, false);
      const text = preview?.output || preview?.reason || "确认删除该账号及其全部角色？";
      if (!window.confirm(text)) return;
      const result = await api.accountsDelete(account.id, true);
      if (!result?.ok) {
        toast(result?.reason || t("删除失败"), "err");
        return;
      }
      toast(t("账号已删除，备份已生成"), "warn");
      await loadAccountsFromBackend();
    } catch (error) {
      toast(t("删除失败") + ": " + String(error), "err");
    }
  };

  addAccount = function () {
    const modal = document.getElementById("addAccountModal");
    if (!modal) return;
    const user = document.getElementById("newAccountUser");
    const password = document.getElementById("newAccountPass");
    const password2 = document.getElementById("newAccountPass2");
    const gm = document.getElementById("newAccountGm");
    if (user) user.value = "";
    if (password) password.value = "";
    if (password2) password2.value = "";
    if (gm) gm.classList.remove("on");
    modal.classList.add("open");
  };

  submitAddAccount = async function () {
    const user = (document.getElementById("newAccountUser")?.value || "").trim();
    const password = document.getElementById("newAccountPass")?.value || "";
    const password2 = document.getElementById("newAccountPass2")?.value || "";
    const isGM = !!document.getElementById("newAccountGm")?.classList.contains("on");
    if (!user) { toast(t("请输入账号名"), "err"); return; }
    if (password.length < 4) { toast(t("密码至少 4 位"), "err"); return; }
    if (password !== password2) { toast(t("两次密码不一致"), "err"); return; }
    const button = document.getElementById("createAccountBtn");
    if (button) button.disabled = true;
    try {
      const result = await api.accountsCreate(user, password, isGM);
      if (!result?.ok) throw new Error(result?.reason || "创建账号失败");
      closeModal("addAccountModal");
      toast(t("账号") + " " + user + " " + t("已创建") + (isGM ? " · " + t("GM 权限") : ""), "ok");
      logTo("sys", "OK", `账号 <span class="hi">${esc(user)}</span> 已创建${isGM ? " · GM" : ""}`);
      await loadAccountsFromBackend();
    } catch (error) {
      toast(String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  };
  addChar = async function (index) {
    const account = ACC[index];
    if (!account) return;
    if (account.hasCredential) {
      try {
        toast(`${account.name} · ${t("进入角色创建")}`, "ok");
        const result = await api.accountsLaunch(account.name);
        if (!result?.ok) throw new Error(result?.reason || "客户端启动失败");
        logTo("sys", "OK", `账号 <span class="hi">${esc(account.name)}</span> · 已进入角色选择，点击空槽位即可创建角色`);
      } catch (error) {
        toast(`${t("进入角色创建失败")}: ${String(error)}`, "err");
      }
      return;
    }
    const modal = document.getElementById("createCharacterModal");
    const accountField = document.getElementById("createAccountName");
    const password = document.getElementById("createAccountPassword");
    if (!modal || !accountField || !password) return;
    accountField.value = account.name;
    password.value = "";
    modal.classList.add("open");
    setTimeout(() => password.focus(), 80);
  };

  submitCreateCharacter = async function () {
    const accountName = document.getElementById("createAccountName")?.value || "";
    const password = document.getElementById("createAccountPassword")?.value || "";
    if (!password) {
      toast(t("请输入账号密码"), "err");
      return;
    }
    const button = document.getElementById("createCharacterBtn");
    if (button) button.disabled = true;
    try {
      const result = await api.loginStart(accountName, password, true);
      if (!result?.ok) throw new Error(result?.reason || "客户端启动失败");
      closeModal("createCharacterModal");
      toast(`${accountName} · ${t("进入角色创建")}`, "ok");
      logTo("sys", "OK", `账号 <span class="hi">${esc(accountName)}</span> · 已进入角色选择，点击空槽位即可创建角色`);
    } catch (error) {
      toast(String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  };
  delChar = function () {
    toast(t("请通过账号删除流程处理角色数据"), "warn");
  };
  launchChar = async function (accountName, characterName, characterId) {
    const accountRecord = ACC.find((item) => item.name === accountName);
    const roleRecord = accountRecord?.chars?.find((item) => item.name === characterName);
    const targetCharacterId = String(characterId || roleRecord?.id || "");
    pendingLaunchCharacterId = targetCharacterId;
    if (accountRecord?.hasCredential) {
      try {
        toast(`${characterName} · ${t("直达角色启动中")}`, "ok");
        const result = await api.accountsLaunch(accountName, targetCharacterId);
        if (!result?.ok) throw new Error(result?.reason || "自动登录失败");
        logTo("sys", "OK", `启动角色 <span class="hi">${esc(characterName)}</span> · 账号 ${esc(accountName)} · 已保存凭据直达角色`);
      } catch (error) {
        toast(`${t("自动登录失败")}: ${String(error)}`, "err");
      }
      return;
    }
    const modal = document.getElementById("launchCharacterModal");
    const account = document.getElementById("launchAccountName");
    const character = document.getElementById("launchCharacterName");
    const password = document.getElementById("launchAccountPassword");
    if (!modal || !account || !character || !password) return;
    account.value = accountName;
    character.value = characterName;
    password.value = "";
    modal.classList.add("open");
    setTimeout(() => password.focus(), 80);
  };

  submitCharacterLaunch = async function () {
    const accountName = document.getElementById("launchAccountName")?.value || "";
    const characterName = document.getElementById("launchCharacterName")?.value || "";
    const password = document.getElementById("launchAccountPassword")?.value || "";
    if (!password) {
      toast(t("请输入账号密码"), "err");
      return;
    }
    const button = document.getElementById("launchCharacterBtn");
    if (button) button.disabled = true;
    try {
      const result = await api.loginStart(accountName, password, true, pendingLaunchCharacterId);
      if (!result?.ok) throw new Error(result?.reason || "客户端启动失败");
      closeModal("launchCharacterModal");
      toast(`${characterName} · ${t("客户端直达角色中")}`, "ok");
      logTo("sys", "OK", `启动角色 <span class="hi">${esc(characterName)}</span> · 账号 ${esc(accountName)} · 直达角色`);
    } catch (error) {
      toast(String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  };

  doLogin = async function () {
    const user = (document.getElementById("loginUser")?.value || "").trim();
    const password = document.getElementById("loginPass")?.value || "";
    const meta = document.getElementById("loginMeta");
    if (!user || !password) {
      toast(t("请输入账号和密码"), "err");
      return;
    }
    if (meta) meta.textContent = "● VERIFYING";
    try {
      const verify = await api.accountsVerify(user, password);
      if (!verify?.ok) throw new Error(verify?.reason || "账号或密码错误");
      const result = await api.loginStart(user, password);
      if (!result?.ok) throw new Error(result?.reason || "客户端启动失败");
      if (meta) meta.textContent = `● LOGGED IN · ${user}`;
      toast(t("登录成功") + " · " + t("客户端启动中"), "ok");
      logTo("sys", "OK", `登录成功 · <span class="hi">${esc(user)}</span> · 直达角色选择`);
    } catch (error) {
      if (meta) meta.textContent = "● LOGIN FAILED";
      toast(String(error), "err");
    }
  };

  doChangePwd = async function () {
    const user = (document.getElementById("loginUser")?.value || "").trim();
    const oldPassword = document.getElementById("pwdOld")?.value || "";
    const newPassword = document.getElementById("pwdNew")?.value || "";
    const confirmPassword = document.getElementById("pwdNew2")?.value || "";
    if (!user || !oldPassword || !newPassword) {
      toast(t("请填写完整"), "err");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast(t("两次新密码不一致"), "err");
      return;
    }
    const result = await api.accountsSetPassword(user, oldPassword, newPassword);
    if (!result?.ok) {
      toast(result?.reason || t("修改失败"), "err");
      return;
    }
    toast(t("密码已修改，立即生效"), "ok");
    logTo("sys", "OK", "密码已修改 · 需重新登录");
    setTimeout(flipLogin, 600);
  };

  function setInput(id, value) {
    const input = document.getElementById(id);
    if (input && value != null) input.value = value;
  }

  async function loadConfigFromBackend() {
    try {
      const [config, appInfo, settings] = await Promise.all([api.getConfig(), api.appInfo(), api.settingsGet()]);
      setInput("cfgGamePort", config?.server?.ports?.game);
      setInput("cfgImagesPort", config?.server?.ports?.images);
      setInput("cfgGatewayPort", config?.server?.ports?.gateway);
      setInput("cfgServerSource", config?.server?.sourceFile);
      setInput("cfgServerRoot", appInfo?.repoRoot);

    // 顶部品牌行与更新弹窗的「当前版本」用真实运行版本（以前写死，导致版本号一直不更新）
    const appVer = String(appInfo?.version || "").trim();
    if (appVer) {
      CURRENT_VER = "v" + appVer.replace(/^v/i, "");
      document.querySelectorAll(".logo-text .t2").forEach((el) => {
        el.textContent = "SERVER LAUNCHER · " + CURRENT_VER;
      });
    }
      setInput("cfgClientPath", config?.client?.clientPath);
      setInput("cfgClientExe", config?.client?.clientExe);
      setInput("cfgCaPem", config?.client?.caPem);
      setInput("cfgProxyUrl", config?.client?.proxyUrl);
      setInput("cfgClientSource", config?.client?.sourceFile);
      const evejsVersionEl = document.getElementById("sbEvejs");
      if (evejsVersionEl) {
        const serverVersion = String(appInfo?.evejsVersion || "").trim();
        evejsVersionEl.textContent = serverVersion ? "v" + serverVersion : "—";
        evejsVersionEl.title = serverVersion ? "EveJS server " + serverVersion : "EveJS version not detected";
      }
      const serverMeta = document.getElementById("cfgServerMeta");
      if (serverMeta) serverMeta.textContent = config?.server?.sourceFile || "";
      const clientMeta = document.getElementById("cfgClientMeta");
      if (clientMeta) clientMeta.textContent = config?.client?.clientPath || "";
      const statusPath = document.getElementById("sbPath");
      if (statusPath) statusPath.textContent = appInfo?.repoRoot || "";
      setCheckbox("cfgStartMarket", settings?.startMarket !== false);
      setCheckbox("cfgAutoLogin", settings?.autoLogin === true);
      setCheckbox("cfgSafeWindowed", String(config?.client?.safeWindowed || "off").trim().toLowerCase() === "on");
    } catch (error) {
      toast(t("配置读取失败") + ": " + String(error), "err");
    }
  }

  function setCheckbox(id, on) {
    const element = document.getElementById(id);
    if (element) element.classList.toggle("on", !!on);
  }

  const databaseState = {
    tables: [],
    table: "",
    rows: [],
    columns: [],
    primaryKeys: [],
    total: 0,
    page: 0,
    pageSize: 50,
    selectedIndex: -1,
    isNew: false,
    tab: "data"
  };

  function databaseSize(value) {
    const bytes = Number(value || 0);
    if (!bytes) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function databaseValueText(value) {
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function databaseCellText(value) {
    const text = databaseValueText(value).replace(/\s+/g, " ");
    return text.length > 120 ? text.slice(0, 117) + "…" : text;
  }

  function databasePrimaryKeyText(row, index) {
    if (!databaseState.primaryKeys.length) return `row ${index + 1}`;
    return databaseState.primaryKeys.map((key) => `${key.name}=${databaseValueText(row[key.name]) || "—"}`).join(" · ");
  }

  function renderDatabaseTableList() {
    const list = document.getElementById("dbTableList");
    if (!list) return;
    const query = String(document.getElementById("dbTableSearch")?.value || "").trim().toLowerCase();
    const tables = databaseState.tables.filter((table) => !query || table.name.toLowerCase().includes(query));
    list.innerHTML = tables.map((table) => `
      <button class="db-table-item ${table.name === databaseState.table ? "active" : ""}" onclick="selectDatabaseTable('${esc(table.name)}')">
        <span class="n">${esc(table.name)}</span><span class="c">${Number(table.rows || 0).toLocaleString()}</span>
      </button>`).join("");
    const badge = document.getElementById("dbTableCountBadge");
    if (badge) badge.textContent = String(databaseState.tables.length);
  }

  loadDatabaseOverview = async function () {
    try {
      const result = await api.databaseOverview();
      if (!result?.ok) {
        toast(result?.reason || t("数据库读取失败"), "err");
        return;
      }
      databaseState.tables = Array.isArray(result.tables) ? result.tables : [];
      const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
      setText("dbSize", databaseSize(result.sizeBytes));
      setText("dbTableCount", Number(result.tableCount || 0).toLocaleString());
      setText("dbRowCount", Number(result.totalRows || 0).toLocaleString());
      setText("dbJournal", String(result.journalMode || "unknown").toUpperCase());
      setText("dbPath", result.path || "");
      renderDatabaseTableList();
      if (!databaseState.table && databaseState.tables.length) await selectDatabaseTable(databaseState.tables[0].name);
    } catch (error) {
      toast(t("数据库读取失败") + ": " + String(error), "err");
    }
  };

  selectDatabaseTable = async function (table) {
    databaseState.table = String(table || "");
    databaseState.page = 0;
    databaseState.selectedIndex = -1;
    databaseState.isNew = false;
    renderDatabaseTableList();
    await loadDatabaseTable();
  };

  loadDatabaseTable = async function () {
    if (!databaseState.table) return;
    try {
      const result = await api.databaseTable(databaseState.table, databaseState.pageSize, databaseState.page * databaseState.pageSize);
      if (!result?.ok) {
        toast(result?.reason || t("数据表读取失败"), "err");
        return;
      }
      databaseState.rows = Array.isArray(result.rows) ? result.rows : [];
      databaseState.columns = Array.isArray(result.columns) ? result.columns : [];
      databaseState.primaryKeys = Array.isArray(result.primaryKeys) ? result.primaryKeys : [];
      databaseState.total = Number(result.total || 0);
      databaseState.selectedIndex = -1;
      databaseState.isNew = false;
      const title = document.getElementById("dbEditorTitle");
      if (title) title.textContent = databaseState.table;
      const meta = document.getElementById("dbEditorMeta");
      if (meta) meta.textContent = `${databaseState.total.toLocaleString()} ROWS · ${databaseState.columns.length} COLUMNS · page ${databaseState.page + 1}`;
      renderDatabaseRows();
      renderDatabaseStructure();
      renderDatabaseSql();
      renderDatabaseInspector();
      if (databaseState.rows.length) selectDatabaseRow(0);
      const refresh = document.getElementById("dbRefreshTableBtn");
      if (refresh) refresh.disabled = false;
      const add = document.getElementById("dbNewRowBtn");
      if (add) add.disabled = false;
      const backup = document.getElementById("dbBackupBtn");
      if (backup) backup.disabled = false;
      updateDatabasePager();
    } catch (error) {
      toast(t("数据表读取失败") + ": " + String(error), "err");
    }
  };

  function updateDatabasePager() {
    const pageCount = Math.max(1, Math.ceil(databaseState.total / databaseState.pageSize));
    const info = document.getElementById("dbPageInfo");
    if (info) info.textContent = `${databaseState.page + 1} / ${pageCount}`;
    const prev = document.getElementById("dbPagePrev");
    if (prev) prev.disabled = databaseState.page <= 0;
    const next = document.getElementById("dbPageNext");
    if (next) next.disabled = databaseState.page >= pageCount - 1;
  }

  databasePage = function (delta) {
    const pageCount = Math.max(1, Math.ceil(databaseState.total / databaseState.pageSize));
    databaseState.page = Math.max(0, Math.min(pageCount - 1, databaseState.page + delta));
    loadDatabaseTable();
  };

  renderDatabaseRows = function () {
    const head = document.getElementById("dbGridHead");
    const body = document.getElementById("dbGridBody");
    if (!head || !body) return;
    const filter = String(document.getElementById("dbRowFilter")?.value || "").trim().toLowerCase();
    const columns = databaseState.columns;
    head.innerHTML = `<tr><th style="width:42px">#</th>${columns.map((column) => `<th>${esc(column.name)}<span style="color:var(--txt-mute);margin-left:4px">${esc(column.type || "")}</span></th>`).join("")}</tr>`;
    const rows = databaseState.rows.filter((row) => !filter || JSON.stringify(row).toLowerCase().includes(filter));
    body.innerHTML = rows.map((row, index) => {
      const originalIndex = databaseState.rows.indexOf(row);
      const cells = columns.map((column) => `<td class="${column.pk ? "pk" : ""} title="${esc(databaseCellText(row[column.name]))}">${esc(databaseCellText(row[column.name])) || "—"}</td>`).join("");
      return `<tr class="${databaseState.selectedIndex === originalIndex ? "active" : ""}" onclick="selectDatabaseRow(${originalIndex})"><td>${originalIndex + 1}</td>${cells}</tr>`;
    }).join("");
  };

  renderDatabaseStructure = function () {
    const body = document.getElementById("dbStructureBody");
    if (!body) return;
    body.innerHTML = databaseState.columns.map((column) => `<tr><td class="mono">${esc(column.name)}</td><td class="mono">${esc(column.type || "")}</td><td class="mono">${column.pk ? "YES" : ""}</td><td class="mono">${column.notnull ? "YES" : ""}</td><td class="mono">${esc(column.dflt_value ?? "")}</td></tr>`).join("");
  };

  renderDatabaseSql = function () {
    const editor = document.getElementById("dbSqlPreview");
    if (!editor) return;
    const table = databaseState.table;
    editor.value = table ? `SELECT *\nFROM "${table}"\nLIMIT ${databaseState.pageSize} OFFSET ${databaseState.page * databaseState.pageSize};\n\n-- SQL 仅用于查看，编辑请使用数据表详情表单` : "";
  };

  switchDatabaseTab = function (tab) {
    databaseState.tab = tab || "data";
    document.querySelectorAll("#dbTabs .db-tab").forEach((button) => button.classList.toggle("active", button.dataset.dbTab === databaseState.tab));
    for (const name of ["data", "structure", "sql"]) {
      const panel = document.getElementById(`dbTab${name[0].toUpperCase()}${name.slice(1)}`);
      if (panel) panel.style.display = name === databaseState.tab ? "flex" : "none";
    }
  };

  selectDatabaseRow = function (index) {
    const row = databaseState.rows[index];
    if (!row) return;
    databaseState.selectedIndex = index;
    databaseState.isNew = false;
    renderDatabaseRows();
    renderDatabaseInspector();
  };

  function renderDatabaseInspector() {
    const fields = document.getElementById("dbInspectorFields");
    const hint = document.getElementById("dbInspectorHint");
    const save = document.getElementById("dbSaveRowBtn");
    const remove = document.getElementById("dbDeleteRowBtn");
    if (!fields) return;
    const row = databaseState.selectedIndex >= 0 ? databaseState.rows[databaseState.selectedIndex] : null;
    if (!row && !databaseState.isNew) {
      fields.innerHTML = `<div class="db-empty">选择一行查看字段</div>`;
      if (hint) hint.textContent = "未选择";
      if (save) save.disabled = true;
      if (remove) remove.disabled = true;
      return;
    }
    const values = databaseState.isNew ? databaseState.newRow || {} : row;
    fields.innerHTML = databaseState.columns.map((column) => {
      const value = databaseValueText(values[column.name]);
      const long = column.name === "json" || value.length > 120;
      const label = `${esc(column.name)}<span class="pk">${column.pk ? " PK" : ""}</span>`;
      return `<div class="db-field"><label>${label}</label>${long ? `<textarea data-db-field="${esc(column.name)}">${esc(value)}</textarea>` : `<input data-db-field="${esc(column.name)}" value="${esc(value)}">`}</div>`;
    }).join("");
    if (hint) hint.textContent = databaseState.isNew ? "新行" : databasePrimaryKeyText(row, databaseState.selectedIndex);
    if (save) save.disabled = false;
    if (remove) remove.disabled = databaseState.isNew;
  }

  function collectDatabaseFields() {
    const values = {};
    document.querySelectorAll("[data-db-field]").forEach((element) => {
      const name = element.dataset.dbField;
      const raw = element.value;
      const column = databaseState.columns.find((item) => item.name === name);
      let value = raw;
      if (column?.name === "json" || /^\s*[\[{]/.test(raw)) {
        try { value = JSON.parse(raw); } catch { value = raw; }
      }
      values[name] = value;
    });
    return values;
  }

  newDatabaseRow = function () {
    if (!databaseState.table) return;
    const row = {};
    for (const column of databaseState.columns) {
      row[column.name] = column.name === "json" ? "{}" : column.pk && String(column.type || "").toUpperCase().includes("INT") ? 0 : "";
    }
    databaseState.selectedIndex = -1;
    databaseState.isNew = true;
    databaseState.newRow = row;
    renderDatabaseInspector();
  };

  saveDatabaseRow = async function () {
    if (!databaseState.table) return;
    try {
      const values = collectDatabaseFields();
      const result = databaseState.isNew
        ? await api.databaseInsertRow(databaseState.table, values)
        : await api.databaseSaveRow(databaseState.table, values);
      if (!result?.ok) throw new Error(result?.reason || "保存失败");
      toast(`${t("已保存")} ${databaseState.table}`, "ok");
      logTo("sys", "OK", `数据库表 <span class="hi">${esc(databaseState.table)}</span> 已保存`);
      await loadDatabaseTable();
      await loadDatabaseOverview();
    } catch (error) {
      toast(String(error), "err");
    }
  };

  deleteDatabaseRow = async function () {
    if (!databaseState.table || databaseState.selectedIndex < 0) return;
    const row = databaseState.rows[databaseState.selectedIndex];
    if (!row || !window.confirm(`确认删除 ${databaseState.table} 中的这一行？`)) return;
    try {
      const result = await api.databaseDeleteRow(databaseState.table, row);
      if (!result?.ok) throw new Error(result?.reason || t("删除失败"));
      toast(`${t("已删除")} ${databaseState.table} ${t("中的一行")}`, "warn");
      await loadDatabaseTable();
      await loadDatabaseOverview();
    } catch (error) {
      toast(String(error), "err");
    }
  };

  let selectedDatabaseBackup = "";

  createDatabaseBackup = async function () {
    try {
      const result = await api.databaseBackup();
      if (!result?.ok) throw new Error(result?.reason || "备份失败");
      toast(`${t("数据库备份完成")}：${result.name}`, "ok");
      logTo("sys", "OK", `数据库已备份 · <span class="hi">${esc(result.name)}</span>`);
      if (document.getElementById("dbRestoreModal")?.classList.contains("open")) await openDatabaseRestore();
    } catch (error) {
      toast(String(error), "err");
    }
  };

  function renderDatabaseBackupList(result) {
    const list = document.getElementById("dbBackupList");
    if (!list) return;
    const backups = Array.isArray(result?.backups) ? result.backups : [];
    if (!backups.length) {
      list.innerHTML = `<div class="db-empty">暂无数据库备份</div>`;
      const confirm = document.getElementById("dbRestoreConfirmBtn");
      if (confirm) confirm.disabled = true;
      return;
    }
    list.innerHTML = backups.map((backup) => `
      <div class="db-backup-item ${backup.name === selectedDatabaseBackup ? "active" : ""}" data-backup="${esc(backup.name)}" onclick="selectDatabaseBackup(this.dataset.backup)">
        <div class="bi-main"><div class="bi-name">${esc(backup.name)}</div><div class="bi-meta">${new Date(backup.createdAt).toLocaleString()} · ${esc(result.directory || "")}</div></div>
        <div class="bi-size">${databaseSize(backup.sizeBytes)}</div>
      </div>`).join("");
    const confirm = document.getElementById("dbRestoreConfirmBtn");
    if (confirm) confirm.disabled = !selectedDatabaseBackup;
  }

  openDatabaseRestore = async function () {
    selectedDatabaseBackup = "";
    const modal = document.getElementById("dbRestoreModal");
    const list = document.getElementById("dbBackupList");
    if (modal) modal.classList.add("open");
    if (list) list.innerHTML = `<div class="db-empty">正在读取备份…</div>`;
    try {
      const result = await api.databaseBackups();
      if (!result?.ok) throw new Error(result?.reason || "备份列表读取失败");
      renderDatabaseBackupList(result);
    } catch (error) {
      if (list) list.innerHTML = `<div class="db-empty">${esc(String(error))}</div>`;
    }
  };

  selectDatabaseBackup = function (name) {
    selectedDatabaseBackup = String(name || "");
    document.querySelectorAll("#dbBackupList .db-backup-item").forEach((item) => item.classList.toggle("active", item.dataset.backup === selectedDatabaseBackup));
    const confirm = document.getElementById("dbRestoreConfirmBtn");
    if (confirm) confirm.disabled = !selectedDatabaseBackup;
  };

  restoreSelectedDatabaseBackup = async function () {
    if (!selectedDatabaseBackup) return;
    if (!window.confirm(`确认恢复数据库版本 ${selectedDatabaseBackup}？当前数据库会先自动备份。`)) return;
    try {
      const result = await api.databaseRestore(selectedDatabaseBackup);
      if (!result?.ok) throw new Error(result?.reason || "恢复失败");
      closeModal("dbRestoreModal");
      toast(`${t("数据库已恢复到")} ${result.restored}；${t("安全备份")}：${result.safetyBackup}`, "ok");
      logTo("sys", "OK", `数据库已恢复 · <span class="hi">${esc(result.restored)}</span> · 安全备份 ${esc(result.safetyBackup || "")}`);
      await loadDatabaseOverview();
      if (databaseState.table) await loadDatabaseTable();
    } catch (error) {
      toast(String(error), "err");
    }
  };
  function checkboxOn(id) {
    return !!document.getElementById(id)?.classList.contains("on");
  }

  saveConfigFromUI = async function () {
    await api.settingsSet({
      startClient: false,
      startMarket: checkboxOn("cfgStartMarket"),
      autoLogin: checkboxOn("cfgAutoLogin")
    });
    const repoRoot = (document.getElementById("cfgServerRoot")?.value || "").trim();
    if (repoRoot) {
      const rootResult = await api.configSetRepoRoot(repoRoot);
      if (rootResult?.corrected && rootResult.repoRoot) {
        const el = document.getElementById("cfgServerRoot");
        if (el) el.value = rootResult.repoRoot;
        toast(t("服务端根目录已自动修正为") + " " + rootResult.repoRoot, "warn");
      }
      if (!rootResult?.ok) {
        toast(rootResult?.reason || t("服务端根目录保存失败"), "err");
        return;
      }
    }
    const result = await api.configSetClient({
      clientPath: document.getElementById("cfgClientPath")?.value || "",
      clientExe: document.getElementById("cfgClientExe")?.value || "",
      caPem: document.getElementById("cfgCaPem")?.value || "",
      proxyUrl: document.getElementById("cfgProxyUrl")?.value || "",
      safeWindowed: checkboxOn("cfgSafeWindowed") ? "on" : "off"
    });
    if (!result?.ok) {
      toast(result?.reason || t("配置保存失败"), "err");
      return;
    }
    toast(t("配置已保存到") + " " + (result.client?.sourceFile || "EvEJSConfig.bat"), "ok");
    await loadConfigFromBackend();
    await tickMetrics();
  };

  repairClientWindow = async function () {
    const button = document.getElementById("cfgRepairBtn");
    if (button) button.disabled = true;
    toast(t("正在重置游戏窗口显示设置…"), "warn");
    try {
      const result = await api.configRepairClientDisplay();
      if (!result?.ok) throw new Error(result?.reason || "修复失败");
      toast(t("游戏窗口显示设置已重置"), "ok");
      logTo("sys", "OK", "已重置游戏窗口显示设置（窗口模式 · 主屏左上角）");
    } catch (error) {
      toast(t("游戏窗口修复失败") + ": " + String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  };

  /* ============ 作者身份（Ed25519 密钥身份，见 docs/mod-signing-and-marketplace-plan.md §3） ============ */
  let AUTHOR = null;

  function authorName() {
    return (AUTHOR && AUTHOR.author && AUTHOR.author.name) || "";
  }

  function updateAuthorBadge() {
    const label = document.getElementById("authorBtnLabel");
    // 直接用 t() 渲染，避免先写中文再被 translateDOM 翻译造成的瞬间闪烁
    if (label) label.textContent = authorName() ? t(authorName()) : t("作者身份");
  }

  async function loadAuthorProfile() {
    try {
      AUTHOR = await api.authorGet();
    } catch (error) {
      console.error("authorGet failed", error);
    }
    updateAuthorBadge();
    return AUTHOR;
  }

  function fillAuthorDialog() {
    if (!AUTHOR || !AUTHOR.author) return;
    const a = AUTHOR.author;
    const nameInput = document.getElementById("authorNameInput");
    if (nameInput) {
      // 留空让作者自己填；当前署名放在 placeholder 里当提示
      nameInput.value = "";
      if (a.name) nameInput.placeholder = t(a.name);
    }
    const idEl = document.getElementById("authorIdValue");
    if (idEl) idEl.textContent = a.id || "—";
    const keyEl = document.getElementById("authorKeyIdValue");
    if (keyEl) keyEl.textContent = a.keyId || "—";
    const sinceEl = document.getElementById("authorSinceValue");
    if (sinceEl) sinceEl.textContent = a.since ? new Date(a.since).toLocaleString() : "—";
    const stateEl = document.getElementById("authorKeyState");
    if (stateEl) {
      const alive = !!AUTHOR.privateKeyExists;
      stateEl.textContent = alive ? "KEY OK" : "KEY MISSING";
      stateEl.className = "author-state " + (alive ? "ok" : "bad");
    }
    const warnEl = document.getElementById("authorWarn");
    if (warnEl) warnEl.style.display = AUTHOR.privateKeyExists ? "none" : "";
  }

  openAuthorDialog = async function () {
    const modal = document.getElementById("authorModal");
    if (!modal) return;
    modal.classList.add("open");
    await loadAuthorProfile();
    fillAuthorDialog();
    if (typeof autoTranslateAfterRender === "function") autoTranslateAfterRender();
  };

  saveAuthorName = async function () {
    const input = document.getElementById("authorNameInput");
    const name = (input && input.value ? input.value : "").trim();
    if (!name) { toast(t("署名不能为空"), "warn"); return; }
    try {
      const res = await api.authorSetName(name);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("保存失败"));
      AUTHOR = res;
      updateAuthorBadge();
      fillAuthorDialog();
      toast(t("作者身份已更新") + " · " + res.author.name, "ok");
      logTo("sys", "OK", "作者署名已更新为 <span class=\"hi\">" + esc(res.author.name) + "</span>");
    } catch (error) {
      toast(t("保存失败") + ": " + String(error), "err");
    }
  };

  exportAuthorKeyFile = async function () {
    try {
      const res = await api.authorExportKey();
      if (res && res.canceled) return;
      if (!res || !res.ok) throw new Error((res && res.reason) || t("导出失败"));
      toast(t("密钥已导出") + " · " + res.path, "ok");
      logTo("sys", "OK", "作者密钥已导出到 <span class=\"hi\">" + esc(res.path) + "</span> · 含私钥，请妥善保管");
    } catch (error) {
      toast(t("导出密钥失败") + ": " + String(error), "err");
    }
  };

  importAuthorKeyFile = async function () {
    try {
      const res = await api.authorImportKey();
      if (res && res.canceled) return;
      if (!res || !res.ok) throw new Error((res && res.reason) || t("导入失败"));
      await loadAuthorProfile();
      fillAuthorDialog();
      toast(t("密钥已导入") + " · keyId " + res.keyId, "ok");
      logTo("sys", "OK", "作者身份已从密钥文件还原 · keyId <span class=\"hi\">" + esc(res.keyId || "") + "</span>");
    } catch (error) {
      toast(t("导入密钥失败") + ": " + String(error), "err");
    }
  };

  openAuthorKeyFolder = async function () {
    try {
      const res = await api.authorOpenKeyFolder();
      if (!res || !res.ok) throw new Error((res && res.reason) || t("打开失败"));
    } catch (error) {
      toast(String(error), "err");
    }
  };

  copyAuthorId = function () {
    const id = (AUTHOR && AUTHOR.author && AUTHOR.author.id) || "";
    if (!id) return;
    const done = () => toast(t("作者标识已复制"), "ok");
    const fail = () => toast(t("复制失败，请手动选择"), "warn");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(done).catch(fail);
    } else {
      fail();
    }
  };

  /* 模组页签与动作按钮：用脚本绑定，不依赖 inline onclick 的作用域解析 */
  function bindModTabs() {
    const strip = document.getElementById("modTabs");
    if (strip && !strip.dataset.bound) {
      strip.dataset.bound = "1";
      strip.querySelectorAll(".mod-tab").forEach((el) => {
        el.addEventListener("click", () => {
          if (typeof switchModTab === "function") switchModTab(el.dataset.mtab || "installed");
        });
      });
    }
    const actions = [
      ["modActCreate", "openCreateModDialog"],
      ["modActSubmit", "openSubmitModDialog"],
      ["modActAuthor", "openAuthorDialog"],
      ["modActDoc", "openModAuthoringDoc"]
    ];
    actions.forEach(([id, fn]) => {
      const el = document.getElementById(id);
      if (el && !el.dataset.bound) {
        el.dataset.bound = "1";
        el.addEventListener("click", () => {
          const f = window[fn];
          if (typeof f === "function") f();
          else if (typeof window[fn] === "undefined") toast(t("功能还没准备好") + ": " + fn, "warn");
        });
      }
    });
  }
  /* ============ 模组详情弹窗（对应参考图的 MOD 详情） ============ */
  let MOD_DETAIL = null;

  /** 把 README.md 拆成「功能要点」与「详细介绍」；不是我们生成的 README 时退化为整篇正文 */
  function parseReadmeText(text) {
    const out = { highlights: [], readme: "" };
    const raw = String(text || "");
    if (!raw.trim()) return out;
    const lines = raw.split("\n");
    let section = "";
    const body = [];
    const free = [];
    for (const line of lines) {
      const h2 = /^##\s*(.+?)\s*$/.exec(line);
      if (h2) { section = h2[1].trim(); continue; }
      if (/^#\s/.test(line)) continue;
      const bullet = /^[-*]\s+(.+)$/.exec(line);
      if ((/功能要点|Highlights/i.test(section) || (!section && bullet)) && bullet) {
        out.highlights.push(bullet[1].trim());
        continue;
      }
      if (/详细介绍|说明|Details|Description/i.test(section)) body.push(line);
      else if (!section) free.push(line);
    }
    out.readme = (body.length ? body.join("\n") : free.join("\n")).trim().slice(0, 4000);
    out.highlights = out.highlights.slice(0, 12);
    return out;
  }

  /** 索引里的 readme 可能是段落数组也可能是单段文本；两种都能正常渲染 */
  function readmeTextOf(entry) {
    if (!entry) return "";
    if (Array.isArray(entry.readme)) return entry.readme.map((x) => String(x || "").trim()).filter(Boolean).join("\n\n");
    if (typeof entry.readme === "string") return entry.readme.trim();
    return entry.description || "";
  }
  function mdCell(label, value) {
    return '<div class="md-cell"><div class="k">' + esc(t(label)) + '</div><div class="v">' + esc(value == null || value === "" ? "—" : value) + '</div></div>';
  }

  function renderModDetail() {
    const body = document.getElementById("mdBody");
    const title = document.getElementById("mdTitle");
    if (!body || !MOD_DETAIL) return;
    const d = MOD_DETAIL;
    const m = d.mod || d.entry || {};
    const isMarket = d.kind === "market";
    if (title) title.textContent = m.displayName || m.id || t("模组详情");

    const author = (m.author && m.author.name) || "";
    const cat = modCategoryLabel(m);
    const ver = m.version ? "v" + String(m.version).replace(/^v/i, "") : "";
    const localVer = isMarket ? (marketLocalVersion(m.id) ? "v" + marketLocalVersion(m.id) : "") : ver;
    const sub = [author, t(cat), ver].filter(Boolean).join(" · ");

    const chips = [];
    if (!isMarket) {
      // 三态：已签名 / 签名真的不对 / 无法验证（旧包没带作者公钥）——后者不会阻止启用，不能冒充“校验失败”
      if (m.signatureState === "valid") chips.push(['on', t("已签名")]);
      else if (m.signatureState === "invalid" && m.signatureTrusted) chips.push(['bad', t("签名校验失败")]);
      else if (m.signatureState === "invalid") chips.push(['', t("未签名（旧版包未含作者公钥）")]);
      else chips.push(['', t("未签名")]);
      chips.push([m.enabled ? "on" : "", m.enabled ? t("已启用") : t("已停用")]);
    } else {
      const local = marketLocalVersion(m.id);
      chips.push([local ? "" : "on", local ? t("已安装") : t("可安装")]);
      if (local && m.version && local !== m.version) chips.push(["warn", t("可更新")]);
    }
    if (cat) chips.push(["", t(cat)]);
    (Array.isArray(m.tags) ? m.tags : []).forEach((x) => chips.push(["", x]));
    if (m.requiresRestart || m.restart === "game_server") chips.push(["", t("需重启")]);

    const grid = [
      mdCell("最新版本", ver),
      mdCell("本地版本", localVer),
      mdCell("体积", fmtBytes(isMarket ? m.sizeBytes : m.sizeBytes)),
      mdCell("重启要求", (m.requiresRestart || m.restart === "game_server") ? t("需要重启服务端") : t("不需要重启")),
      mdCell("分类", t(cat || "未分类")),
      mdCell("互斥模组", (Array.isArray(m.conflicts) && m.conflicts.length) ? m.conflicts.join(", ") : t("无")),
      mdCell("兼容版本", (Array.isArray(m.evejsVersions) && m.evejsVersions.length) ? m.evejsVersions.join(", ") : t("未声明")),
      mdCell("更新时间", fmtTime(isMarket ? Date.parse(String(m.updatedAt || m.publishedAt || "")) : m.updatedAt)),
      mdCell("来源", isMarket ? t("模组市场") : (m.source === "market" ? t("模组市场") : t("本机")))
    ];
    if (isMarket && m.rating) grid.splice(4, 0, mdCell("评分", m.rating + (m.ratingCount ? " (" + m.ratingCount + ")" : "")));
    if (isMarket && m.sha256) grid.push(mdCell("SHA256", String(m.sha256).slice(0, 16) + "…"));
    // 市场条目：把仓库地址放进详情（卡片上的「源码」按钮已移除）
    const repoBlock = (isMarket && m.repo)
      ? '<div class="md-sec"><h4>// ' + t("来源仓库") + '</h4><div class="md-note"><span class="md-link" onclick="openExternalUrl(\'' + esc(m.repo) + '\')">' + esc(m.repo) + "</span></div></div>"
      : "";

    // 旧版包签了名但没带 publicKey：本机无法验证，但不影响使用，给一句说明避免误以为“被篡改”
    const sigNote = (!isMarket && m.signatureState === "invalid" && !m.signatureTrusted)
      ? '<div class="md-note" style="margin-bottom:8px">' + esc(t("这可能是旧版模组包：签名里没有附带作者公钥，本机无法验证，但不影响启用。作者用新版启动器重新发布后即可正常校验。")) + '</div>'
      : "";

    const highlightList = (d.highlights && d.highlights.length)
      ? '<div class="md-sec"><h4>// ' + t("功能要点") + '</h4><ul class="md-list">' + d.highlights.map((h) => "<li>" + esc(h) + "</li>").join("") + "</ul></div>"
      : "";
    const readmeBlock = d.readme
      ? '<div class="md-sec"><h4>// ' + t("模组说明") + '</h4><div class="md-body">' + esc(d.readme) + "</div></div>"
      : '<div class="md-sec"><h4>// ' + t("模组说明") + '</h4><div class="md-note">' + t("这个模组没有写说明（README.md 为空）") + "</div></div>";
    const changelog = (isMarket && m.changelog)
      ? '<div class="md-sec"><h4>// ' + t("本次更新") + '</h4><div class="md-body">' + esc(m.changelog) + "</div></div>"
      : "";

    body.innerHTML = sigNote + '<div class="md-sub">' + esc(sub || "—") + "</div>"
      + '<div class="md-chips">' + chips.map(([cls, text]) => '<span class="md-chip ' + cls + '">' + esc(text) + "</span>").join("") + "</div>"
      + '<div class="md-grid">' + grid.join("") + "</div>"
      + highlightList + readmeBlock + changelog + repoBlock
      + '<div class="md-sec"><h4>// ' + t("玩家评价") + '</h4><div class="md-note">' + t("评分与评价需要服务器汇总，当前版本先在索引里展示聚合评分。") + "</div></div>";

    const folderBtn = document.getElementById("mdOpenFolder");
    if (folderBtn) folderBtn.style.display = isMarket ? "none" : "";
    const resign = document.getElementById("mdResign");
    if (resign) resign.style.display = isMarket ? "none" : "";
    const install = document.getElementById("mdInstall");
    if (install) install.style.display = isMarket ? "" : "none";
  }

  function openModDetailModal() {
    const modal = document.getElementById("modDetailModal");
    if (!modal) return;
    modal.classList.add("open");
  }

  openInstalledModDetail = async function (folder) {
    const mod = MODS.find((m) => m.folder === folder);
    if (!mod) return;
    let parsed = { highlights: [], readme: "" };
    try {
      const res = await api.modsReadme(folder);
      if (res && res.text) parsed = parseReadmeText(res.text);
    } catch (error) {
      console.error("readme failed", error);
    }
    if (!parsed.readme && mod.description) parsed.readme = mod.description;
    MOD_DETAIL = { kind: "installed", mod, readme: parsed.readme, highlights: parsed.highlights };
    renderModDetail();
    openModDetailModal();
  };

  openMarketModDetail = function (id) {
    const entry = MARKET.find((e) => e.id === id);
    if (!entry) return;
    MOD_DETAIL = {
      kind: "market",
      entry,
      readme: readmeTextOf(entry),
      highlights: Array.isArray(entry.highlights) ? entry.highlights : []
    };
    renderModDetail();
    openModDetailModal();
  };

  mdOpenFolder = function () {
    if (!MOD_DETAIL || !MOD_DETAIL.mod) return;
    if (typeof revealModFolder === "function") revealModFolder(MOD_DETAIL.mod.folder);
  };

  mdResign = async function () {
    if (!MOD_DETAIL || !MOD_DETAIL.mod) return;
    closeModal("modDetailModal");
    if (typeof signMod === "function") await signMod(MOD_DETAIL.mod.folder);
  };

  mdInstall = function () {
    if (!MOD_DETAIL || !MOD_DETAIL.entry) return;
    const id = MOD_DETAIL.entry.id;
    closeModal("modDetailModal");
    if (typeof installMarketMod === "function") void installMarketMod(id);
  };
  /* ============ 模组页签的数据与动作（渲染在 eve-launcher.html 里） ============ */
  loadMyMods = async function () {
    try {
      const res = await api.modsMyMods();
      MY_MODS = (res && res.items) || [];
      MY_MODS_HIDDEN = (res && typeof res.hidden === "number") ? res.hidden : 0;
    } catch (error) {
      console.error("myMods failed", error);
      MY_MODS = [];
    }
    if (typeof updateModTabs === "function") updateModTabs();
    if (typeof renderMods === "function") renderMods();
  };

  loadMarket = async function (force, silent) {
    const grid = document.getElementById("modsGrid");
    if (!silent && grid && typeof t === "function") grid.innerHTML = '<div style="grid-column:1/-1;padding:34px;text-align:center;color:var(--txt-mute);font-size:12px">' + t("加载索引中…") + "</div>";
    try {
      const res = await api.modsMarketList(!!force);
      MARKET = (res && res.mods) || [];
      MARKET_DELISTED = (res && res.delisted) || [];   // 被维护者下架的条目：市场里不再列出
      MOD_UPDATES = (res && res.updates) || [];
      MARKET_FETCHED_AT = (res && res.fetchedAt) || Date.now();
      MOD_BLOCKED = (res && res.blocked) || [];
      if (!silent && res && res.reason) toast(res.reason, res.cached ? "warn" : "err");
      else if (!silent && force) toast(t("索引已刷新") + " · " + MARKET.length + " " + t("个模组"), "ok");
    } catch (error) {
      console.error("marketList failed", error);
      MARKET = [];
      if (!silent) toast(t("索引加载失败") + ": " + String(error), "err");
    }
    if (typeof updateModTabs === "function") updateModTabs();
    // 只有用户正停在市场页时才重绘网格；静默拉取时不打扰其它页签
    if (typeof renderMods === "function" && MOD_TAB === "market") renderMods();
  };

  installMarketMod = async function (id) {
    const entry = MARKET.find((e) => e.id === id);
    if (!entry) return;
    MARKET_PROGRESS[id] = 0;
    if (typeof renderMarket === "function") renderMarket();
    try {
      const res = await api.modsMarketInstall(entry);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("安装失败"));
      const verb = res.mode === "update" ? t("已更新") : t("已安装");
      toast(verb + " · " + (res.folder || id) + " v" + (res.version || ""), "ok");
      logTo("sys", "OK", verb + " 模组 <span class=\"hi\">" + esc(res.folder || id) + "</span> v" + esc(res.version || ""));
      MOD_UPDATES = MOD_UPDATES.filter((u) => u.id !== id);
    } catch (error) {
      toast(t("安装失败") + ": " + String(error), "err");
      // 下载地址 404（作者删了仓库 / Release）→ 顺手静默刷新一次索引，死条目会随新索引消失
      if (/404/.test(String(error))) {
        void loadMarket(true, true);
        toast(t("已尝试刷新索引；如果这个模组还在列表里，说明索引尚未更新"), "warn");
      }
    } finally {
      delete MARKET_PROGRESS[id];
      await refreshModsStatus();
      if (typeof renderMarket === "function") renderMarket();
    }
  };

  exportMyModsCsv = async function () {
    if (!MY_MODS.length) { toast(t("没有可导出的模组"), "warn"); return; }
    const header = ["id", "name", "version", "status", "category", "signed", "repo", "pr"];
    const rows = MY_MODS.map((m) => [m.id, m.displayName || "", m.version || "", MOD_STATUS_LABEL[m.status] || m.status, m.category || "", m.signed ? "yes" : "no", m.sourceRepo || "", m.prUrl || ""]);
    const csv = [header].concat(rows).map((r) => r.map((c) => "\"" + String(c).replace(/"/g, "\"\"") + "\"").join(",")).join("\r\n") + "\r\n";
    try {
      const res = await api.modsSaveText("my-evejs-mods.csv", "\ufeff" + csv);
      if (res && res.canceled) return;
      if (!res || !res.ok) throw new Error((res && res.reason) || t("导出失败"));
      toast(t("已导出") + " · " + res.path, "ok");
    } catch (error) {
      toast(t("导出失败") + ": " + String(error), "err");
    }
  };

  refreshMyModsTab = function () {
    if (MOD_TAB === "mine") void loadMyMods();
  };
  /* ============ 提交模组（签名 → 打包 → 索引分片 → GitHub PR，见 docs/…plan.md §5.4） ============ */
  let SM_ITEM = null;
  let SM_COMPARE = "";
  /** 从「我创建的」卡片点进来时，预先选中的模组目录名 */
  let SM_PRESELECT = "";

  function smVal(id) { const el = document.getElementById(id); return el ? String(el.value || "") : ""; }
  function smSet(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
  function smIsMine(m) {
    if (!m) return false;
    if (m.authorId && AUTHOR && AUTHOR.author && m.authorId === AUTHOR.author.id) return true;
    if (m.signatureKeyId && AUTHOR && AUTHOR.author && m.signatureKeyId === AUTHOR.author.keyId) return true;
    return false;
  }

  /** 当前选中的模组目录名（隐藏 input，保持 smVal/smSet 兼容） */
  function smSelectedFolder() { return smVal("smMod"); }

  /** 设定选中的模组：更新隐藏 input、按钮文字、列表高亮 */
  function smSetMod(folder) {
    smSet("smMod", folder);
    const mod = MODS.find((m) => m.folder === folder);
    const label = document.getElementById("smPickerLabel");
    if (label) {
      label.textContent = mod ? (mod.displayName || mod.id) + "  v" + (mod.version || "?") : t("选择要提交的模组");
    }
    const menu = document.getElementById("smPickerMenu");
    if (menu) {
      menu.querySelectorAll(".sm-picker-item").forEach((el) => {
        el.classList.toggle("active", el.dataset.folder === folder);
      });
    }
    const picker = document.getElementById("smPicker");
    if (picker) picker.classList.remove("open");
  }

  smTogglePicker = function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const picker = document.getElementById("smPicker");
    if (picker) picker.classList.toggle("open");
  };

  /* 只列作者自己的模组：别人的模组不给提交（避免误传/替别人提交） */
  function smFillMods() {
    const menu = document.getElementById("smPickerMenu");
    if (!menu) return;
    const mine = MODS.filter((m) => smIsMine(m));
    if (!mine.length) {
      menu.innerHTML = '<div class="sm-picker-empty">' + esc(t("这里只列出你自己的模组。先用「创建模组」建一个，或把带你自己作者标识的模组放进 mods/ 目录。")) + "</div>";
      smSetMod("");
      const label = document.getElementById("smPickerLabel");
      if (label) label.textContent = t("没有可提交的模组");
      return;
    }
    menu.innerHTML = mine
      .map((m) =>
        '<div class="sm-picker-item" data-folder="' + esc(m.folder) + '">' +
        "<span>" + esc(m.displayName || m.id) + "</span>" +
        '<span class="v">v' + esc(m.version || "?") + "</span></div>"
      )
      .join("");
    menu.querySelectorAll(".sm-picker-item").forEach((el) => {
      el.addEventListener("click", () => {
        smSetMod(el.dataset.folder);
        smOnModChange();
      });
    });
    smSetMod(SM_PRESELECT && mine.some((m) => m.folder === SM_PRESELECT) ? SM_PRESELECT : mine[0].folder);
  }

  smOnModChange = function () {
    const folder = smVal("smMod");
    const mod = MODS.find((m) => m.folder === folder);
    if (!mod) return;
    if (!smVal("smCategory")) smSet("smCategory", mod.category || "玩法");
    if (!smVal("smTags") && mod.tags && mod.tags.length) smSet("smTags", mod.tags.join(", "));
  };

  /** 更新 2) 的进度条；failed=true 时标红 */
  function smSetProgress(percent, text, failed) {
    const box = document.getElementById("smProgress");
    const bar = document.getElementById("smProgressBar");
    const txt = document.getElementById("smProgressText");
    if (box) box.style.display = "";
    if (bar) {
      bar.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + "%";
      bar.style.background = failed ? "var(--red)" : "";
    }
    if (txt) {
      txt.textContent = text || "";
      txt.style.color = failed ? "var(--red)" : "var(--txt-mute)";
    }
  }

  if (typeof api.onModPublishProgress === "function") {
    api.onModPublishProgress((p) => {
      if (!p) return;
      smSetProgress(p.percent, t("发布进度") + "：" + t(String(p.stage || "")), false);
    });
  }

  // 点页面空白处收起自定义下拉
  document.addEventListener("click", (ev) => {
    const picker = document.getElementById("smPicker");
    if (picker && !picker.contains(ev.target)) picker.classList.remove("open");
  });

  async function smRefreshTokenState() {
    const el = document.getElementById("smTokenState");
    if (!el) return;
    try {
      const st = await api.modsGithubTokenStatus();
      if (!st || !st.hasToken) {
        el.textContent = t("还没有保存令牌");
      } else if (st.encrypted) {
        el.textContent = t("令牌已加密保存（仅本机可用）");
      } else {
        el.textContent = t("令牌只保存在内存里（当前环境不支持加密存储）");
      }
      const btn = document.getElementById("smSubmit");
      if (btn) btn.disabled = !(st && st.hasToken) || !SM_ITEM;
      const reg = document.getElementById("smRegister");
      if (reg) reg.disabled = !(st && st.hasToken) || !SM_ITEM;
    } catch (error) {
      el.textContent = String(error);
    }
  }

  openSubmitModDialog = async function (preselectFolder) {
    const modal = document.getElementById("submitModModal");
    if (!modal) return;
    SM_PRESELECT = typeof preselectFolder === "string" ? preselectFolder : "";
    await loadAuthorProfile();
    await refreshModsStatus();
    smFillMods();
    const progBox = document.getElementById("smProgress");
    if (progBox) progBox.style.display = "none";
    SM_ITEM = null;
    SM_COMPARE = "";
    const res = document.getElementById("smResult");
    if (res) res.style.display = "none";
    const sub = document.getElementById("smSubmitResult");
    if (sub) { sub.style.display = "none"; sub.textContent = ""; }
    const reveal = document.getElementById("smReveal");
    if (reveal) reveal.disabled = true;
    smSet("smToken", "");
    const repoNameEl = document.getElementById("smRepoName");
    if (repoNameEl && !repoNameEl.value) {
      const firstId = (MODS.filter((m) => smIsMine(m))[0] || MODS[0] || {}).id || "my-mod";
      repoNameEl.placeholder = "evejs-mod-" + String(firstId).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    }
    smOnModChange();
    await smRefreshTokenState();
    if (typeof autoTranslateAfterRender === "function") autoTranslateAfterRender();
    modal.classList.add("open");
  };

  smPrepare = async function () {
    const btn = document.getElementById("smPrepare");
    const folder = smVal("smMod");
    if (!folder) { toast(t("请先选择一个模组"), "warn"); return; }
    const urls = [];
    const gh = smVal("smUrlGithub").trim();
    if (gh) urls.push({ mirror: "github", url: gh, priority: 1 });
    if (btn) btn.disabled = true;
    try {
      const res = await api.modsSubmitPrepare({
        folder,
        changelog: smVal("smChangelog"),
        category: smVal("smCategory"),
        tags: cmSplitList(smVal("smTags")),
        repo: smVal("smRepo"),
        downloadUrls: urls
      });
      if (!res || !res.ok) throw new Error((res && res.reason) || t("打包失败"));
      SM_ITEM = res.item;
      const text = [
        t("标识") + ": " + SM_ITEM.id,
        t("版本") + ": " + SM_ITEM.version,
        "ZIP: " + SM_ITEM.zipPath,
        "SHA256: " + SM_ITEM.sha256,
        "SIZE: " + SM_ITEM.sizeBytes + " bytes",
        t("分支") + ": " + SM_ITEM.branch
      ].join("\n");
      const textEl = document.getElementById("smResultText");
      if (textEl) textEl.textContent = text;
      smSet("smShard", JSON.stringify(SM_ITEM.indexDraft, null, 2));
      const resBox = document.getElementById("smResult");
      if (resBox) resBox.style.display = "";
      const reveal = document.getElementById("smReveal");
      if (reveal) reveal.disabled = false;
      await smRefreshTokenState();
      toast(t("已生成待提交包") + " · " + SM_ITEM.id + " v" + SM_ITEM.version, "ok");
      logTo("sys", "OK", "已生成待提交包 <span class=\"hi\">" + esc(SM_ITEM.id) + "</span> · sha256 " + esc(SM_ITEM.sha256.slice(0, 12)) + "…");
    } catch (error) {
      toast(t("打包失败") + ": " + String(error), "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  smRevealZip = async function () {
    if (!SM_ITEM) return;
    try {
      const res = await api.modsRevealSubmissionZip(SM_ITEM.zipPath);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("打开失败"));
    } catch (error) {
      toast(String(error), "err");
    }
  };

  smCopyShard = function () {
    const text = smVal("smShard");
    if (!text) return;
    const done = () => toast(t("分片 JSON 已复制"), "ok");
    const fail = () => toast(t("复制失败，请手动选择"), "warn");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fail);
    else fail();
  };

  smSaveToken = async function () {
    const token = smVal("smToken").trim();
    if (!token) { toast(t("令牌不能为空"), "warn"); return; }
    try {
      const res = await api.modsGithubTokenSave(token);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("保存失败"));
      smSet("smToken", "");
      toast(res.encrypted ? t("令牌已加密保存") : t("令牌只保存在内存里"), res.encrypted ? "ok" : "warn");
      if (res.reason) toast(res.reason, "warn");
      await smRefreshTokenState();
    } catch (error) {
      toast(t("保存失败") + ": " + String(error), "err");
    }
  };

  smClearToken = async function () {
    try {
      await api.modsGithubTokenClear();
      toast(t("令牌已清除"), "warn");
      await smRefreshTokenState();
    } catch (error) {
      toast(String(error), "err");
    }
  };

  smCheckToken = async function () {
    const typed = smVal("smToken").trim();
    try {
      const res = await api.modsGithubTokenCheck(typed || undefined);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("令牌无效"));
      toast(t("令牌有效") + " · " + res.login, "ok");
    } catch (error) {
      toast(t("令牌校验失败") + ": " + String(error), "err");
    }
  };

  smRegisterSource = async function () {
    if (!SM_ITEM) { toast(t("请先执行 1) 生成并打包"), "warn"); return; }
    const box = document.getElementById("smSubmitResult");
    try {
      const res = await api.modsRegisterSource(SM_ITEM.id, SM_ITEM.version);
      SM_COMPARE = (res && res.compareUrl) || SM_COMPARE;
      if (res && res.ok) {
        if (box) { box.style.display = ""; box.innerHTML = t("PR 已创建") + ": <span class=\"hi\">" + esc(res.prUrl || "") + "</span>"; }
        toast(t("收录申请已提交") + " · " + (res.branch || ""), "ok");
      } else {
        const reason = (res && res.reason) || t("提交失败");
        const manual = res && res.compareUrl ? res.compareUrl : "";
        if (box) {
          box.style.display = "";
          box.innerHTML =
            esc(reason) +
            (manual
              ? '<div style="margin-top:8px;color:var(--amber)">' + esc(t("PR 自动创建失败（分支已推送，可点下面按钮手动开 PR）")) + '</div>' +
                '<div style="margin-top:6px"><span class="hi" style="cursor:pointer" onclick="openExternalUrl(this.dataset.u)" data-u="' + esc(manual) + '">' + esc(manual) + '</span></div>'
              : "");
        }
        toast(t("提交失败") + ": " + reason, "err");
      }
    } catch (error) {
      toast(t("提交失败") + ": " + String(error), "err");
    }
  };

  smSubmit = async function () {
    if (!SM_ITEM) { toast(t("请先执行 1) 生成并打包"), "warn"); return; }
    const btn = document.getElementById("smSubmit");
    const box = document.getElementById("smSubmitResult");
    if (btn) btn.disabled = true;
    if (box) { box.style.display = ""; box.textContent = t("正在发布到你的仓库，请稍候…"); }
    smSetProgress(2, t("发布进度") + "：" + t("校验 GitHub 令牌"), false);
    try {
      const repoInput = smVal("smRepoName").trim();
      const res = await api.modsPublishOwnRepo(SM_ITEM.id, SM_ITEM.version, repoInput, "");   // 只走 GitHub，不再要 Gitee
      if (res && res.ok) {
        const lines = [
          t("已发布到我的仓库") + ": " + (res.repoUrl || (res.owner + "/" + res.repo)),
          res.releaseUrl ? "Release: " + res.releaseUrl : "",
          res.assetUrl ? "ZIP: " + res.assetUrl : "",
          res.repoCreated ? t("（仓库是本次新建的）") : "",
          "",
          t("下一步：点 3) 申请收录（一次性）")
        ].filter(Boolean);
        if (box) { box.style.display = ""; box.textContent = lines.join("\n"); }
        smSetProgress(100, t("发布完成") + " · " + (res.repo || ""), false);
        toast(t("已发布到我的仓库") + " · " + (res.repo || ""), "ok");
        logTo("sys", "OK", "模组 <span class=\"hi\">" + esc(SM_ITEM.id) + "</span> 已发布到 <span class=\"hi\">" + esc(res.repoUrl || "") + "</span>");
      } else {
        const reason = (res && res.reason) || t("提交失败");
        const hint = res && res.repoUrl ? "\n" + t("仓库已就绪，可手动上传 ZIP 到 Release") + ": " + res.repoUrl : "";
        if (box) { box.style.display = ""; box.textContent = reason + hint; }
        smSetProgress(100, t("发布失败") + ": " + reason, true);
        toast(t("提交失败") + ": " + reason, "err");
      }
    } catch (error) {
      if (box) box.textContent = String(error);
      smSetProgress(100, t("发布失败") + ": " + String(error), true);
      toast(t("提交失败") + ": " + String(error), "err");
    } finally {
      if (btn) btn.disabled = false;
      await smRefreshTokenState();
    }
  };

  smOpenCompare = async function () {
    if (!SM_COMPARE) {
      const r = t("还没有提交记录，请先点 2) 或直接到索引仓库手动开 PR");
      toast(r, "warn");
      return;
    }
    try {
      await api.openExternal(SM_COMPARE);
    } catch (error) {
      toast(String(error), "err");
    }
  };

  /* ============ 创建模组（模板来自主进程 modScaffold.ts，唯一基准 welcome-mod） ============ */
  let MOD_TEMPLATES = [];
  let cmIdTouched = false;

  function cmSlug(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "")
      .slice(0, 64);
  }
  function cmFallbackId() {
    return "mod-" + Date.now().toString(36);
  }
  function cmSplitList(value) {
    return String(value || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  }
  function cmSplitLines(value) {
    return String(value || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  function cmTemplate() {
    const sel = document.getElementById("cmTemplate");
    const id = sel ? sel.value : "";
    return MOD_TEMPLATES.find((t) => t.id === id) || MOD_TEMPLATES[0] || null;
  }

  async function loadModTemplates() {
    if (MOD_TEMPLATES.length) return MOD_TEMPLATES;
    try {
      const res = await api.modsTemplates();
      MOD_TEMPLATES = (res && res.templates) || [];
    } catch (error) {
      console.error("modsTemplates failed", error);
    }
    return MOD_TEMPLATES;
  }

  cmOnName = function () {
    if (cmIdTouched) return;
    const name = document.getElementById("cmName");
    const idEl = document.getElementById("cmId");
    if (!idEl) return;
    const slug = cmSlug(name && name.value ? name.value : "");
    idEl.value = slug || cmFallbackId();
    cmPreview();
  };
  cmOnId = function () {
    cmIdTouched = true;
    cmPreview();
  };

  cmPreview = function () {
    const pre = document.getElementById("cmPreview");
    if (!pre) return;
    const idEl = document.getElementById("cmId");
    const id = cmSlug(idEl && idEl.value ? idEl.value : "") || "<id>";
    const tpl = cmTemplate();
    // 预览必须和 createMod 真正落地的文件一致：默认生成的是 loader.js.disabled（勾了「立即启用」才改名）
    const enabledEl = document.getElementById("cmEnabled");
    const loaderName = enabledEl && enabledEl.checked ? "loader.js" : "loader.js.disabled";
    const files = (tpl && tpl.files
      ? tpl.files.map((f) => (f === "loader.js" ? loaderName : f))
      : ["evejs-launcher.mod.json", loaderName, "README.md", "CHANGELOG.md"]);
    const branch = (i) => (i === files.length - 1 ? "└─ " : "├─ ");
    const rows = files.map((f) =>
      "<div class=\"cm-file\">" + branch(files.indexOf(f)) + esc(f) + "</div>"
    );
    let html = "<div class=\"cm-root\">" + esc("mods/" + id + "/") + "</div>" + rows.join("");
    if (tpl) {
      html += "<div class=\"cm-tpl\">" + esc(t("模板") + ": " + t(tpl.name) + " —— " + t(tpl.desc)) + "</div>";
    }
    pre.innerHTML = html;
  };

  openCreateModDialog = async function () {
    const modal = document.getElementById("createModModal");
    if (!modal) return;
    const templates = await loadModTemplates();
    const sel = document.getElementById("cmTemplate");
    if (sel && !sel.options.length && templates.length) {
      sel.innerHTML = templates.map((tpl) => '<option value="' + esc(tpl.id) + '">' + esc(t(tpl.name)) + '</option>').join("");
    }
    cmIdTouched = false;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("cmName", "");
    set("cmId", "");
    set("cmVersion", "1.0.0");
    set("cmCategory", "");
    set("cmTags", "");
    set("cmDesc", "");
    set("cmReadme", "");
    set("cmHighlights", "");
    set("cmConflicts", "");
    const restart = document.getElementById("cmRestart");
    if (restart) restart.checked = true;
    const enabled = document.getElementById("cmEnabled");
    if (enabled) enabled.checked = false;
    // 「立即启用」会改变真正落地的文件名（loader.js.disabled ↔ loader.js），预览要同步刷新
    if (enabled && !enabled.dataset.previewBound) {
      enabled.dataset.previewBound = "1";
      enabled.addEventListener("change", () => cmPreview());
    }
    const signEl = document.getElementById("cmSign");
    if (signEl) signEl.checked = true;
    cmPreview();
    if (typeof autoTranslateAfterRender === "function") autoTranslateAfterRender();
    modal.classList.add("open");
  };

  submitCreateMod = async function () {
    const btn = document.getElementById("cmSubmit");
    const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || "") : ""; };
    const checked = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
    const tpl = cmTemplate();
    const draft = {
      id: cmSlug(val("cmId")) || cmSlug(val("cmName")) || cmFallbackId(),
      displayName: val("cmName").trim(),
      version: val("cmVersion").trim() || "1.0.0",
      description: val("cmDesc").trim(),
      templateId: (tpl && tpl.id) || "broadcast",
      category: val("cmCategory").trim(),
      tags: cmSplitList(val("cmTags")),
      readme: val("cmReadme"),
      highlights: cmSplitLines(val("cmHighlights")),
      conflicts: cmSplitList(val("cmConflicts")),
      requiresRestart: checked("cmRestart"),
      enabled: checked("cmEnabled"),
      sign: checked("cmSign")
    };
    if (!draft.displayName) { toast(t("模组名不能为空"), "warn"); return; }
    if (btn) btn.disabled = true;
    try {
      const res = await api.modsCreate(draft);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("创建失败"));
      const extra = [];
      if (res.signed) extra.push(t("已签名"));
      if (draft.enabled) extra.push(t("已启用"));
      if (res.reason) toast(res.reason, "warn");
      toast(t("模组已创建") + " · " + res.folder + (extra.length ? " · " + extra.join(" · ") : ""), "ok");
      logTo("sys", "OK", "已创建模组 <span class=\"hi\">" + esc(res.folder || "") + "</span>（模板 " + esc(draft.templateId) + "）");
      closeModal("createModModal");
      await refreshModsStatus();
    } catch (error) {
      toast(t("创建失败") + ": " + String(error), "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  /** 用本机作者私钥给一个模组的 manifest 签名（Ed25519，见 docs/…plan.md §9） */
  signMod = async function (folder) {
    try {
      if (!AUTHOR || !AUTHOR.author) await loadAuthorProfile();
      if (!AUTHOR || !AUTHOR.privateKeyExists) {
        toast(t("请先设置作者身份或导入密钥"), "warn");
        return;
      }
      // 归属保护：别人的模组不能用我的密钥签（那会把我的作者标识写进它的清单）
      const mod = MODS.find((m) => m.folder === folder);
      const me = AUTHOR.author;
      if (mod && mod.authorId && mod.authorId !== me.id) {
        toast(t("这不是你的模组") + " · " + t("作者") + ": " + (mod.authorName || mod.authorId), "err");
        logTo("sys", "WARN", "拒绝签名 <span class=\"hi\">" + esc(folder) + "</span>：该模组作者是 " + esc(mod.authorName || mod.authorId));
        return;
      }
      if (mod && !mod.authorId) {
        const question = t("该模组的清单里没有作者标识。") + "\n\n"
          + t("签名会把「你的作者身份」写进它的清单，之后它会出现在「我创建的」里。") + "\n"
          + t("如果这不是你自己做的模组，请不要签。") + "\n\n"
          + t("确定要签名吗？");
        if (!window.confirm(question)) return;
      }
      const res = await api.modsSign(folder);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("签名失败"));
      toast(t("签名已写入") + " · keyId " + res.keyId, "ok");
      logTo("sys", "OK", "模组 <span class=\"hi\">" + esc(folder) + "</span> 已用 keyId <span class=\"hi\">" + esc(res.keyId || "") + "</span> 重新签名");
      await refreshModsStatus();
    } catch (error) {
      toast(t("签名失败") + ": " + String(error), "err");
    }
  };
  async function refreshModsStatus() {
    const panel = document.getElementById("modsMissingPanel");
    if (!panel) return;
    try {
      const status = await api.modsList();
      const pathEl = document.getElementById("modsMissingPath");
      if (pathEl && status?.root) pathEl.textContent = status.root;
      const rootEl = document.getElementById("modsRootPath");
      if (rootEl) rootEl.textContent = status?.repoRoot || "—";
      const hintEl = document.getElementById("modsRootHint");
      if (hintEl) hintEl.style.display = status?.repoRootLooksValid === false ? "" : "none";
      panel.style.display = status?.exists ? "none" : "";
      MODS.length = 0;
      (status?.mods || []).forEach((mod) => MODS.push(mod));
      MOD_STATS = status?.stats || { total: 0, enabled: 0, disabled: 0, conflicts: 0, bytes: 0 };
      MOD_CONFLICTS = Array.isArray(status?.conflicts) ? status.conflicts : [];
      if (typeof updateModBanner === "function") updateModBanner();
      renderMods();
    } catch (error) {
      console.error("modsList failed", error);
    }
  }

  refreshModsList = async function () {
    await refreshModsStatus();
    toast(t("刷新列表") + " · " + MODS.length + " " + t("个模组"), "ok");
  };

  openModsFolder = async function () {
    try {
      const result = await api.modsOpenFolder();
      if (!result?.ok) throw new Error(result?.reason || "打开失败");
      logTo("sys", "OK", "已打开模组目录 <span class=\"hi\">" + esc(result.root || "mods") + "</span>");
    } catch (error) {
      toast(String(error), "err");
    }
  };

  /** 导入 ZIP 模组：主进程弹选择框 → 解压 → 校验 → 落到 mods/<id>（默认禁用） */
  importModZip = async function () {
    try {
      const result = await api.modsImportZip();
      if (result?.canceled) return;
      if (!result?.ok) throw new Error(result?.reason || "导入失败");
      const name = result.displayName || result.id || result.folder || "mod";
      toast(name + " · " + t("模组已导入") + (result.disabledAfterImport ? "（" + t("已默认禁用") + "）" : ""), "ok");
      logTo("sys", "OK", "已导入模组 <span class=\"hi\">" + esc(result.folder || name) + "</span>");
      await refreshModsStatus();
    } catch (error) {
      toast(t("导入失败") + ": " + String(error), "err");
    }
  };

  /** 拖拽排序：把 fromFolder 移动到 toFolder 之前，并持久化到 _launcher/mods/mod-order.json */
  reorderMods = async function (fromFolder, toFolder) {
    const folders = MODS.map((mod) => mod.folder);
    const from = folders.indexOf(fromFolder);
    const to = folders.indexOf(toFolder);
    if (from < 0 || to < 0 || from === to) return;
    folders.splice(to, 0, folders.splice(from, 1)[0]);

    // 先本地重排，界面立刻响应
    const byFolder = new Map(MODS.map((mod) => [mod.folder, mod]));
    MODS.length = 0;
    folders.forEach((folder) => { const mod = byFolder.get(folder); if (mod) MODS.push(mod); });
    renderMods();

    try {
      const result = await api.modsSetOrder(folders);
      if (!result?.ok) throw new Error(result?.reason || "保存失败");
      toast(t("已保存模组加载顺序"), "ok");
      logTo("sys", "OK", "模组加载顺序已更新（共 " + folders.length + " 个）");
    } catch (error) {
      toast(String(error), "err");
      await refreshModsStatus();
    }
  };

  /** 模组制作规范：在启动器里内嵌阅读（Markdown 渲染 + 右侧标题导航树），不再丢给记事本 */
  openModAuthoringDoc = async function () {
    try {
      const lang = (typeof curLang === "string" && curLang === "zh") ? "zh" : "en";
      const res = await api.modsAuthoringDocText(lang);
      if (!res || !res.ok) throw new Error((res && res.reason) || "读取失败");
      openDocViewer(res.text || "", res.path || "", lang);
      logTo("sys", "OK", "模组制作规范（内嵌阅读）: " + esc(res.path || ""));
    } catch (error) {
      toast(t("打开模组制作规范失败") + ": " + String(error), "err");
    }
  };

  /** 备用：用系统默认程序打开（弹窗右下角按钮） */
  openModAuthoringDocExternal = async function () {
    try {
      const result = await api.modsOpenAuthoringDoc();
      if (!result?.ok) throw new Error(result?.reason || "打开失败");
      if (result.revealed) toast(t("未找到 .md 关联程序，已在资源管理器中选中该文档"), "warn");
      else toast(t("已用系统默认程序打开模组制作规范"), "ok");
    } catch (error) {
      toast(t("打开模组制作规范失败") + ": " + String(error), "err");
    }
  };

  /** 卸载模组：先二次确认，再把 mods/<folder> 移入回收站（可还原） */
  uninstallMod = async function (folder) {
    const mod = MODS.find((m) => m.folder === folder);
    const name = mod ? (mod.displayName || mod.id) : String(folder);
    if (!window.confirm(t("卸载") + "「" + name + "」？" + String.fromCharCode(10) + t("模组文件会移入回收站，可从回收站还原。"))) return;
    try {
      const res = await api.modsUninstall(folder);
      if (!res || !res.ok) throw new Error((res && res.reason) || t("卸载失败"));
      toast(t("已卸载") + " · " + name + (res.trashed ? "" : "（" + t("未进入回收站，已直接删除") + "）"), "ok");
      logTo("sys", "WARN", "已卸载模组 <span class=\"hi\">" + esc(String(folder)) + "</span>");
      await refreshModsStatus();
    } catch (error) {
      toast(t("卸载失败") + ": " + String(error), "err");
    }
  };

  toggleMod = async function (folder, next) {
    try {
      const result = await api.modsSetEnabled(folder, next);
      if (!result?.ok) throw new Error(result?.reason || "操作失败");
      toast(t(next ? "模组已启用，请重启游戏服务生效" : "模组已禁用，请重启游戏服务生效"), next ? "ok" : "warn");
      logTo("sys", next ? "OK" : "WARN", "模组 <span class=\"hi\">" + esc(folder) + "</span> " + (next ? "已启用" : "已禁用"));
      await refreshModsStatus();
    } catch (error) {
      toast(t("操作失败") + ": " + String(error), "err");
      await refreshModsStatus();
    }
  };

  createModsFolder = async function () {
    const button = document.getElementById("modsCreateBtn");
    if (button) button.disabled = true;
    try {
      const result = await api.modsCreateFolder();
      if (!result?.ok) throw new Error(result?.reason || "创建失败");
      toast(t("mods 文件夹已创建"), "ok");
      logTo("sys", "OK", "已创建模组目录 <span class=\"hi\">" + esc(result.root || "mods") + "</span>");
      await refreshModsStatus();
    } catch (error) {
      toast(t("创建 mods 文件夹失败") + ": " + String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  };

  function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
      .map((value) => String(value).padStart(2, "0")).join(":");
  }

  tickMetrics = async function () {
    try {
      const metrics = await api.metricsGet();
      const cpu = Number(metrics?.cpuPercent || 0);
      const memUsed = Number(metrics?.memUsedGB || 0);
      const memTotal = Number(metrics?.memTotalGB || 1);
      const diskUsed = Number(metrics?.diskUsedGB || 0);
      const diskTotal = Number(metrics?.diskTotalGB || 1);
      const net = Number(metrics?.netBytesPerSec || 0);
      const gpuPercent = metrics?.gpuPercent == null ? null : Number(metrics.gpuPercent);
      const gpuDedicatedUsed = metrics?.gpuDedicatedUsedGB == null ? null : Number(metrics.gpuDedicatedUsedGB);
      const gpuDedicatedTotal = metrics?.gpuDedicatedTotalGB == null ? null : Number(metrics.gpuDedicatedTotalGB);
      const gpuMemoryUsed = metrics?.gpuMemoryUsedGB == null ? null : Number(metrics.gpuMemoryUsedGB);
      const gpuMemoryTotal = metrics?.gpuMemoryTotalGB == null ? null : Number(metrics.gpuMemoryTotalGB);
      const virtualUsed = metrics?.virtualMemUsedGB == null ? null : Number(metrics.virtualMemUsedGB);
      const virtualTotal = metrics?.virtualMemTotalGB == null ? null : Number(metrics.virtualMemTotalGB);
      const memPct = memTotal ? memUsed / memTotal * 100 : 0;
      const diskPct = diskTotal ? diskUsed / diskTotal * 100 : 0;
      const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
      const width = (id, percent) => { const el = document.getElementById(id); if (el) el.style.width = `${Math.max(0, Math.min(100, percent))}%`; };
      set("mCpu", `${cpu.toFixed(1)}<span class="u">%</span>`); width("bCpu", cpu); set("sbCpu", `${cpu.toFixed(0)}%`); width("sbCpuBar", cpu);
      set("mMem", `${memUsed.toFixed(1)}<span class="u">GB / ${memTotal.toFixed(1)}GB</span>`); width("bMem", memPct); set("sbMem", `${memUsed.toFixed(1)}G`);
      set("mDisk", `${diskUsed.toFixed(0)}<span class="u">GB / ${diskTotal.toFixed(0)}GB</span>`); width("bDisk", diskPct);
      set("mNet", `${(net / 1024 / 1024).toFixed(2)}<span class="u">MB/s</span>`); width("bNet", net / 1024 / 1024 / 100);
      // 左下角小面板：原来只有演示代码在更新，这里补成真实值
      const netMBs = net / 1024 / 1024;
      set("sbNet", `${netMBs.toFixed(2)} MB/s`);
      width("sbNetBar", netMBs / 100);
      width("sbMemBar", memPct);
      const diskLabel = document.getElementById("diskLabel");
      if (diskLabel) diskLabel.textContent = metrics?.diskRoot ? `${t("EVEJS 所在盘")} · ${metrics.diskRoot}` : t("EVEJS 所在盘");
      const volumeList = document.getElementById("diskVolumeList");
      if (volumeList) {
        const volumes = Array.isArray(metrics?.volumes) ? metrics.volumes : [];
        volumeList.innerHTML = volumes.map((volume) => {
          const percent = Math.max(0, Math.min(100, Number(volume.percent || 0)));
          return `<div class="disk-volume"><div class="dv-top"><span class="dv-root">${esc(volume.root)}</span><span class="dv-pct">${percent.toFixed(0)}%</span></div><div class="dv-bar"><i style="width:${percent}%"></i></div><div class="dv-top" style="margin:5px 0 0"><span>${Number(volume.usedGB || 0).toFixed(1)} GB</span><span>${Number(volume.totalGB || 0).toFixed(1)} GB</span></div></div>`;
        }).join("");
      }
      set("mGpu", gpuPercent == null ? "—" : `${gpuPercent.toFixed(1)}<span class="u">%</span>`); width("bGpu", gpuPercent || 0);
      set("mGpuDedicated", gpuDedicatedUsed == null || gpuDedicatedTotal == null ? "—" : `${gpuDedicatedUsed.toFixed(1)}<span class="u">GB / ${gpuDedicatedTotal.toFixed(1)}GB</span>`); width("bGpuDedicated", gpuDedicatedTotal ? gpuDedicatedUsed / gpuDedicatedTotal * 100 : 0);
      set("mGpuMemory", gpuMemoryUsed == null || gpuMemoryTotal == null ? "—" : `${gpuMemoryUsed.toFixed(1)}<span class="u">GB / ${gpuMemoryTotal.toFixed(1)}GB</span>`); width("bGpuMemory", gpuMemoryTotal ? gpuMemoryUsed / gpuMemoryTotal * 100 : 0);
      set("mVirtualMem", virtualUsed == null || virtualTotal == null ? "—" : `${virtualUsed.toFixed(1)}<span class="u">GB / ${virtualTotal.toFixed(1)}GB</span>`); width("bVirtualMem", virtualTotal ? virtualUsed / virtualTotal * 100 : 0);
      const clock = document.getElementById("monClock"); if (clock) clock.textContent = "LIVE · " + new Date().toTimeString().slice(0, 8);
      const onlinePlayers = Number(metrics?.onlinePlayers);
      set("sbPilots", Number.isFinite(onlinePlayers) && onlinePlayers >= 0 ? onlinePlayers.toLocaleString() : "—");
      void updateServerPing();
      updateAlerts();
      // 主服务没在跑时不显示 00:00:00，保持「--:--:--」这种未初始化样式
      set("sbSession", mainServerStartedAt ? formatUptime((Date.now() - mainServerStartedAt) / 1000) : "--:--:--");
    } catch (error) {
      console.error("metricsGet failed", error);
    }
  };

  let localUpdateResult = null;
  function v(value) {
    const text = String(value || "");
    return text.startsWith("v") ? text : `v${text}`;
  }
  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!bytes) return "未知";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  /** 底栏 ALERTS：环境自检失败 + 服务异常 + 有可用更新 */
  function updateAlerts() {
    const el = document.getElementById("sbAlerts");
    if (!el) return;
    const envBad = Array.isArray(ENV) ? ENV.filter((item) => item && item.status === "fail").length : 0;
    const svcBad = SVC.filter((item) => item.state === "err").length;
    const updBad = typeof updState === "string" && updState === "available" ? 1 : 0;
    const total = envBad + svcBad + updBad;
    el.textContent = String(total);
    const cell = document.getElementById("sbAlertsCell");
    if (cell) {
      cell.classList.toggle("warn", total > 0);
      cell.classList.toggle("ok", total === 0);
    }
  }

  /** 底栏 PING：真实测量到游戏服务器端口的 TCP 建连耗时 */
  async function updateServerPing() {
    const el = document.getElementById("sbPing");
    if (!el) return;
    try {
      const result = await api.healthPing();
      const ms = Number(result?.ms);
      el.textContent = result?.ok && Number.isFinite(ms) ? (ms < 1 ? "<1ms" : ms + "ms") : "—";
    } catch {
      el.textContent = "—";
    }
  }

  function setUpdateDot(visible) {
    const dot = document.getElementById("updDot");
    if (dot) dot.style.display = visible ? "block" : "none";
  }
  function syncUpdateInfo(result) {
    if (!result) return;
    UPDATE_INFO.currentVersion = v(result.currentVersion);
    UPDATE_INFO.version = v(result.latestVersion || result.currentVersion);
    UPDATE_INFO.size = formatBytes(result.size);
    UPDATE_INFO.date = result.date || "";
    UPDATE_INFO.channel = result.channel || "stable";
    UPDATE_INFO.changelog = result.changelog && typeof result.changelog === "object" ? result.changelog : [];
    UPDATE_INFO.targetPath = result.targetPath || "";
  }
  function updateProgress(state) {
    const percent = Math.max(0, Math.min(100, Number(state?.percent || 0)));
    const downloaded = Number(state?.downloaded || 0);
    const speed = Number(state?.speed || 0);
    const bar = document.getElementById("updDlBar");
    const pct = document.getElementById("updDlPct");
    const size = document.getElementById("updDlSize");
    const speedEl = document.getElementById("updDlSpeed");
    if (bar) bar.style.width = `${percent}%`;
    if (pct) pct.textContent = `${Math.round(percent)}%`;
    if (size) size.textContent = `${formatBytes(downloaded)} / ${formatBytes(state?.size)}`;
    if (speedEl) speedEl.textContent = `${formatBytes(speed)}/s`;
  }

  function changelogForLanguage() {
    let value = UPDATE_INFO.changelog;
    if (Array.isArray(value)) {
      const first = value[0];
      if (value.length === 1 && first && typeof first === "object" && !Array.isArray(first) && (first.zh || first.en)) value = first;
      else return value;
    }
    const language = curLang === "zh" ? "zh" : "en";
    return value?.[language] || value?.en || value?.zh || [];
  }

  checkUpdate = async function () {
    document.getElementById("updateModal")?.classList.add("open");
    updState = "checking";
    renderUpdateModal();
    try {
      localUpdateResult = await api.updateCheck();
      syncUpdateInfo(localUpdateResult);
      if (!localUpdateResult.ok) {
        UPDATE_INFO.error = localUpdateResult.reason || "检查更新失败";
        updState = "error";
        renderUpdateModal();
        return;
      }
      setUpdateDot(!!localUpdateResult.available);
      updState = localUpdateResult.available ? "available" : "uptodate";
      renderUpdateModal();
    } catch (error) {
      UPDATE_INFO.error = String(error);
      updState = "error";
      renderUpdateModal();
    }
  };

  renderUpdateModal = function () {
    const body = document.getElementById("updBody");
    const foot = document.getElementById("updFoot");
    const title = document.getElementById("updTitle");
    if (!body || !foot || !title) return;
    const current = UPDATE_INFO.currentVersion || CURRENT_VER;
    const latest = UPDATE_INFO.version || current;
    if (updState === "checking") {
      title.textContent = t("检查更新");
      body.innerHTML = `<div class="upd-stage"><div class="si spin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg></div><div class="st">${t("正在连接更新服务器…")}</div></div>`;
      foot.innerHTML = `<button class="mini-btn" onclick="closeModal('updateModal')">${t("取消")}</button>`;
      return;
    }
    if (updState === "available") {
      title.textContent = t("发现新版本");
      body.innerHTML = `<div class="upd-version-row"><div class="upd-ver-block cur"><div class="vl">${t("当前版本")}</div><div class="vv">${current}</div></div><div class="upd-ver-arrow">→</div><div class="upd-ver-block new"><div class="vl">${t("最新版本")}</div><div class="vv">${latest}</div></div></div><div class="upd-meta-row"><div class="mr"><span class="k">${t("大小")}:</span><span class="v">${UPDATE_INFO.size}</span></div><div class="mr"><span class="k">${t("发布日期")}:</span><span class="v">${UPDATE_INFO.date}</span></div><div class="mr"><span class="k">${t("通道")}:</span><span class="v">${UPDATE_INFO.channel}</span></div></div><div class="upd-changelog"><div class="cl-title">${t("更新日志")}</div><ul>${changelogForLanguage().map(item => `<li><span class="tag ${item.type}">${item.type === "new" ? "NEW" : item.type === "fix" ? "FIX" : "OPT"}</span>${esc(item.text)}</li>`).join("")}</ul></div>`;
      foot.innerHTML = `<button class="mini-btn" onclick="closeModal('updateModal')">${t("稍后再说")}</button><button class="mini-btn start" onclick="startDownload()">${t("立即更新")}</button>`;
      return;
    }
    if (updState === "downloading") {
      title.textContent = t("下载更新");
      body.innerHTML = `<div class="upd-stage"><div class="si spin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div><div class="st">${t("正在下载更新包…")}</div><div class="ss" id="updDlPct">0%</div></div><div class="upd-dl-progress"><div class="upd-dl-bar"><i id="updDlBar" style="width:0%"></i></div><div class="upd-dl-info"><span id="updDlSize">0 MB / ${UPDATE_INFO.size}</span><span id="updDlSpeed">0 MB/s</span></div></div>`;
      foot.innerHTML = `<button class="mini-btn" onclick="cancelDownload()">${t("取消下载")}</button>`;
      return;
    }
    if (updState === "ready") {
      title.textContent = t("更新已就绪");
      body.innerHTML = `<div class="upd-stage"><div class="si" style="color:var(--green)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg></div><div class="st">${t("新版本已下载，点击后启动器会重启并完成替换")}</div></div>`;
      foot.innerHTML = `<button class="mini-btn" onclick="closeModal('updateModal')">${t("稍后")}</button><button class="mini-btn start" onclick="startInstall()">${t("重启并安装")}</button>`;
      return;
    }
    if (updState === "installing") {
      title.textContent = t("安装更新");
      body.innerHTML = `<div class="upd-stage"><div class="si spin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg></div><div class="st">${t("正在启动更新器…")}</div><div class="ss">100%</div></div><div style="font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--txt-mute);margin-top:10px">${t("启动器将退出并自动重新打开")}</div>`;
      foot.innerHTML = "";
      return;
    }
    if (updState === "uptodate") {
      title.textContent = t("已是最新版本");
      body.innerHTML = `<div class="upd-stage"><div class="si" style="color:var(--green)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg></div><div class="st">${t("启动器已是最新版本")} · ${current}</div></div>`;
      foot.innerHTML = `<button class="mini-btn start" onclick="closeModal('updateModal')">${t("确定")}</button>`;
      return;
    }
    title.textContent = t("检查更新失败");
    body.innerHTML = `<div class="upd-stage"><div class="si" style="color:var(--red)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg></div><div class="st">${UPDATE_INFO.error || t("未配置更新源")}</div></div>`;
    foot.innerHTML = `<button class="mini-btn" onclick="closeModal('updateModal')">${t("确定")}</button>`;
  };

  startDownload = async function () {
    updState = "downloading";
    renderUpdateModal();
    const result = await api.updateDownload();
    if (!result?.ok) {
      UPDATE_INFO.error = result?.reason || "下载失败";
      updState = "error";
      renderUpdateModal();
      return;
    }
    updState = "ready";
    renderUpdateModal();
  };

  startInstall = async function () {
    updState = "installing";
    renderUpdateModal();
    const result = await api.updateApply();
    if (!result?.ok) {
      UPDATE_INFO.error = result?.reason || "安装失败";
      updState = "error";
      renderUpdateModal();
    }
  };

  cancelDownload = function () {
    api.updateCancel();
    updState = "available";
    renderUpdateModal();
  };

  api.onUpdateChanged((updateState) => {
    if (!updateState) return;
    if (updateState.state === "downloading") {
      if (updState !== "downloading") {
        updState = "downloading";
        renderUpdateModal();
      }
      updateProgress(updateState);
      return;
    }
    if (updateState.state === "ready") {
      updState = "ready";
      renderUpdateModal();
      return;
    }
    if (updateState.state === "applying") {
      updState = "installing";
      renderUpdateModal();
      return;
    }
    if (updateState.state === "error") {
      UPDATE_INFO.error = updateState.message || "更新失败";
      updState = "error";
      renderUpdateModal();
    }
  });

  const UPDATE_NOTICE_INTERVAL_MS = 30 * 60 * 1000;
  const UPDATE_FOCUS_MIN_INTERVAL_MS = 5 * 60 * 1000;
  let lastUpdateNoticeAt = Date.now();
  let notifiedUpdateVersion = "";

  async function checkUpdateNotice(force = false) {
    const now = Date.now();
    if (!force && now - lastUpdateNoticeAt < UPDATE_FOCUS_MIN_INTERVAL_MS) return;
    lastUpdateNoticeAt = now;
    const result = await api.updateCheck().catch(() => null);
    if (result?.ok && result.available) {
      syncUpdateInfo(result);
      setUpdateDot(true);
      const latest = v(result.latestVersion || "");
      if (latest && latest !== notifiedUpdateVersion) {
        notifiedUpdateVersion = latest;
        toast(`${t("发现新版本")} ${latest}${t("，点击右上角更新按钮")}`, "ok");
      }
    } else if (result?.ok && !result.available) {
      setUpdateDot(false);
    }
  }

  bindModTabs();
  setTimeout(() => checkUpdateNotice(true), 5000);
  setInterval(() => checkUpdateNotice(), UPDATE_NOTICE_INTERVAL_MS);
  window.addEventListener("focus", () => checkUpdateNotice());
  const databaseNav = document.querySelector('.nav-item[data-view="database"]');
  if (databaseNav) databaseNav.addEventListener("click", () => loadDatabaseOverview());
  if (document.getElementById("view-database")?.classList.contains("active")) loadDatabaseOverview();
  const modulesNav = document.querySelector('.nav-item[data-view="modules"]');
  if (modulesNav) modulesNav.addEventListener("click", () => { bindModTabs(); refreshModsStatus(); });
  if (document.getElementById("view-modules")?.classList.contains("active")) refreshModsStatus();

  // 资源指标 / 在线人数：原来只在启动时拉取一次，这里改为定时刷新
  setInterval(() => { void tickMetrics(); }, 5000);

  const launchButton = document.getElementById("launchAll");
  if (launchButton) {
    const readonlyLaunchButton = launchButton.cloneNode(true);
    launchButton.replaceWith(readonlyLaunchButton);
    readonlyLaunchButton.addEventListener("click", () => {
      if (launching) return;
      const managed = SVC.filter((item) => item.key === "node" || item.key === "market");
      if (managed.every((item) => item.state === "run")) stopAllServices();
      else startAllServices();
    });
  }

  (async () => {
    await refreshServices();
    await runEnvCheck();
    await loadAccountsFromBackend();
    await loadConfigFromBackend();
    await tickMetrics();
    await refreshModsStatus();
    await loadAuthorProfile();
    void loadMarket(false, true);   // 后台静默拉一次索引，让页签上的「N 可更新」徽章不用进市场页就能显示
    api.initState().then((state) => { if (state?.busy) logTo("sys", "SYS", esc(state.message || state.label || "初始化任务运行中")); }).catch(() => {});
    logTo("sys", "OK", "EVEJS COMMAND 启动器已连接 Electron 后端");
  })();
})();
