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
  let mainServerStartedAt = 0;
  let nextLogId = 1;
  function applyServices(list) {
    latestServices = Array.isArray(list) ? list : [];
    const byId = new Map(latestServices.map((item) => [item.id, item]));
    const mainServer = byId.get("mainServer");
    if (mainServer?.state === "running") {
      if (!mainServerStartedAt) mainServerStartedAt = Date.now();
    } else if (mainServer?.state !== "starting") {
      mainServerStartedAt = 0;
    }
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
        if (!result?.ok) toast(`${item.name}: ${result?.reason || "操作失败"}`, "err");
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
        toast("关键环境未通过，已中止启动", "err");
        return;
      }
      const result = await api.engageStart();
      toast(result.ok ? "一键启动序列完成" : `启动失败: ${result.reason}`, result.ok ? "ok" : "err");
    } catch (error) {
      toast("一键启动失败: " + String(error), "err");
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
      toast(result.ok ? "全部服务已停止" : `停止失败: ${result.reason}`, result.ok ? "warn" : "err");
    } catch (error) {
      toast("停止失败: " + String(error), "err");
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
      logTo(category, level, formatLogMessage(rawLine, level, true));
    });
  }

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
      toast("环境自检完成", "ok");
    } catch (error) {
      toast("环境自检失败: " + String(error), "err");
      renderEnvCheck();
    }
  };

  initEnvItem = async function (index) {
    const item = ENV[index];
    if (!item || !item._initKey) {
      toast("该项暂不支持启动器内初始化", "warn");
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
      toast("当前没有可初始化项目", "ok");
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
        toast(result?.reason || "账号读取失败", "err");
        return;
      }
      ACC.length = 0;
      (result.data || []).forEach((account, index) => ACC.push(mapAccountToUI(account, index)));
      accExpanded = {};
      renderAccounts();
    } catch (error) {
      toast("账号读取失败: " + String(error), "err");
    }
  }

  delAccount = async function (index) {
    const account = ACC[index];
    if (!account) return;
    try {
      const running = await api.accountsCheckRunning();
      if (running?.running) {
        toast("服务运行中，请先停止全部服务", "warn");
        return;
      }
      const preview = await api.accountsDelete(account.id, false);
      const text = preview?.output || preview?.reason || "确认删除该账号及其全部角色？";
      if (!window.confirm(text)) return;
      const result = await api.accountsDelete(account.id, true);
      if (!result?.ok) {
        toast(result?.reason || "删除失败", "err");
        return;
      }
      toast("账号已删除，备份已生成", "warn");
      await loadAccountsFromBackend();
    } catch (error) {
      toast("删除失败: " + String(error), "err");
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
    if (!user) { toast("请输入账号名", "err"); return; }
    if (password.length < 4) { toast("密码至少 4 位", "err"); return; }
    if (password !== password2) { toast("两次密码不一致", "err"); return; }
    const button = document.getElementById("createAccountBtn");
    if (button) button.disabled = true;
    try {
      const result = await api.accountsCreate(user, password, isGM);
      if (!result?.ok) throw new Error(result?.reason || "创建账号失败");
      closeModal("addAccountModal");
      toast(`账号 ${user} 已创建${isGM ? " · GM 权限" : ""}`, "ok");
      logTo("sys", "OK", `账号 <span class="hi">${esc(user)}</span> 已创建${isGM ? " · GM" : ""}`);
      await loadAccountsFromBackend();
    } catch (error) {
      toast(String(error), "err");
    } finally {
      if (button) button.disabled = false;
    }
  };
  addChar = function () {
    toast("当前后端暂不支持启动器内创建角色", "warn");
  };
  delChar = function () {
    toast("请通过账号删除流程处理角色数据", "warn");
  };
  launchChar = function (accountName, characterName) {
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
      toast("请输入账号密码", "err");
      return;
    }
    const button = document.getElementById("launchCharacterBtn");
    if (button) button.disabled = true;
    try {
      const result = await api.loginStart(accountName, password);
      if (!result?.ok) throw new Error(result?.reason || "客户端启动失败");
      closeModal("launchCharacterModal");
      toast(`${characterName} · 客户端自动登录中`, "ok");
      logTo("sys", "OK", `启动角色 <span class="hi">${esc(characterName)}</span> · 账号 ${esc(accountName)} · 自动登录`);
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
      toast("请输入账号和密码", "err");
      return;
    }
    if (meta) meta.textContent = "● VERIFYING";
    try {
      const verify = await api.accountsVerify(user, password);
      if (!verify?.ok) throw new Error(verify?.reason || "账号或密码错误");
      const result = await api.loginStart(user, password);
      if (!result?.ok) throw new Error(result?.reason || "客户端启动失败");
      if (meta) meta.textContent = `● LOGGED IN · ${user}`;
      toast("登录成功 · 客户端启动中", "ok");
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
      toast("请填写完整", "err");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast("两次新密码不一致", "err");
      return;
    }
    const result = await api.accountsSetPassword(user, oldPassword, newPassword);
    if (!result?.ok) {
      toast(result?.reason || "修改失败", "err");
      return;
    }
    toast("密码已修改，立即生效", "ok");
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
      setInput("cfgClientPath", config?.client?.clientPath);
      setInput("cfgClientExe", config?.client?.clientExe);
      setInput("cfgCaPem", config?.client?.caPem);
      setInput("cfgProxyUrl", config?.client?.proxyUrl);
      setInput("cfgClientSource", config?.client?.sourceFile);
      const serverMeta = document.getElementById("cfgServerMeta");
      if (serverMeta) serverMeta.textContent = config?.server?.sourceFile || "";
      const clientMeta = document.getElementById("cfgClientMeta");
      if (clientMeta) clientMeta.textContent = config?.client?.clientPath || "";
      const statusPath = document.getElementById("sbPath");
      if (statusPath) statusPath.textContent = appInfo?.repoRoot || "";
      setCheckbox("cfgStartMarket", settings?.startMarket !== false);
      setCheckbox("cfgAutoLogin", settings?.autoLogin === true);
    } catch (error) {
      toast("配置读取失败: " + String(error), "err");
    }
  }

  function setCheckbox(id, on) {
    const element = document.getElementById(id);
    if (element) element.classList.toggle("on", !!on);
  }

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
      if (!rootResult?.ok) {
        toast(rootResult?.reason || "服务端根目录保存失败", "err");
        return;
      }
    }
    const result = await api.configSetClient({
      clientPath: document.getElementById("cfgClientPath")?.value || "",
      clientExe: document.getElementById("cfgClientExe")?.value || "",
      caPem: document.getElementById("cfgCaPem")?.value || "",
      proxyUrl: document.getElementById("cfgProxyUrl")?.value || ""
    });
    if (!result?.ok) {
      toast(result?.reason || "配置保存失败", "err");
      return;
    }
    toast("配置已保存到 " + (result.client?.sourceFile || "EvEJSConfig.bat"), "ok");
    await loadConfigFromBackend();
    await tickMetrics();
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
      set("mGpu", gpuPercent == null ? "—" : `${gpuPercent.toFixed(1)}<span class="u">%</span>`); width("bGpu", gpuPercent || 0);
      set("mGpuDedicated", gpuDedicatedUsed == null || gpuDedicatedTotal == null ? "—" : `${gpuDedicatedUsed.toFixed(1)}<span class="u">GB / ${gpuDedicatedTotal.toFixed(1)}GB</span>`); width("bGpuDedicated", gpuDedicatedTotal ? gpuDedicatedUsed / gpuDedicatedTotal * 100 : 0);
      set("mGpuMemory", gpuMemoryUsed == null || gpuMemoryTotal == null ? "—" : `${gpuMemoryUsed.toFixed(1)}<span class="u">GB / ${gpuMemoryTotal.toFixed(1)}GB</span>`); width("bGpuMemory", gpuMemoryTotal ? gpuMemoryUsed / gpuMemoryTotal * 100 : 0);
      set("mVirtualMem", virtualUsed == null || virtualTotal == null ? "—" : `${virtualUsed.toFixed(1)}<span class="u">GB / ${virtualTotal.toFixed(1)}GB</span>`); width("bVirtualMem", virtualTotal ? virtualUsed / virtualTotal * 100 : 0);
      const clock = document.getElementById("monClock"); if (clock) clock.textContent = "LIVE · " + new Date().toTimeString().slice(0, 8);
      const onlinePlayers = Number(metrics?.onlinePlayers);
      set("sbPilots", Number.isFinite(onlinePlayers) && onlinePlayers >= 0 ? onlinePlayers.toLocaleString() : "—");
      set("sbSession", formatUptime(mainServerStartedAt ? (Date.now() - mainServerStartedAt) / 1000 : 0));
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
    UPDATE_INFO.changelog = Array.isArray(result.changelog) ? result.changelog : [];
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
        toast(`发现新版本 ${latest}，点击右上角更新按钮`, "ok");
      }
    } else if (result?.ok && !result.available) {
      setUpdateDot(false);
    }
  }

  setTimeout(() => checkUpdateNotice(true), 5000);
  setInterval(() => checkUpdateNotice(), UPDATE_NOTICE_INTERVAL_MS);
  window.addEventListener("focus", () => checkUpdateNotice());
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
    api.initState().then((state) => { if (state?.busy) logTo("sys", "SYS", esc(state.message || state.label || "初始化任务运行中")); }).catch(() => {});
    logTo("sys", "OK", "EVEJS COMMAND 启动器已连接 Electron 后端");
  })();
})();
