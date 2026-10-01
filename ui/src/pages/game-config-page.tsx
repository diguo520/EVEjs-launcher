import { useMemo, useState } from "react"
import { AlertTriangle, Loader2, RefreshCw, RotateCcw, Save, Search } from "lucide-react"
import { toast } from "sonner"

import { Panel, SectionHeading } from "@/components/common/panel"
import { useLocale } from "@/components/shell/locale-provider"
import { ParamRow } from "@/components/gameconfig/param-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GAME_CONFIG_DOMAINS } from "@/data/game-config-labels"
import { useGameConfig } from "@/hooks/use-game-config"
import {
  definitionsOfDomain,
  filterDefinitions,
  groupDefinitions,
  sliderSpecOf,
  type ParamFilter,
} from "@/lib/game-config-model"
import { cn } from "@/lib/utils"

/**
 * 宇宙配置。
 *
 * 数据全部来自服务端自己的配置管理器（见 src-tauri/src/gameconfig.rs 与
 * vendor/cli/game-config-cli.js），界面不发明规则：能填什么、范围多少、枚举有哪几个，
 * 都由服务端 schema 定，这里只负责画控件与提交前的即时提示。
 *
 * 保存是"改完再交"：草稿留在本地，点保存才写盘，写前服务端会整份备份 config/。
 */
