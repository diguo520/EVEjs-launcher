# EveJS Mod Authoring Guide (creator's view)

> For **someone who wants to build a mod**: from zero to a mod that can be installed from the mod market, in **10 steps**.
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
| 3 | Create a **GitHub token** (fine-grained) | GitHub web | 5 min | ✅ (needed to publish) |
| 4 | **Create the mod** (scaffold) | Launcher | 3 min | ✅ |
| 5 | Write your logic (`loader.js`) | Editor | depends | ✅ |
| 6 | Test locally (enable / read logs) | Launcher | 5 min | 🟩 Recommended |
| 7 | **1) Generate and pack** | Launcher | 1 min | ✅ |
| 8 | **2) Publish to my repo** | Launcher | 1 min | ✅ |
| 9 | **3) Request listing** (one-off PR) | Launcher | 1 min | ✅ |
| 10 | Publish an update (bump version -> repeat 7, 8) | Launcher | 1 min | 🟩 Recommended |

> 🟦 **Once vs every release**: steps 1-4 are once. For a new version you only repeat **7 -> 8** (the step 9 PR is a one-time thing).

---

# Part 1: Preparation (once)

## Step 1 ✅ Check your environment

1. Open the launcher -> **Environment self-check**: Node.js / dependencies / client path and 6 more. Fix anything red first.
2. Confirm your EveJS server root (the folder containing `server/` and `config/`). Launcher -> **Configuration centre** shows the path currently in use.
3. Make sure the **`mods/` folder** exists. If not: Mod / Plugin -> **Create mods folder**.

🟨 **Note**: the mod folder is always `<EveJS root>/mods/<mod id>/` — do **not** put mods anywhere else, and do not rename folders to non-ASCII names.

---

## Step 2 ✅ Create your author identity (this is "who you are")

Mod / Plugin -> **Author identity** at the top:

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

## Step 3 ✅ Create a GitHub token (used when publishing)

Publishing means the launcher acts on **your own GitHub repository** on your behalf, so it needs a token. Six sub-steps:

### 3.1 Open the right page 🟨

```
GitHub top-right avatar -> Settings -> Developer settings at the very bottom of the left bar
  -> Personal access tokens -> Fine-grained tokens -> Generate new token
```

🟥 **Do not use `Tokens (classic)`**: that page only has scopes like `repo` / `workflow` and **no** `Contents` / `Pull requests`.

### 3.2 Basic fields

| Field | What to put |
| --- | --- |
| Token name | Anything, e.g. `evejs-launcher` |
| Expiration | 90 days or custom (you regenerate it when it expires) |
| Description | Optional |

### 3.3 Resource owner and repository access

- **Resource owner**: your own account
- **Repository access**: 🟩 **All repositories** (simplest; with selected repositories only, a newly created repo is not covered and you get 404)

### 3.4 Tick the permissions (the important bit) 🟨

Scroll to **Permissions** -> expand **Repository permissions** (🟥 not Account permissions) and tick these four:

| Permission | Set to | Purpose | If you skip it |
| --- | --- | --- | --- |
| **Contents** | Read and write | Write `evejs-mod.json`, create the Release, upload the ZIP | 403 writing the listing / creating the Release |
| **Pull requests** | Read and write | Open the listing PR in step 9 | 403 on Request listing |
| **Administration** | Read and write | Let step 8 **create the repository** | `403 Resource not accessible` when creating the repo |
| **Metadata** | Read-only | GitHub ticks it automatically | — |

> 🟦 If you prefer to create the repository manually, you can skip Administration — but create the repo on GitHub first and fill `owner/repo` into **My repo** in the launcher.

### 3.5 Generate and copy

Click **Generate token** -> copy the `github_pat_...` string (🟨 it is shown **once only**).

### 3.6 Paste it into the launcher

Mod / Plugin -> **Submit mod** -> GitHub token -> paste -> **Save** (stored encrypted on this machine) -> **Check** to confirm it works.

🟨 **Note**: after changing token permissions or generating a new one, paste and save the new value again.

