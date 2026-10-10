# EveJS Mod Authoring Guide (creator's view)

> For **someone who wants to build a mod**: from zero to a mod that can be installed from the mod market, in **8 steps**.
> You **never modify any server file** — mods are mounted through a loader.

**What you need**: Windows 10+, an EveJS server (0.12.8 or newer), EvEJS Launcher 0.1.20+ and a GitHub account.

---

## 🎨 Colour / marker legend (read this first)

| Marker | Meaning | What to do |
| --- | --- | --- |
| 🟥 **Danger** | It will fail, error out, or cause an **irreversible** result | Never do this |
| 🟨 **Caution** | Easy to get wrong, or the result differs from what you expect | Double-check before you act |
| 🟦 **Tip** | A time saver | Feel free to use it |
| 🟩 **Recommended** | The suggested way | Just follow it |
| ✅ **Required** | You cannot continue without it | Must be done |
| ⭕ **Optional** | May be left empty | As needed |
| 🧩 **Example** | Code / config you can copy | Copy and adapt |

> GitHub Markdown, VS Code preview, Typora and friends all render these colour markers (they are emoji, **no plugin needed**).

---

## 📋 Step overview

| # | Step | Where | Rough time | Required? |
| --- | --- | --- | --- | --- |
| 1 | Check your environment (version / mods folder) | Launcher | 2 min | ✅ |
| 2 | Create your **author identity** and export `.eve-key` | Launcher | 2 min | ✅ |
| 3 | Create a **GitHub token** (classic, tick public_repo) | GitHub web | 5 min | ✅ (needed to publish and submit) |
| 4 | **Create the mod** (scaffold) | Launcher | 3 min | ✅ |
| 5 | Write your logic (`loader.js`) | Editor | depends | ✅ |
| 6 | Test locally (enable / read logs) | Launcher | 5 min | 🟩 Recommended |
| 7 | **Publish** (pack -> push to your repo -> open the review PR, one click) | Launcher | 1 min | ✅ |
| 8 | Publish an update (bump the version -> click Publish again) | Launcher | 1 min | 🟩 Recommended |
> 🟦 **Once vs every release**: steps 1-4 are once. After that every release is just **step 7** (packing, pushing to your repo and opening the review PR all happen in one click - see Part 3).

---

# Part 1: Preparation (once)

## Step 1 ✅ Check your environment

1. Open the launcher -> **Environment self-check**: Node.js / dependencies / client path and 6 more. Fix anything red first.
2. Confirm your EveJS server root (the folder containing `server/` and `config/`). Launcher -> **Configuration centre** shows the path currently in use.
3. Make sure the **`mods/` folder** exists. If not: Mod / Plugin -> **Create mods/ automatically**.

🟨 **Note**: the mod folder is always `<EveJS root>/mods/<mod id>/` — do **not** put mods anywhere else, and do not rename folders to non-ASCII names.

---

## Step 2 ✅ Create your author identity (this is "who you are")

Mod / Plugin -> **Token settings** at the top (author identity and the GitHub token live in the same dialog):

1. The Ed25519 key pair is **generated automatically** the first time you open it (there is no button)
2. Change the **signature name** (the name people see, e.g. "Commander") -> click **Save name**
3. Click **Export key** -> save the `.eve-key` file somewhere safe (USB stick / password manager)
4. Moving to a new PC: click **Import key** and pick the `.eve-key` — the identity is restored
5. **Key folder** opens the private-key directory (`_launcher/data/mod-keys/`)

You get three things:

| Thing | Meaning | Do you need to keep it? |
| --- | --- | --- |
| **Author id** (`au-...`) | Written into the mod manifest — "this mod is yours" | Written automatically |
| **Key fingerprint** (`keyId`, 12 chars) | Used to verify signatures | Written automatically |
| **`.eve-key` file** | Contains the **private key** | 🟥 Keep it safe |

🟥 **Danger**:
- **`.eve-key` is your identity.** Lose it and you can **never sign an update again** (existing users will see "signature failed"); leak it and somebody can publish as you.
- **Never** commit `.eve-key` or `_launcher/data/mod-keys/*.key`, never send it to anyone, never put it in a ZIP.

