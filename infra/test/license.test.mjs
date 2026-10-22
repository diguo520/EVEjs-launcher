/** 许可签发：契约形状、fail closed、版本闸门、签名往返、篡改必败 */
import assert from "node:assert/strict"
import crypto from "node:crypto"
import test from "node:test"

import { bytesToBase64, verifyGrant } from "../src/canonical.js"
import {
  DEFAULT_MIN_LAUNCHER_VERSION,
  DEFAULT_MODS,
  LICENSE_SCHEMA,
  isOlderThan,
  issueLicense,
  licensePolicy,
  licenseState,
  readLicenseRequest,
} from "../src/license.js"

/** 与 tests/parity 同一套：固定种子派生 Ed25519 密钥（同一个种子必得同一把） */
function fixtureKey(seedText = "evejs-launcher-license-fixture") {
  const seed = crypto.createHash("sha256").update(seedText, "utf8").digest()
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed])
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
  const raw = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12)
  return {
    signingKey: bytesToBase64(new Uint8Array(pkcs8)),
    rawBase64: bytesToBase64(new Uint8Array(raw)),
    keyId: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12),
  }
}

const KEY = fixtureKey()
const ENV = { LICENSE_SIGNING_KEY: KEY.signingKey, LICENSE_KEY_ID: KEY.keyId }
const REQUEST = {
  installId: "install-1234abcd",
  machineHash: "a".repeat(32),
  launcherVersion: DEFAULT_MIN_LAUNCHER_VERSION,
}

test("没配 secret 就 503（fail closed）", async () => {
  assert.equal(licenseState({}).ok, false)
  assert.equal(licenseState({}).status, 503)
  const result = await issueLicense({}, REQUEST)
  assert.equal(result.status, 503)
  assert.match(result.body.reason, /LICENSE_SIGNING_KEY/)
  assert.equal(licenseState({ LICENSE_SIGNING_KEY: KEY.signingKey }).status, 503)
})

test("请求体形状不对一律 400", async () => {
  const bad = [
    null,
    [],
    {},
    { ...REQUEST, installId: "short" },
    { ...REQUEST, machineHash: "zz".repeat(16) },
    { ...REQUEST, launcherVersion: "0.5" },
  ]
  for (const item of bad) {
    const result = await issueLicense(ENV, item)
    assert.equal(result.status, 400, JSON.stringify(item))
    assert.equal(result.body.ok, false)
  }
  assert.equal(readLicenseRequest(REQUEST).ok, true)
  assert.equal(readLicenseRequest({ ...REQUEST, machineHash: "A".repeat(32) }).machineHash, "a".repeat(32))
})

test("启动器太旧 → 403（这就是「强制更新」）", async () => {
  const result = await issueLicense(ENV, { ...REQUEST, launcherVersion: "0.5.4" })
  assert.equal(result.status, 403)
  assert.equal(result.body.minLauncherVersion, DEFAULT_MIN_LAUNCHER_VERSION)
  assert.match(result.body.reason, /更新启动器/)
  assert.equal(result.body.sigs, undefined)
})

test("签出来的许可是 v1 形状，且启动器侧验得过", async () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0)
  const result = await issueLicense(ENV, REQUEST, now)
  assert.equal(result.status, 200)
  const grant = result.body
  assert.equal(grant.v, LICENSE_SCHEMA)
  assert.equal(grant.launcher, "evejs-launcher")
  assert.equal(grant.installId, REQUEST.installId)
  assert.equal(grant.machineHash, REQUEST.machineHash)
  assert.deepEqual(grant.mods, [...DEFAULT_MODS])
  assert.equal(
    Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt),
    licensePolicy(ENV).ttlDays * 86400000
  )
  assert.equal(grant.sigs.length, 1)
  assert.equal(grant.sigs[0].keyId, KEY.keyId)
  assert.equal(await verifyGrant(grant, { [KEY.keyId]: KEY.rawBase64 }), true)
  assert.equal(await verifyGrant(grant, { "000000000000": KEY.rawBase64 }), false)
})

test("动过任何一个字段都验不过（签名覆盖整份许可）", async () => {
  const grant = (await issueLicense(ENV, REQUEST)).body
  const keys = { [KEY.keyId]: KEY.rawBase64 }
  assert.equal(await verifyGrant(grant, keys), true)
  const mutators = [
    (copy) => { copy.installId = "install-99999999" },
    (copy) => { copy.machineHash = "b".repeat(32) },
    (copy) => { copy.mods.push("evejs-free-lunch") },
    (copy) => { copy.expiresAt = new Date(Date.parse(copy.expiresAt) + 86400000).toISOString() },
    (copy) => { copy.v = 2 },
  ]
  for (const mutate of mutators) {
    const copy = JSON.parse(JSON.stringify(grant))
    mutate(copy)
    assert.equal(await verifyGrant(copy, keys), false)
  }
})

test("白名单可用 LICENSE_MODS 覆盖；缺省含作者的三个 parts", () => {
  for (const id of ["evejs-faction-sim", "evejs-npc-fleet", "evejs-perf-fix", "evejs-captains-quarters"]) {
    assert.ok(DEFAULT_MODS.includes(id), id)
  }
  assert.deepEqual(licensePolicy({ LICENSE_MODS: "a, b" }).mods, ["a", "b"])
  assert.equal(licensePolicy({}).minLauncherVersion, DEFAULT_MIN_LAUNCHER_VERSION)
})

test("版本比较：读不懂就当不旧（不误伤）", () => {
  assert.equal(isOlderThan("0.5.4", "0.5.5"), true)
  assert.equal(isOlderThan("0.5.5", "0.5.5"), false)
  assert.equal(isOlderThan("0.6.0", "0.5.5"), false)
  assert.equal(isOlderThan("0.5.5.1", "0.5.5"), false)
  assert.equal(isOlderThan("", "0.5.5"), false)
  assert.equal(isOlderThan("abc", "0.5.5"), false)
})