---

# Part 2: Building a mod

## Step 4 ✅ Create the mod (scaffold)

Mod / Plugin -> **Create mod**:

| Field | Required | Notes |
| --- | --- | --- |
| Template | ✅ | `Welcome Broadcast (Example)` (sends a welcome message, runnable) / `Blank Skeleton`. 🟩 Start with the example |
| Display name | ✅ | What players see |
| Id (folder name) | 🟩 | Generated from the name; only `a-z 0-9 - _ .`; **do not change it later** |
| Version | ✅ | Defaults to `1.0.0`; must **increase** for a new release (step 10) |
| Category | ✅ | Gameplay / Economy / AI / Visuals / Tools (the market filters on this) |
| Tags | ⭕ | Comma separated, e.g. `chat, beginner` |
| Description | 🟩 | One sentence; shown on the market card |
| Long description / Highlights | ⭕ | Written into your mod README |
| Conflicting mod ids | ⭕ | Comma separated |
| Build options | — | ☑ Restart the server (on by default), ☐ Enable right after creation, ☑ Sign right after creation |

After clicking **Create** you get:

```
mods/<your mod id>/
├─ evejs-launcher.mod.json    <- manifest (identity, version, category, dependencies)
├─ loader.js                  <- your logic
├─ loader.js.disabled         <- name while disabled (renamed to loader.js when enabled)
├─ README.md                  <- generated from the long description
└─ CHANGELOG.md               <- version history
```

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

Open `mods/<your mod id>/loader.js` — a skeleton is already there. The idea is simple: **hook into modules the server already has**.

```js
// 🧩 Minimal example: send a local chat message when a player logs in
const chatHub = require('./src/services/chat/chatHub');        // path is resolved from the server root
const sessionRegistry = require('./src/services/chat/sessionRegistry');

// 🟨 Always guard: the loader runs more than once, without the guard you register twice
if (!globalThis.__myModInstalled) {
  globalThis.__myModInstalled = true;
  // hook your logic here
}
```

🟥 **Three traps you will hit**:

1. **It runs more than once** -> guard with `globalThis.__xxx` so you only install once, otherwise messages repeat and listeners pile up.
2. **Never `require` huge server modules** (the whole `server`, world models, ...) -> Node memory blows up (measured).
3. **Session properties**: custom properties on chat sessions are **not synced automatically**; read/write through the `chatHub` API or it can fail silently.

🟨 **Path rule**: `require('./src/...')` inside a loader resolves relative to the **server root**, not to your mod folder.

---

## Step 6 🟩 Test locally

1. Mod / Plugin -> **Installed** -> find your mod -> flip the switch **on** (or tick "enable right after creation")
2. Launcher -> Control deck -> **One-click start** (brings up the main server + market service)
3. Enter the game and verify
4. Reading logs when something is wrong:
   - Launcher -> **Server logs** (filter by System / Main server / Market service / Client and INFO/WARN/ERROR)
   - The server console output (visible in the launcher)

### 🔧 Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| Card says "loader.js missing" | The file was deleted or renamed |
| The switch turns itself back off | Manifest validation failed / signature was tampered with -> see the red note on the card |
| No "loading mod" line in the log | The mod is **disabled**, or a conflict skipped it |
| Nothing happens in game and no error | Your guard returns early, or a `require` path is wrong |
| Node memory explodes | You `require`d a huge server module (trap 2 above) |

---

# Part 3: Publishing to the market

> This is exactly the `1) 2) 3)` steps inside the launcher's **Submit mod** dialog.

## Step 7 ✅ 1) Generate and pack (fully offline)

Mod / Plugin -> **Submit mod**:

1. **Select mod**: the dropdown **only lists your own mods** (other people's mods never appear)
2. Fill in the **changelog** (goes into the index and the PR)
3. Confirm **category / tags** (pre-filled from the manifest)
4. **Source / project URL** ⭕ (optional, e.g. `https://github.com/you/your-mod`)
5. **GitHub Releases direct link** ⭕ leave empty (step 8 generates the correct one)
6. Click **`1) Generate and pack`**

What this does (**offline, no token needed**):

```
re-sign -> pack the ZIP -> compute SHA256 -> build the listing
```

Outputs:

| Output | Location |
| --- | --- |
| ZIP | `_launcher/temp/export-<id>-<version>.zip` |
| Submission ledger | `_launcher/data/my-submissions.json` |
| Index shard (JSON) | Shown in the dialog, copyable |

🟨 **Note**: after changing code, click **`1)`** again — editing invalidates the signature and the launcher re-signs it for you.

---

## Step 8 ✅ 2) Publish to my repo

1. **My repo** (optional): leave empty and the launcher creates `evejs-mod-<id>`, or fill `owner/repo`
2. Click **`2) Publish to my repo`**
3. Watch the **progress bar**:

```
Verify GitHub token -> Prepare repo -> Write evejs-mod.json -> Create Release -> Upload ZIP (slowest) -> Done
   5%                 20%             40%                    60%             75%                      100%
```

It does four things for you (only touching **your own repository**, never the index repo):

1. Creates a public repository if needed
2. Writes `evejs-mod.json` (this is the file the market reads)
3. Creates a Release with tag `v<version>`
4. Uploads the ZIP named `<id>-<version>.zip`

### 🔧 Common errors at this step

| Error | Cause | Fix |
| --- | --- | --- |
| 🟥 `403 Resource not accessible by personal access token` | Token lacks permissions | Add **Administration = Read and write** (to auto-create the repo) and **Contents = Read and write**; set Repository access to All repositories |
| 🟥 `net::ERR_INVALID_ARGUMENT` | Old launcher ZIP upload bug | Upgrade to **0.1.20+** |
| 🟥 `404` | Repository missing, or the token does not cover it | Check the owner/repo spelling; set Repository access to All repositories |
| 🟥 `GitHub token not set` | Token never saved | Back to step 3.6 |

🟩 **On success** the dialog shows the repository and Release URLs — open them and check the ZIP is there.

---

## Step 9 ✅ 3) Request listing (once in your life)

Click **`3) Request listing`** -> the launcher opens a PR against the index repository (adding one line to `sources.json`).

- The maintainer reviews your mod in the PR (manifest fields, category, ZIP location, ...)
- **Approved**: after the merge CI aggregates your mod into the market within tens of minutes
- **Rejected**: the maintainer replies in the PR, and the card in your launcher's **My mods** turns red with the **rejection reason**

🟦 Afterwards, **new versions need no further PR**: you push to your own repository and the index refreshes (step 10).

---

## Step 10 🟩 Publish an update (repeat 7 -> 8)

1. Bump the version: edit `"version"` in `mods/<id>/evejs-launcher.mod.json` (e.g. `1.0.1`)
   🟨 You can also regenerate through **Create mod** with the same id — but **never change the id**
2. Mod / Plugin -> **Submit mod** -> pick your mod -> **`1) Generate and pack`**
3. **`2) Publish to my repo`** (same repository, new tag `v1.0.1`, new ZIP `<id>-1.0.1.zip`)

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

## Where you see the result

Launcher -> Mod / Plugin -> **My mods**:

| Card state | Meaning | What you can do |
| --- | --- | --- |
| 🟩 Listed | In the market | Publish an update |
| 🟨 Update available / local is newer | Your local version is ahead | Follow step 10 |
| 🟧 Delisted | Removed by the maintainer | The card shows the **reason**; fix it and click **Resubmit for review** |
| 🟥 Not accepted | Failed review | The card shows the **reason**; fix it and click **Resubmit for review** |
| ⬜ Local only / Draft | Not published yet | Follow steps 7 and 8 |

🟦 **My mods** only shows entries whose local folder still exists or that are still installable from the market. Once you delete the local folder, entries that only exist as review records are hidden (the header shows "hidden N").

---

# Key cautions (🟥 bookmark this)

| # | Item | Consequence |
| --- | --- | --- |
| 1 | 🟥 Do not submit somebody else's mod as yours (a manifest whose `author.id` is not yours is rejected by the main process) | Submission fails |
| 2 | 🟥 Never share, commit or ZIP your `.eve-key` / private key | Identity theft, or you lose the ability to update forever |
| 3 | 🟥 Do not modify any server file | Your mod breaks on other machines / after every upgrade |
| 4 | 🟥 Do not `require` huge server modules from a loader | Node memory explodes |
| 5 | 🟨 Only ever increase the version | Nobody receives your update |
| 6 | 🟨 For a new version redo `1)` (re-sign) and `2)` (re-upload) | Stale signature / the market keeps the old package |
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

```js
/**
 * Runs more than once: always install only once.
 * require paths resolve from the SERVER ROOT; never require huge server modules.
 */
if (!globalThis.__myFirstMod) {
  globalThis.__myFirstMod = true;

  const sessionRegistry = require('./src/services/chat/sessionRegistry');
  const chatHub = require('./src/services/chat/chatHub');

  // 🟨 There is a grace period after login: the session may not be ready yet, so wait a bit
  const timer = setInterval(() => {
    try {
      const online = sessionRegistry.list ? sessionRegistry.list() : [];
      for (const s of online) {
        if (s && s.characterId && !globalThis.__greeted?.[s.characterId]) {
          globalThis.__greeted = globalThis.__greeted || {};
          globalThis.__greeted[s.characterId] = true;
          chatHub.sendSystemMessage(s, 'Welcome back, pilot');
        }
      }
    } catch (e) {
      // failing silently beats taking the whole server down
    }
  }, 5000);
  timer.unref?.();
}
```

🟨 The server APIs used above are **verified working**: `src/services/chat/sessionRegistry` (online sessions) and `src/services/chat/chatHub` (system messages). Interfaces can change between EveJS versions — check what your version exports.

# Appendix C: conflicts and load order

| Type | How it happens | Consequence |
| --- | --- | --- |
| Declared conflict | Both manifests list each other in `conflicts` | They will not be enabled together |
| Duplicate `id` | Two folders declare the same `id` | Only one is loaded |
| Shared server module | Several loaders require the same server module | They may affect each other (the launcher warns) |
| Missing dependency | A mod listed in `requires` is not installed | That mod is not loaded |

🟦 Load order: drag cards in **Installed** to reorder; the order is stored in `_launcher/mods/mod-order.json`. `loadAfter` / `loadBefore` in the manifest take priority.

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

# Appendix E: how the loader is injected (the NODE_OPTIONS trap)

The launcher injects your `loader.js` through Node's `NODE_OPTIONS=--require ...`, therefore:

- 🟥 **Backslashes are swallowed as escape characters** -> `C:\mods\x\loader.js` becomes `C:modsxloader.js`
- 🟨 `NODE_OPTIONS` splits on spaces, so **paths containing spaces must be quoted**

The correct form is "convert to forward slashes and wrap in double quotes" — this is exactly what the launcher builds (verified):

```js
const requireArgs = paths.map((p) => '--require "' + p.replace(/\\/g, "/") + '"').join(" ");
```

🟦 You never build this yourself — you only need to remember "do not put mod folders under non-ASCII or spaced paths" so you can recognise the symptom.

# Appendix F: pre-release checklist

- [ ] The mod enables and works locally (tested in step 6)
- [ ] `evejs-launcher.mod.json` has the right `id` / `version` / `category`
- [ ] The version is **higher than the previous one**
- [ ] `.eve-key` is backed up (needed when changing machines)
- [ ] `mods/<id>/` contains no private keys and no personal local paths
- [ ] You ran `1) Generate and pack` -> `2) Publish to my repo` (the ZIP is downloadable from the Release page)
- [ ] First release: you ran `3) Request listing` and saw the maintainer's reply in the PR

---

**Document version**: ships with the launcher (kept in sync with `_launcher/mods/MOD_AUTHORING.en.md`).
If something is not covered here, check the launcher's **Server logs** and the red notes on the card first, then ask the maintainer with the log at hand.