🟩 **Recommended**: back it up somewhere different from the machine you publish from.

---

## Step 3 ✅ Create a GitHub token (needed to publish and to submit)

The launcher acts on GitHub for you: when **publishing** it writes files to your own repository, creates the Release and uploads the ZIP; when **requesting a listing** it must also fork the index repository `diguo520/EVEjs-mods` (owned by the maintainer) and open a PR. A single **classic token** covers both.

### 3.1 Open the right page 🟨

```
GitHub top-right avatar -> Settings -> Developer settings at the very bottom of the left bar
  -> Personal access tokens -> Tokens (classic) -> Generate new token (classic)
```

Follow the screenshot below (the numbers match the red circles on the page):

![GitHub classic token page: (1) Tokens (classic) (2) Generate new token (classic) (3) Note (4) Expiration (5) tick repo](./github-token-classic.png)

| # | Where to click / what to fill in |
| --- | --- |
| 1 | **Tokens (classic)** in the left bar - not Fine-grained tokens above it |
| 2 | **Generate new token** -> **Generate new token (classic)** |
| 3 | **Note**: anything, e.g. `evejs-launcher` |
| 4 | **Expiration**: 90 days is fine (regenerate when it expires) |
| 5 | Under **Select scopes** tick **repo** (`public_repo` is one of its sub-items, so ticking repo covers it) |

🟥 **Do not use a fine-grained token**: its Repository access can only include repositories you have access to, so it cannot include the maintainer-owned index repository `EVEjs-mods`; forking and opening a PR both need write permission on that repository, so a fine-grained token always fails the listing with `403 Resource not accessible by personal access token`.

### 3.2 Basic fields

| Field | What to put |
| --- | --- |
| Note | Anything, e.g. `evejs-launcher` |
| Expiration | 90 days or custom (you regenerate it when it expires) |

### 3.3 Tick the scopes (the important bit) 🟨

| Scope | Tick? | Purpose |
| --- | --- | --- |
| **public_repo** | 🟩 Required | Read/write public repositories: Releases, ZIP upload, fork and PR all need it |
| **repo** | 🟨 Recommended | Includes public_repo; tick it if you also want the launcher to create repositories / manage private repos |

### 3.4 Generate and copy

Click **Generate token** -> copy the `ghp_...` string (🟨 it is shown **once only**).

### 3.5 Paste it into the launcher

Mod / Plugin -> **Token settings** -> GitHub token -> paste -> **Save** (stored encrypted on this machine; permissions are checked automatically after saving) -> done once the check passes.

> 🟦 **Why classic?** The index repository belongs to the maintainer, and a fine-grained token cannot be granted write access to it. Only authors added as a **collaborator on the index repository** can use a fine-grained token: set Repository access to `EVEjs-mods` and enable **Contents = Read and write** and **Pull requests = Read and write**.

🟨 **Note**: after changing scopes or regenerating the token, paste and save the new value again.

---

# Part 2: Building a mod

## Step 4 ✅ Create the mod (scaffold)

Mod / Plugin -> **Create mod**:

| Field | Required | Notes |
| --- | --- | --- |
| Template | ✅ | `Welcome Broadcast (Example)` (sends a welcome message, runnable) / `Blank Skeleton`. 🟩 Start with the example |
| Display name | ✅ | What players see |
| Id (folder name) | 🟩 | Generated from the name; only `a-z 0-9 - _ .`; **do not change it later** |
| Version | ✅ | Defaults to `1.0.0`; must **increase** for a new release (step 8) |
| Category | ✅ | Gameplay / Economy / AI / Visuals / Tools (the market filters on this) |
| Tags | ⭕ | Comma separated, e.g. `chat, beginner` |
| Description | 🟩 | One sentence; shown on the market card |
| Long description / Highlights | ⭕ | Written into your mod README |
| Conflicting mod ids | ⭕ | Comma separated |
| Build options | — | ☑ Restart the server (on by default), ☑ Enable right after creation (on by default), ☑ Sign right after creation (on by default) |

After clicking **Create** you get:

```
mods/<your mod id>/
├─ evejs-launcher.mod.json    <- manifest (identity, version, category, dependencies)
├─ loader.js                  <- your logic
├─ README.md                  <- generated from the long description
└─ CHANGELOG.md               <- version history
```