export function GameConfigPage() {
  const { t } = useLocale()
  const gc = useGameConfig()
  const [domain, setDomain] = useState<string>("server")
  const [filter, setFilter] = useState<ParamFilter>({
    query: "",
    multipliersOnly: false,
    changedOnly: false,
  })

  const domainItems = useMemo(
    () => definitionsOfDomain(gc.definitions, domain),
    [gc.definitions, domain]
  )
  const visible = useMemo(
    () => filterDefinitions(domainItems, filter, gc.draft, gc.values),
    [domainItems, filter, gc.draft, gc.values]
  )
  const groups = useMemo(() => groupDefinitions(visible), [visible])

  const changedCount = Object.keys(gc.pending.patch).length
  const errorCount = Object.keys(gc.pending.errors).length
  const multiplierCount = useMemo(
    () => gc.definitions.filter((def) => sliderSpecOf(def) !== null).length,
    [gc.definitions]
  )

  async function save() {
    const reply = await gc.save()
    if (!reply.ok) {
      toast.error(t("参数没有保存"), { description: reply.reason })
      return
    }
    toast.success(t("配置保存成功"))
  }

  /* 服务端没有配置系统（目录不完整 / 老版本）时的整页说明 */
  if (gc.error && gc.definitions.length === 0) {
    return (
      <div className="space-y-4">
        <SectionHeading title="宇宙配置" sub="// UNIVERSE CONFIGURATION" />
        <Panel title="读不到服务端配置">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{gc.error}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
            这一页依赖服务端自带的配置模块（server/src/config）。
          </p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={gc.reload} disabled={gc.loading}>
              {gc.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重新读取
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        title="宇宙配置"
        sub="// UNIVERSE CONFIGURATION"
        actions={
          <div className="flex items-center gap-2">
            <span className="tabular text-[11px] text-muted-foreground">
              {gc.loading
                ? t("读取中…")
                : t("{total} 项参数 · {sliders} 项可用拉动条", {
                    total: gc.definitions.length,
                    sliders: multiplierCount,
                  })}
            </span>
            <Button variant="secondary" size="sm" onClick={gc.reload} disabled={gc.loading}>
              {gc.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重新读取
            </Button>
          </div>
        }
      />

      {/* 生效口径：只有极少数参数是热读的，其余要重启主服务 */}
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "改动写入服务端 config/ 后，除玩家连接令牌外都需要重启主服务器才生效。保存前会自动整份备份到 _local/config-backups/。"
          )}
        </p>
      </div>

      <Panel
        title="筛选"
        flush
        className="[&>header]:border-b-0"
        actions={
          <span className="tabular text-[11px] text-muted-foreground">
            {t("本域 {shown} / {total} 项", { shown: visible.length, total: domainItems.length })}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input
              value={filter.query}
              onChange={(event) => setFilter((prev) => ({ ...prev, query: event.target.value }))}
              placeholder={t("搜索参数名或中文名")}
              className="h-8 pl-8 text-[12px]"
            />
          </div>
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Switch
              checked={filter.multipliersOnly}
              aria-label="只看倍率与比例"
              onCheckedChange={(next) => setFilter((prev) => ({ ...prev, multipliersOnly: next }))}
            />
            只看倍率与比例
          </label>
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Switch
              checked={filter.changedOnly}
              aria-label="只看改动过"
              onCheckedChange={(next) => setFilter((prev) => ({ ...prev, changedOnly: next }))}
            />
            只看改动过
          </label>
        </div>
      </Panel>

      <Tabs value={domain} onValueChange={setDomain}>
        <TabsList>
          {GAME_CONFIG_DOMAINS.map((item) => {
            const count = definitionsOfDomain(gc.definitions, item.id).length
            return (
              <TabsTrigger key={item.id} value={item.id} disabled={count === 0}>
                {item.label}
                <span className="tabular text-[10px] text-tertiary">{count}</span>
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>

      {groups.length === 0 ? (
        <Panel title="没有匹配的参数">
          <p className="text-[12px] text-muted-foreground">
            换个关键词，或把「只看倍率与比例」「只看改动过」关掉。
          </p>
        </Panel>
      ) : (
        groups.map((group) => (
          <Panel
            key={group.section}
            title={group.label}
            tag={group.section}
            flush
            meta={t("{n} 项", { n: group.items.length })}
          >
            {/* 参数按两列并排铺开：167 条单列排下来太长，宽屏上右半边一直是空的 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 [&>*:last-child]:border-b-0 lg:[&>*:nth-last-child(2):nth-child(odd)]:border-b-0">
              {group.items.map((def) => {
                const text = gc.draft[def.key] ?? ""
                const changed = Object.prototype.hasOwnProperty.call(gc.pending.patch, def.key)
                return (
                  <ParamRow
                    key={def.key}
                    def={def}
                    text={text}
                    defaultValue={gc.defaults[def.key] ?? def.defaultValue}
                    envLocked={gc.envOverrides.includes(def.key)}
                    changed={changed}
                    error={gc.pending.errors[def.key]}
                    onText={(next) => gc.setValue(def.key, next)}
                    onReset={() => gc.resetToDefault(def)}
                  />
                )
              })}
            </div>
          </Panel>
        ))
      )}

      {/* 保存条：改动数 / 校验错误 / 放弃 / 保存，滚动到哪都够得着 */}
      <div
        className={cn(
          "sticky bottom-[-1.25rem] z-10 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5",
          errorCount > 0
            ? "border-destructive/40 bg-destructive/10"
            : changedCount > 0
              ? "border-primary/40 bg-primary/10"
              : "border-border bg-card"
        )}
      >
        <span className="text-[12px] text-foreground">
          {errorCount > 0
            ? t("{n} 项填写有误，先改好再保存", { n: errorCount })
            : changedCount > 0
              ? t("有 {n} 项改动待保存", { n: changedCount })
              : t("没有未保存的改动")}
        </span>
        <div className="min-w-2 flex-1" />
        <Button
          variant="secondary"
          size="sm"
          onClick={gc.discard}
          disabled={changedCount === 0 || gc.saving}
        >
          <RotateCcw />
          放弃改动
        </Button>
        <Button size="sm" onClick={save} disabled={changedCount === 0 || errorCount > 0 || gc.saving}>
          {gc.saving ? <Loader2 className="animate-spin" /> : <Save />}
          保存参数
        </Button>
      </div>
    </div>
  )
}