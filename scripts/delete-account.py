#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EvEJS 删除玩家账号工具
用法:
  python delete-account.py <账号名>                 # 预览（dry-run，不修改任何数据）
  python delete-account.py <账号名> --apply         # 执行（自动备份 sqlite 后删除）
  python delete-account.py <账号名> --db <sqlite路径>  # 指定数据库（默认探测）
说明:
  - 删除范围: accounts 行 + 该账号全部角色(characters) + 白名单私有数据表归属行
  - 白名单表按"行 key 等于角色 id / key 含 \\x1f<角色id> / json 含归属字段匹配"清理
  - killmails / chat / 公共引用表一律不清理，避免破坏他人数据
  - 种子账号(test/test2)删除后, 重建数据库会复活; 玩家注册账号删除后不会复活
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sqlite3
import sys

# 私有数据白名单: (表名, 清理方式)
#   "key"       -> 行 key 直接等于角色 id
#   "key_exact" -> 行 key 精确等于 "character:<角色id>"
#   "key_ns"    -> 行 key 含 "\x1f<角色id>" 后缀
#   "json"      -> 行 json 含归属字段(accountId/characterID/ownerID) 等于账号 id 或角色 id
#   "json_array"-> 行 json 是数组, 过滤其中归属字段匹配的元素(其余保留)
PRIVATE_TABLES = [
    ("skills", "key"),
    ("skillQueues", "key"),
    ("skillPlans", "key"),
    ("savedFittings", "key"),
    ("walletAuthorityState", "key_exact"),
    ("mail", "key_ns"),
    ("notifications", "key_ns"),
    ("items", "json"),
    ("industryJobs", "json"),
    ("industryBlueprintState", "key"),
    ("industryFacilityState", "key"),
    ("researchRuntimeState", "key"),
    ("miningLedger", "key"),
    ("missionRuntimeState", "key"),
    ("dungeonRuntimeState", "key"),
    ("bookmarks", "json"),
    ("corpSkillPlans", "key"),
    # 集合表: 行 json 为数组/dict, 只移除属于该玩家的元素
    ("structures", "json_array"),
    ("planetRuntimeState", "json_dict_colonies"),
    ("moonExtractions", "json_dict_extractions"),
]

# 归属字段匹配模式(JSON 文本形式, 兼容数字/字符串)
OWNER_FIELD_PATTERNS = ["accountId", "accountID", "characterID", "characterId", "ownerID", "ownerId"]


def find_db(default_root):
    """默认探测: 当前目录/上级/上上级 的 _local/gameStore/gamestore.sqlite"""
    here = os.path.dirname(os.path.abspath(__file__))
    for base in (os.getcwd(), here, os.path.dirname(here), os.path.dirname(os.path.dirname(here))):
        cand = os.path.join(base, "_local", "gameStore", "gamestore.sqlite")
        if os.path.exists(cand):
            return cand
    return None


def to_id_variants(value):
    """生成 id 的匹配变体: 数字、字符串、带引号"""
    return {str(value), '"%s"' % value}