🟨 `loader.js` only lands as `loader.js.disabled` when you **untick** "Enable right after creation" (it is ticked by default, so the default output is a loadable `loader.js`). To switch later, use the switch on the **Installed** page — that switch is exactly this rename.

🟨 **Required manifest fields** (the launcher validates them; missing ones give "manifest validation failed"):

```
schemaVersion: 3                       <- must be 3
id / displayName / version             <- id / name / version
kind: "loader"                         <- only loader can really be enabled today
restart: "game_server"                 <- none | client | game_server | launcher
activation.strategy: "loader_rename"   <- must be this
The folder must contain loader.js or loader.js.disabled
```

---

## Step 5 ✅ Write your logic (`loader.js`)

Open `mods/<your mod id>/loader.js` — the skeleton is already there and 🟩 **the skeleton itself is a runnable minimal example** (it sends a local chat message 10 seconds after a pilot logs in). Just edit it.

🟥 **Four hard rules** (the skeleton already follows all of them; dropping any one of them breaks things):

| Rule | Why |
| --- | --- |
| `setImmediate` + entry check (`process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world"`, or the entry is `index.js`) | `NODE_OPTIONS` is inherited down npm -> server, so every wrapper process loads your file too; without the check you run in the wrong process |
| **Never `require` huge server modules** (`chatHub` pulls in about 456MB / 645 modules) | Wait until it shows up in `require.cache`, then take the reference: cache hit, zero extra memory |
| `timer.unref()` | So timers do not keep the process alive |
| Guard with `globalThis.__xxx` so you install **once** | The loader runs more than once, otherwise messages repeat and listeners pile up |

🟨 **Path rule (the one people get wrong)**: `require("./src/...")` inside a loader resolves relative to **your own mod folder**, **not** the server root — written like that it throws `MODULE_NOT_FOUND`. Compute the server root first:

```js
const path = require("path");
const serverRoot = path.resolve(__dirname, "..", "..", "server");
const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
// 🟨 do not require it here — wait until the server has loaded it, full form in Appendix B
```

🟨 **Session properties**: custom properties on chat sessions are **not synced automatically**; read/write through the APIs `chatHub` / `sessionRegistry` export or it can fail silently.

🟩 Mods that **patch server source** (rather than just calling APIs) go to **Appendix G** — do not hook `Module.prototype._compile` yourself.

---

## Step 6 🟩 Test locally

1. Mod / Plugin -> **Installed** -> find your mod -> flip the switch **on** (or tick "enable right after creation")
2. Launcher -> Control deck -> **One-click start** (brings up the main server + market service)
3. Enter the game and verify
4. Reading logs when something is wrong:
   - Launcher -> **Server logs** (filter by System / Main server / Market service / Client and INFO/WARN/ERROR)
   - The server console output (visible in the launcher)
5. 🟩 **Check whether it loaded, and how long it took**: search the server output for `[EveJS-MOD]`:
   - `loader 就绪 <your mod> 3ms` -> your loader was loaded; `loader 失败 ... :: <reason>` means it failed
   - `loaders-done total=14 failed=0 ms=1086` -> total time to load every mod
   - `<file> 注入 N 层（A -> B 字节）` -> a bus patch applied
   - `<id> 补丁失败，保留上一层结果：<reason>` -> that layer was skipped (**without** affecting other mods)

   🟨 Per-process details and every layer outcome are written to `_launcher/logs/mod-load-report.json` — use it when you need to know who changed a file.

### 🔧 Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| Card says "loader.js missing" | The file was deleted or renamed |
| The switch turns itself back off | Manifest validation failed / signature was tampered with -> see the red note on the card |
| No "loading mod" line in the log | The mod is **disabled**, or a conflict skipped it |
| The log shows `MODULE_NOT_FOUND` | `require("./src/...")` was treated as relative to the server root — it is actually relative to your mod folder (see Step 5) |
| Nothing happens in game and no error | Your guard returns early, or a `require` path is wrong |
| Node memory explodes | You `require`d a huge server module (trap 2 above) |

---

# Part 3: Publishing to the market

> **Publishing is one click**: the launcher re-signs, packs the ZIP, pushes it to your own repository (creating the repo, the Release and the upload if needed) and opens a version-review PR against the index repository, all in one go - you just watch the progress bar.
> That PR is opened for **every** version: the market only moves to your new version once it is merged.

## Step 7 ✅ Publish (one click)

Mod / Plugin -> **Publish mod** (the "Submit for review / Resubmit" button on a card in **Created by me** opens the same dialog):

1. **Select mod**: the dropdown **only lists mods you created yourself** (other people's mods never appear, so you cannot submit them by mistake)
2. Fill in the **version** and the **changelog** (the changelog goes into the index and the PR)
3. Confirm **category / tags**; **source / project URL** ⭕ optional (e.g. `https://github.com/you/your-mod`), **GitHub Releases direct link** ⭕ leave empty (the correct URL is generated during publish)
4. Tick the three declarations (your own work / no malicious code / you read the rules and listing terms)
5. Click **Publish**

Publish stays disabled until the gates at the top of the dialog are green: **author name** (step 2), **GitHub token** (step 3), **30 minutes between two submissions of the same mod** and **60 seconds between two publishes**. A missing item is highlighted in yellow with a button that takes you there.

### The four stages in the progress list

| Stage | What it does | Where it happens |
| --- | --- | --- |
| Pack the package locally | Re-sign -> pack the ZIP -> compute SHA256 -> build the listing | **On your machine only**: offline, no token needed |
| Prepare your source repository | Creates a public repository if you do not have one | Your own GitHub |
| Publish the Release and upload the package | Writes `evejs-mod.json` (the file the market reads) -> creates a Release (tag `v<version>`) -> uploads `<id>-<version>.zip` | Your own GitHub |
| Open the version-review PR | Opens a PR against the index repository: the first one also adds `sources.json` (the listing registration), later ones only update `mods/<id>.json` | Index repository `diguo520/EVEjs-mods` |

Outputs and ledger:

| Output | Location |
| --- | --- |
| ZIP | `_launcher/temp/export-<id>-<version>.zip` (the same file is uploaded to your Release) |
| Submission ledger | `_launcher/data/my-submissions.json` |

🟨 **Changed the code? Click Publish again**: any edit invalidates the signature, and the launcher re-signs, re-packs and pushes a new version for you.

### 🔧 Common errors at this step

| Error | Cause | Fix |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | Token is fine-grained, or classic without public_repo | Switch to a classic token and tick **public_repo**; the index repository belongs to the maintainer and a fine-grained token cannot reach it. If you were added as a collaborator on the index repository: use a fine-grained token with `EVEjs-mods` + Contents / Pull requests = Read and write |
| 🟥 `net::ERR_INVALID_ARGUMENT` | Old launcher ZIP upload bug | Upgrade to **0.1.20+** |
| 🟥 `404` | Repository missing, or the token does not cover it | Check the owner/repo spelling; for submissions use a classic token (public_repo / repo) |
| 🟥 `GitHub token not set` | Token never saved | Back to step 3.5 |

🟩 **On success** the dialog shows the repository and Release URLs (open them to check the ZIP is there) and the card switches to **In review**.

### Review and merge

- The maintainer reviews your mod in the PR (manifest fields, category, ZIP location, version number, ...)
- **Approved (merged)**: the index CI rebuilds immediately, the market moves to your version and every launcher can find it
- **Rejected**: the maintainer replies in the PR and the card under **Created by me** turns red with the **rejection reason**

🟨 **At least 30 minutes between two submissions of the same mod**: clicking again sooner would push a duplicate Release and refresh the same PR over and over; the dialog tells you how many minutes are left and keeps the button grey until then.

🟦 After submitting, the launcher **checks the PR once more** to confirm it really opened and records its number and state in the ledger:
the card in **Created by me** shows `In review / Merged / PR closed` (this state is re-checked at most every 30 minutes, so GitHub is not hammered).

---

## Step 8 🟩 Publish an update (bump the version -> click Publish again)

1. Bump the version: edit `"version"` in `mods/<id>/evejs-launcher.mod.json` (e.g. `1.0.1`)
   🟨 You can also regenerate through **Create mod** with the same id - but **never change the id**
2. Mod / Plugin -> **Publish mod** -> pick your mod -> fill in the version and changelog -> click **Publish**
   (same repository, new tag `v1.0.1`, new ZIP `<id>-1.0.1.zip`; the same `release/<id>` branch refreshes that PR)

🟨 **Why the version must increase**: the market compares versions to decide whether an update exists. Same version = nobody is notified.

🟦 **Why the ZIP name carries the version**: jsDelivr caches branch references for up to ~12 hours; a new file name never hits the stale cache.

---

# Part 4: Review, delisting and recovery

## What the maintainer checks

| Check | Requirement |
| --- | --- |
| Repository ownership | Must be your own repository |
| Manifest completeness | `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` / `sizeBytes` / `sha256` (64 hex) / `downloadUrls[]` |
| ZIP location | In **your own Release** (the index repo stores no binaries) |
| Category | One of Gameplay / Economy / AI / Visuals / Tools |
| Ownership rules | `id` is first-come-first-served; `author.id` is bound to the key (a changed key is rejected) |
| Server source patches | Mods that change server files must use `__evejsMods.register` (Appendix G); hooking `Module.prototype._compile` yourself will be sent back — several mods hooking it cancel each other out |

## Where you see the result

Launcher -> Mod / Plugin -> **Created by me**:

| Card state | Meaning | What you can do |
| --- | --- | --- |
| 🟩 Listed | In the market | Publish an update |
| 🟨 Update available / local is newer | Your local version is ahead | Follow step 8 |
| 🟧 Delisted | Removed by the maintainer | The card shows the **reason**; fix it and click **Resubmit for review** |
| 🟥 Not accepted | Failed review | The card shows the **reason**; fix it and click **Resubmit for review** |
| ⬜ Local only / Draft | Not published yet | Follow step 7 |

🟦 **Created by me** only shows entries whose local folder still exists or that are still installable from the market. Once you delete the local folder, entries that only exist as review records are hidden (the header shows "hidden N").

---

# Key cautions (🟥 bookmark this)

| # | Item | Consequence |
| --- | --- | --- |
| 1 | 🟥 Do not submit somebody else's mod as yours (a manifest whose `author.id` is not yours is rejected by the main process) | Submission fails |
| 2 | 🟥 Never share, commit or ZIP your `.eve-key` / private key | Identity theft, or you lose the ability to update forever |
| 3 | 🟥 Do not edit server files on disk | Your mod breaks on other machines / after every upgrade; patch in memory through `__evejsMods.register` (Appendix G) |
| 4 | 🟥 Do not `require` huge server modules from a loader | Node memory explodes |
| 5 | 🟨 Only ever increase the version | Nobody receives your update |
| 6 | 🟨 After editing the code click **Publish** again (it re-signs, re-packs and re-pushes for you) | Stale signature / the market keeps the old package |
| 7 | 🟨 Do not change the `id` after creation | Existing users see an uninstall + fresh install |
| 8 | 🟨 Keep the version in the ZIP file name | Otherwise a CDN cache may hand out the old package |
| 9 | 🟨 Use only the five fixed categories | Your mod is invisible to the market filter |
| 10 | 🟦 Install your loader once (`globalThis` guard) | Otherwise duplicate registration and repeated messages |

---

# Appendix A: manifest fields (`evejs-launcher.mod.json`)

| Field | Required | Type | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | number | must be `3` |
| `id` | ✅ | string | mod id, <= 128 chars, no path separators, prefer `a-z0-9-` |
| `displayName` | ✅ | string | shown name, <= 100 chars |
| `version` | ✅ | string | <= 64 chars, e.g. `1.0.0` |
| `kind` | ✅ | string | `loader` (usable) / `settings` / `client-package` / `source-integrated` (later) |
| `restart` | ✅ | string | `none` / `client` / `game_server` / `launcher` |
| `activation.strategy` | ✅ | string | `loader_rename` |
| `description` | ⭕ | string | <= 1000 chars (market card) |
| `category` | 🟩 | string | Gameplay / Economy / AI / Visuals / Tools |
| `tags` | ⭕ | string[] | tags |
| `author` | ✅ | object | `{ id, name, keyId, publicKey }` (written by the launcher) |
| `requires` / `loadAfter` / `loadBefore` / `conflicts` | ⭕ | string[] | dependencies and conflicts (mod ids) |
| `compatibility.evejsVersions` | ⭕ | string[] | compatible EveJS versions, e.g. `["0.12.8"]` |
| `signature` | ✅ | object | signature (generated by the launcher) |

# Appendix B: a runnable loader skeleton

This is a **condensed version of the skeleton** the launcher's "create mod" dialog generates — all four hard rules kept, ready to edit (the fully commented version lives in `mods/<your mod id>/loader.js`):

```js
"use strict";
const path = require("path");

const TAG = "[my-mod]";
const MOD_ID = "my-mod";
const POLL_MS = 3000;
const GRACE_MS = 10000;                      // wait this long after login: the session has to be ready
const MESSAGE = "Welcome back, pilot!";

// Fill this in to patch server source (the new mechanism: report through the bus, append only).
// Leave it null when you only call server APIs.
//   target — relative to the EveJS root, forward slashes
//   marker — unique marker; the bus skips the stage when it is already present (idempotent)
//   slot   — order among patches for the same file, smaller goes first (use multiples of 10)
//   append — appended code only; never rewrite the whole file
const SOURCE_PATCH = null;
// const SOURCE_PATCH = {
//   target: "server/src/network/tcp/handshake.js",
//   marker: "// my-mod:patch",
//   slot: 40,
//   append: "// my-mod:patch\nconsole.log('[my-mod] patched');",
// };

console.log(TAG + " preload ran · pid=" + process.pid);

/** Only continue in the real server process (skip npm / wrapper processes) */
function isRealServerProcess() {
  if (process.env.EVEJS_GAMESTORE_OWNER_ROLE === "world") return true;
  const entry = (require.main && require.main.filename) || process.argv[1] || "";
  return /(^|[\\/])index\.js$/i.test(entry);
}

/** Register the source patch on the injection bus (🟥 must run synchronously, see below) */
function registerSourcePatch() {
  if (!SOURCE_PATCH || !SOURCE_PATCH.target) return;
  const bus = globalThis.__evejsMods;
  if (!bus || !(Number(bus.api) >= 1)) {
    console.log(TAG + " no injection bus (old launcher), skipping the source patch");
    return;
  }
  bus.register({
    id: MOD_ID,
    target: SOURCE_PATCH.target,
    marker: SOURCE_PATCH.marker,
    slot: SOURCE_PATCH.slot,
    apply: (source) => source + "\n" + SOURCE_PATCH.append + "\n",
  });
}
// 🟥 Register synchronously: the server requires target files during startup, so registering
//    inside setImmediate is too late (the file is already compiled and the patch will not apply)
registerSourcePatch();

setImmediate(() => {
  if (!isRealServerProcess()) return;
  if (globalThis.__myModStarted) return;      // 🟨 loaded more than once: install once
  globalThis.__myModStarted = true;
  start();
});

function start() {
  // 🟥 require("./src/...") is relative to YOUR MOD FOLDER, not the server root
  const serverRoot = path.resolve(__dirname, "..", "..", "server");
  const hubPath = path.join(serverRoot, "src", "services", "chat", "chatHub.js");
  const registryPath = path.join(serverRoot, "src", "services", "chat", "sessionRegistry.js");

  // 🟨 Wait until the server itself has these two in require.cache, then take the
  //    reference: cache hit, zero extra memory, no 456MB module graph pulled in early
  const timer = setInterval(() => {
    if (!require.cache[require.resolve(hubPath)]) return;
    if (!require.cache[require.resolve(registryPath)]) return;
    clearInterval(timer);
    run(require(require.resolve(hubPath)), require(require.resolve(registryPath)));
  }, 500);
  timer.unref();
}

function run(chatHub, sessionRegistry) {
  const seen = new Set();
  const firstSeenAt = new Map();

  const timer = setInterval(() => {
    let sessions;
    try {
      sessions = sessionRegistry.getSessions() || [];
    } catch {
      return;
    }

    const now = Date.now();
    const online = new Set();

    for (const session of sessions) {
      const characterID = sessionRegistry.resolveSessionCharacterID(session);
      if (!characterID) continue;              // not actually in game yet, wait for the next round
      online.add(characterID);
      if (!firstSeenAt.has(characterID)) firstSeenAt.set(characterID, now);
      if (seen.has(characterID)) continue;
      if (now - firstSeenAt.get(characterID) < GRACE_MS) continue;

      try {
        // some session objects only carry a lowercase charid; set it once so the send is not silent
        if (!Number(session.characterID || 0)) session.characterID = characterID;
        chatHub.sendSystemMessage(session, MESSAGE);
        seen.add(characterID);
        console.log(TAG + " sent to character " + characterID);
      } catch (error) {
        console.log(TAG + " character " + characterID + " not ready, retrying: " + error.message);
      }
    }

    // forget characters that went offline so the next login triggers again
    for (const id of Array.from(seen)) if (!online.has(id)) seen.delete(id);
    for (const id of Array.from(firstSeenAt.keys())) if (!online.has(id)) firstSeenAt.delete(id);
  }, POLL_MS);
  timer.unref();
}
```

🟨 The server APIs used above are **verified working**:

| API | Purpose |
| --- | --- |
| `sessionRegistry.getSessions()` | Online sessions (🟥 **not** `list()` — that method does not exist) |
| `sessionRegistry.resolveSessionCharacterID(session)` | The character ID (0 until the pilot is actually in game) |
| `chatHub.sendSystemMessage(session, "message")` | Send a system message to that character's local channel |

Interfaces can change between EveJS versions — check what your version exports.

# Appendix C: conflicts and load order

| Type | How it happens | Consequence |
| --- | --- | --- |
| Declared conflict | Both manifests list each other in `conflicts` | They will not be enabled together |
| Duplicate `id` | Two folders declare the same `id` | Only one is loaded |
| Shared server module | Several loaders require the same server module | They may affect each other (the launcher warns) |
| Missing dependency | A mod listed in `requires` is not installed | That mod is not loaded |

🟦 Load order: drag cards in **Installed** to reorder, or hit the "⤓ move to last" button on a card. The list is grouped with enabled mods first and disabled ones after, each group in your saved order - turning a mod off needs no re-dragging, and turning it back on returns it to its old slot.
🟨 `loadAfter` / `loadBefore` in the manifest **take priority** and fine-tune the order you dragged; a mod that got moved is marked "moved by a manifest constraint" in the Load order panel.
🟦 The Load order panel shows the order that **actually takes effect**, plus the mods that **will not load** this time (broken manifest / missing dependency / conflict / no loader.js) and the ordering declarations that **had no effect** (target not installed or disabled, stale folder in the saved order). Restart the server to apply changes.

## 🟥 Several mods patching the same server file (solved by the new launcher)

When a mod **hooks `Module.prototype._compile` itself** to patch server source, two mods touching one file break each other:

- who sees the original file first depends purely on load order;
- if one of them verifies a whole-file sha256, it **fails verification** because the other one already appended content;
- observed on this setup: `自动挖矿` and `自动锁定自动集火` both append to the end of `server/src/network/tcp/handshake.js`; once the first one writes, the second sees a mismatching hash and **silently gives up** (no error, no effect).

🟩 The new launcher ships an **injection bus**: mods stop hooking anything and instead declare "which file, what to add" through `__evejsMods.register`. The bus chains them by `(slot, registration order)`, so every layer sees the **already-patched** content of the layer before it. See **Appendix G**.

# Appendix D: ZIP layout and import rules

### ZIP layout (both work, layout two is recommended)

```text
layout one: manifest at the root       layout two: wrapped in one folder (recommended)
my-mod.zip                             my-mod.zip
├── evejs-launcher.mod.json            └── my-mod/
├── loader.js.disabled                     ├── evejs-launcher.mod.json
└── README.md                              ├── loader.js.disabled
                                           └── README.md
```

The launcher finds the package root automatically; a ZIP containing **several** mod packages is rejected (one at a time).

### Rules when somebody imports your ZIP

| Rule | Notes |
| --- | --- |
| Install location | `<EveJS root>/mods/<manifest id>` (illegal id characters become `-`) |
| Initial state | **Force-disabled** (`loader.js` is renamed back to `loader.js.disabled`); the user enables it |
| Name clash | An existing folder with the same name -> import rejected |
| Missing manifest | No `evejs-launcher.mod.json` in the ZIP -> rejected |

### 🟨 Size

The mod page computes each mod's **recursive disk usage**. Ship only what is needed at runtime — 🟥 never include your source repo, `node_modules`, screenshots or `.git`.

# Appendix E: how the loader is injected

🟩 **As of the injection bus**: the launcher puts exactly **one** `--require "<the launcher's own mod-host.js>"` into `NODE_OPTIONS`, and the bus `require`s your `loader.js` in the order listed in `_launcher/mods/mod-plan.json`. So mod folders with non-ASCII names or spaces are fine, and the launcher log line `[EveJS-MOD] loaders-done total=N failed=0 ms=X` is how long loading every mod took.

🟨 **The rest of this appendix describes the legacy "one `--require` per loader" form** (now used only as a fallback when the bus cannot be written to disk): the launcher injects your `loader.js` through Node's `NODE_OPTIONS=--require ...`, therefore:

- 🟥 **Backslashes are swallowed as escape characters** -> `C:\mods\x\loader.js` becomes `C:modsxloader.js`
- 🟨 `NODE_OPTIONS` splits on spaces, so **paths containing spaces must be quoted**

The correct form is "convert to forward slashes and wrap in double quotes" — this is exactly what the launcher builds (verified):

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 You never build this yourself — you only need to remember "do not put mod folders under non-ASCII or spaced paths" so you can recognise the symptom.

# Appendix F: pre-release checklist

- [ ] The mod enables and works locally (tested in step 6)
- [ ] Mods that patch server source use `__evejsMods.register` (Appendix G) instead of hooking `_compile`
- [ ] `evejs-launcher.mod.json` has the right `id` / `version` / `category`
- [ ] The version is **higher than the previous one**
- [ ] `.eve-key` is backed up (needed when changing machines)
- [ ] `mods/<id>/` contains no private keys and no personal local paths
- [ ] You clicked **Publish mod**, all four stages finished, and the ZIP is downloadable from your own Release page
- [ ] The review PR this version opened in the index repository **has been merged** (unmerged = the market still serves the previous version)


# Appendix G: patching server source - the `__evejsMods.register` bus

🟨 Only mods that **must change server source** need this. A mod like the login greeting, which only calls server APIs, is fine with the Appendix B skeleton.

The launcher injects the bus, so you just declare your patch at the end of your loader:

```js
const bus = globalThis.__evejsMods;
if (bus && bus.api >= 1) {
  bus.register({
    id: "your-mod-id",                              // same as the manifest id; used to tag the report
    target: "server/src/network/tcp/handshake.js",  // relative to the EveJS root, forward slashes
    marker: "MY_MOD_MARK",                          // unique marker: skipped when already present
    slot: 10,                                       // order among layers on one file, lower goes first
    apply: (source) => source + "\n// MY_MOD_MARK\n// your appended code goes here\n",
  });
} else {
  // no bus (legacy launcher): fall back to your own hook, or skip patching
}
```

Four rules (🟥 breaking any of them makes other mods fail for no visible reason):

| Rule | Why |
| --- | --- |
| Use `register` only - do **not** hook `Module.prototype._compile` yourself | Hooking again brings back the race for the injection point, and the bus cannot see your change |
| `apply` must **append only** - never rewrite or delete existing content | Later layers need to build on the content you produced |
| Give `marker` a unique string nobody else uses | The bus uses it to tell whether the patch is already in place, so restarts never stack |
| To verify, check the **prefix** you patched (or a length), never a whole-file sha256 | A whole-file hash can never match once layers are chained - that locks you out |

🟩 Reading the result: a log line `[EveJS-MOD] <file> 注入 N 层（A -> B 字节）` means that layer applied; `[EveJS-MOD] <id> 补丁失败，保留上一层结果：<reason>` means it was skipped, **without** affecting the other mods.

---

**Document version**: ships with the launcher (kept in sync with `_launcher/mods/MOD_AUTHORING.en.md`).
If something is not covered here, check the launcher's **Server logs** and the red notes on the card first, then ask the maintainer with the log at hand.