def main():
    ap = argparse.ArgumentParser(description="EvEJS 删除玩家账号")
    ap.add_argument("account", help="要删除的账号名")
    ap.add_argument("--apply", action="store_true", help="执行删除（默认仅预览）")
    ap.add_argument("--db", help="gamestore.sqlite 路径（默认自动探测）")
    args = ap.parse_args()

    db = args.db or find_db(sys.argv[0])
    if not db or not os.path.exists(db):
        print("[错误] 未找到 gamestore.sqlite，请用 --db 指定路径")
        sys.exit(1)
    print("数据库: %s" % db)

    # 打开(只读用于预览)
    con = sqlite3.connect("file:%s?mode=ro" % db.replace("\\", "/"), uri=True)
    cur = con.cursor()

    # 1. 查账号（支持账号名 / 角色名反查）
    cur.execute("SELECT key, json FROM accounts WHERE key=?", (args.account,))
    row = cur.fetchone()
    if not row:
        # 按角色名反查: characters.characterName 匹配 -> accountId -> accounts.id
        cur.execute("SELECT key, json FROM characters")
        acc_key = None
        for k, j in cur.fetchall():
            d = json.loads(j)
            if d.get("characterName") == args.account:
                aid = d.get("accountId")
                cur.execute("SELECT key, json FROM accounts")
                for ak, aj in cur.fetchall():
                    ad = json.loads(aj)
                    if str(ad.get("id")) == str(aid):
                        acc_key = ak
                        row = (ak, aj)
                        break
                if row:
                    break
        if not row:
            print("[未找到] 账号/角色 '%s' 不存在" % args.account)
            con.close()
            sys.exit(1)
        print("[提示] 已按角色名 '%s' 反查到账号 key='%s'" % (args.account, acc_key))
    acc = json.loads(row[1])
    acc_id = acc.get("id")
    print("账号: %s  id=%s  isGM=%s" % (args.account, acc_id, acc.get("isGM", False)))
    if acc.get("isGM"):
        print("[警告] 这是 GM 账号，删除后可能影响服务器管理权限")

    # 2. 查角色
    cur.execute("SELECT key, json FROM characters")
    chars = []
    for k, j in cur.fetchall():
        d = json.loads(j)
        if str(d.get("accountId")) == str(acc_id):
            chars.append((k, d.get("characterName", k)))
    print("关联角色 %d 个: %s" % (len(chars), ", ".join("%s(%s)" % (k, n) for k, n in chars)))
    char_ids = [k for k, _ in chars]
    id_variants = to_id_variants(acc_id)
    for c in char_ids:
        id_variants |= to_id_variants(c)

    # 3. 统计各表将删除行数
    # plan 元素: (表名, 模式, 行级[key...] 或 集合[(key, 新json, 移除数)])
    plan = [("accounts", "row", [row]), ("characters", "row", chars)]
    for table, mode in PRIVATE_TABLES:
        try:
            cur.execute('SELECT key, json FROM "%s"' % table)
        except sqlite3.Error:
            continue
        rows = cur.fetchall()
        if mode in ("json_dict_colonies", "json_dict_extractions"):
            # 集合 dict: 遍历所有行, 过滤 key 含角色id 或值含归属字段的元素
            patch = []
            for k, j in rows:
                try:
                    obj = json.loads(j)
                except Exception:
                    continue
                if not isinstance(obj, dict) or not obj:
                    continue
                removed = 0
                if mode == "json_dict_colonies":
                    # coloniesByKey: key 形如 "<角色id>:<行星id>"
                    new_obj = {ck: cv for ck, cv in obj.items() if not any(str(c).startswith(ck.split(":")[0] + ":") for c in char_ids)}
                    removed = len(obj) - len(new_obj)
                    if removed:
                        patch.append((k, json.dumps(new_obj, ensure_ascii=False), removed))
                else:
                    # extractions: 元素含 characterID
                    new_obj = {}
                    for ek, ev in obj.items():
                        txt = json.dumps(ev, ensure_ascii=False)
                        if re.search(r'"characterID"\s*:\s*"?(\d+)"?', txt) and re.search(r'"characterID"\s*:\s*"?(\d+)"?', txt).group(1) in id_variants:
                            removed += 1
                        else:
                            new_obj[ek] = ev
                    if removed:
                        patch.append((k, json.dumps(new_obj, ensure_ascii=False), removed))
            if patch:
                plan.append((table, "patch", patch))
            continue
        hit = []
        for k, j in rows:
            if mode == "key" and k in char_ids:
                hit.append(k)
            elif mode == "key_exact" and any(k == "character:" + c for c in char_ids):
                hit.append(k)
            elif mode == "key_ns" and any(k.endswith("\x1f" + c) for c in char_ids):
                hit.append(k)
            elif mode == "json":
                for field in OWNER_FIELD_PATTERNS:
                    m = re.search(r'"%s"\s*:\s*"?(\d+)"?' % field, j)
                    if m and m.group(1) in id_variants:
                        hit.append(k)
                        break
            elif mode == "json_array":
                try:
                    arr = json.loads(j)
                except Exception:
                    continue
                if isinstance(arr, list):
                    kept = [e for e in arr if not any(
                        str(e.get(f, "")) in id_variants for f in OWNER_FIELD_PATTERNS if f in e)]
                    if len(kept) != len(arr):
                        patch_entry = (k, json.dumps(kept, ensure_ascii=False), len(arr) - len(kept))
                        # 收集到 plan 的 patch
                        existing = [p for p in plan if p[0] == table and p[1] == "patch"]
                        if existing:
                            existing[0][2].append(patch_entry)
                        else:
                            plan.append((table, "patch", [patch_entry]))
        if hit:
            plan.append((table, "row", hit))
    con.close()

    # 4. 输出计划
    total = 0
    print("\n================ 删除计划 ================")
    for table, mode, rows in plan:
        if mode == "patch":
            n = sum(r[2] for r in rows)
            print("  %-24s %d 条(集合内过滤, 保留他人数据)" % (table, n))
            total += n
        else:
            print("  %-24s %d 行" % (table, len(rows)))
            total += len(rows)
    print("==========================================")
    print("合计: %d 条" % total)
    if not args.apply:
        print("\n[预览模式] 未修改任何数据。确认无误后加 --apply 执行。")
        sys.exit(0)

    # 5. 备份 + 执行
    bak = db + ".bak-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(db, bak)
    print("\n[备份] %s" % bak)

    con = sqlite3.connect(db)
    cur = con.cursor()
    for table, mode, rows in plan:
        if table == "accounts":
            cur.execute("DELETE FROM accounts WHERE key=?", (args.account,))
            print("  [已删] %-24s 1 行" % table)
        elif table == "characters":
            for k in rows:
                cur.execute("DELETE FROM characters WHERE key=?", (k,))
            print("  [已删] %-24s %d 行" % (table, len(rows)))
        elif mode == "patch":
            for k, new_json, removed in rows:
                cur.execute('UPDATE "%s" SET json=? WHERE key=?' % table, (new_json, k))
            print("  [已清] %-24s %d 条(集合内)" % (table, sum(r[2] for r in rows)))
        else:
            for k in rows:
                cur.execute('DELETE FROM "%s" WHERE key=?' % table, (k,))
            print("  [已删] %-24s %d 行" % (table, len(rows)))
    con.commit()
    con.close()
    print("\n[完成] 账号 '%s' 已删除。请重启服务器生效（若服务正在运行）。" % args.account)


if __name__ == "__main__":
    main()
