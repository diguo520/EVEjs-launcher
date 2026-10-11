import { useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Loader2, Pause, Play, Rocket, Stethoscope, Zap } from "lucide-react"
import { toast } from "sonner"

import { Panel, StatTile } from "@/components/common/panel"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useLocale } from "@/components/shell/locale-provider"
import { useFactionData, type FactionController } from "@/hooks/use-faction"
import {
  formatSimClock,
  formatSpeed,
  relationKind,
  relationsFor,
  nameOf,
  type RelationPair,
  type RosterEntry,
} from "@/lib/faction-logic"
import { formatQty } from "@/lib/market-logic"
import { cn } from "@/lib/utils"
import { FactionNumber, FactionSelect, FactionTag, PanelState } from "./faction-shared"

interface ControlRow {
  key: string
  name: string
  color: string
  tier: string
  paused: boolean
  posture?: { phase: string; forced: string | null } | null
}

interface TempoRow {
  name: string
  value: number
  file: number
  override: boolean
  label: string | null
}

interface ControlEvent {
  id: number
  at: number
  text: string
}

interface ControlPayload {
  now: number
  speed: number
  paused: boolean
  factions: RosterEntry[]
  rows: ControlRow[]
  paging: { total: number; page: number; pages: number; size: number }
  relations: RelationPair[]
  relFocus: string | null
  overrides: Record<string, string>
  tempo: TempoRow[]
  advisors: { id: string; label: string }[]
  actions: string[]
  destructive: string[]
  recent: ControlEvent[]
}

interface DeployScenario {
  id: string
  name: string
  description?: string
  factions?: string[]
  ok?: boolean
  errors?: string[]
}

interface DeployPayload {
  now: number
  active?: { id: string; name: string; appliedAt: number } | null
  defaultID: string
  scenarios: DeployScenario[]
}

const SPEEDS = [0.5, 1, 2, 5, 10, 50, 100]

/**
 * P6 GM 控制：全局推演开关、倍速与快进、剧本部署、外交关系、诊断包。
 *
 * 两条硬规矩：
 *   1. **参数校验在面板那边**（每一个动作的范围 / 枚举 / 上限都由模组判定），
 *      启动器只负责把参数原样送过去、把拒绝原因原样显示出来，不在这里抄第二套规则；
 *   2. **破坏性动作先二次确认**（模组的 `DESTRUCTIVE` 名单：改关系 / 快进 / 部署 / 改库存 / 开会战），
 *      确认用启动器自己的 AlertDialog，和账号删除同一套交互。
 */
export function FactionControl({
  faction,
  roster,
  colorByKey,
}: {
  faction: FactionController
  roster: Map<string, RosterEntry>
  colorByKey: Map<string, string>
}) {
  const { t } = useLocale()
  const [focus, setFocus] = useState("")
  const [busy, setBusy] = useState("")
  const [speed, setSpeed] = useState(1)
  const [ffMinutes, setFfMinutes] = useState(60)
  const [deployID, setDeployID] = useState("")
  const [deployConfirm, setDeployConfirm] = useState("")
  const [relationQuery, setRelationQuery] = useState("")

  const control = useFactionData<ControlPayload>(faction.api, "/api/control", {
    query: { size: 40, ...(focus ? { rel: focus } : {}) },
    intervalMs: 10_000,
    enabled: faction.available,
  })
  const deploy = useFactionData<DeployPayload>(faction.api, "/api/deploy", {
    intervalMs: 30_000,
    enabled: faction.available,
  })

  const data = control.data
  const activeKey = focus || data?.relFocus || ""

  const lookup = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>()
    for (const [key, entry] of roster) map.set(key, { name: entry.name, color: entry.color })
    for (const row of data?.factions ?? []) {
      if (!map.has(row.key)) map.set(row.key, { name: row.name, color: row.color })
    }
    return map
  }, [roster, data?.factions])

  const relations = useMemo(
    () => relationsFor(activeKey, data?.relations ?? [], lookup),
    [activeKey, data?.relations, lookup]
  )
  const filteredRelations = useMemo(() => {
    const query = relationQuery.trim().toLowerCase()
    if (!query) return relations
    return relations.filter(
      (row) => row.name.toLowerCase().includes(query) || row.key.toLowerCase().includes(query)
    )
  }, [relations, relationQuery])

  const destructive = useMemo(() => new Set(data?.destructive ?? []), [data?.destructive])

  async function run(action: string, params: Record<string, unknown>, label: string) {
    setBusy(action)
    try {
      const reply = await faction.act(action, params)
      if (reply.ok) {
        toast.success(t("已执行：{label}", { label }))
        control.reload()
      }
    } finally {
      setBusy("")
    }
  }

  const paused = data?.paused ?? faction.probe?.status?.paused ?? false
  const currentSpeed = data?.speed ?? faction.probe?.status?.speed ?? 1
  const scenario = deploy.data?.scenarios ?? []

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t("推演状态")}
          value={paused ? t("已暂停") : t("运行中")}
          tone={paused ? "warning" : "success"}
          delta={`${t("倍速")} ${formatSpeed(currentSpeed)}`}
        />
        <StatTile label={t("推演时钟")} value={formatSimClock(data?.now ?? 0)} tone="foreground" />
        <StatTile
          label={t("当前剧本")}
          value={deploy.data?.active?.name ?? "—"}
          tone="primary"
          delta={deploy.data?.active ? formatSimClock(deploy.data.active.appliedAt) : undefined}
        />
        <StatTile
          label={t("可执行动作")}
          value={data?.actions?.length ?? 0}
          tone="telemetry"
          delta={t("其中破坏性 {n} 个", { n: data?.destructive?.length ?? 0 })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// CLOCK" title={t("推演控制")}>
          <PanelState loading={control.loading && !data} error={control.error} onRetry={control.reload}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {paused ? (
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => run("resume", {}, t("继续推演"))}
                    className="inline-flex items-center gap-1.5 rounded border border-success/50 px-2.5 py-1 text-[12px] text-success transition-colors hover:bg-success/10 disabled:opacity-50"
                  >
                    {busy === "resume" ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                    {t("继续推演")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => run("pause", {}, t("暂停推演"))}
                    className="inline-flex items-center gap-1.5 rounded border border-warning/50 px-2.5 py-1 text-[12px] text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
                  >
                    {busy === "pause" ? <Loader2 className="size-3 animate-spin" /> : <Pause className="size-3" />}
                    {t("暂停推演")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() => run("diag", {}, t("导出诊断包"))}
                  className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  {busy === "diag" ? <Loader2 className="size-3 animate-spin" /> : <Stethoscope className="size-3" />}
                  {t("导出诊断包")}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="panel-label">{t("倍速")}</span>
                <FactionSelect
                  value={String(speed)}
                  onChange={(next) => setSpeed(Number(next))}
                  ariaLabel={t("倍速")}
                  className="w-[86px]"
                  options={SPEEDS.map((item) => ({ value: String(item), label: `${item}×` }))}
                />
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() => run("speed", { value: speed }, t("设置倍速 {n}×", { n: speed }))}
                  className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  {t("应用")}
                </button>
                <span className="text-[11px] text-tertiary">
                  {t("当前 {n}×", { n: currentSpeed })}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="panel-label">{t("快进")}</span>
                <FactionNumber
                  value={ffMinutes}
                  onChange={setFfMinutes}
                  min={1}
                  max={10080}
                  step={30}
                  ariaLabel={t("快进分钟数")}
                />
                <span className="text-[11px] text-tertiary">{t("分钟")}</span>
                <ConfirmAction
                  label={t("快进 {n} 分钟", { n: ffMinutes })}
                  title={t("确认快进")}
                  description={t(
                    "推演会立刻推进 {n} 分钟：这段时间里矿山会挖空、货物会送达、舰队会开出去。这一步不能撤销。",
                    { n: ffMinutes }
                  )}
                  disabled={busy !== "" || !(ffMinutes >= 1 && ffMinutes <= 10080)}
                  destructive={destructive.has("ff")}
                  onConfirm={() => run("ff", { minutes: ffMinutes }, t("快进 {n} 分钟", { n: ffMinutes }))}
                />
              </div>
            </div>
          </PanelState>
        </Panel>

        <Panel tag="// DEPLOY" title={t("剧本部署")}>
          <PanelState loading={deploy.loading && !deploy.data} error={deploy.error} onRetry={deploy.reload}>
            <div className="space-y-3">
              <div className="text-[11.5px] text-muted-foreground">
                {t("当前剧本")}：
                <span className="text-foreground">{deploy.data?.active?.name ?? "—"}</span>
              </div>
              <div className="max-h-[140px] space-y-1 overflow-y-auto pr-1">
                {scenario.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setDeployID(item.id)
                      setDeployConfirm("")
                    }}
                    className={cn(
                      "block w-full rounded border px-2 py-1 text-left text-[11.5px] transition-colors",
                      deployID === item.id
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground hover:border-primary/60"
                    )}
                  >
                    <span className="text-foreground">{item.name}</span>
                    <span className="ml-2 text-[10px] text-tertiary">{item.id}</span>
                    {item.description ? (
                      <span className="mt-0.5 block line-clamp-2 text-[10.5px] text-tertiary">
                        {item.description}
                      </span>
                    ) : null}
                  </button>
                ))}
                {scenario.length === 0 ? (
                  <div className="py-4 text-center text-[11px] text-tertiary">{t("没有可用剧本")}</div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={deployConfirm}
                  onChange={(event) => setDeployConfirm(event.target.value)}
                  placeholder={t("输入剧本 id 确认")}
                  className="h-6 w-44 rounded border border-input bg-transparent px-2 text-[11px] text-foreground placeholder:text-tertiary focus:border-primary focus:outline-none"
                />
                <ConfirmAction
                  label={t("部署剧本")}
                  title={t("确认部署剧本")}
                  description={t(
                    "部署会把当前世界快速推进到剧本开局：现有势力、库存与舰队都会被剧本重写（面板会先自动备份）。"
                  )}
                  disabled={busy !== "" || !deployID || deployConfirm !== deployID}
                  destructive
                  icon={<Rocket className="size-3" />}
                  onConfirm={() => run("deploy", { id: deployID, confirm: deployConfirm }, t("部署剧本 {id}", { id: deployID }))}
                />
              </div>
              <div className="text-[11px] text-tertiary">
                {t("要按面板的规矩把剧本 id 原样再打一遍，防止手滑。")}
              </div>
            </div>
          </PanelState>
        </Panel>
      </div>

      <Panel
        tag="// DIPLOMACY"
        title={t("外交关系")}
        meta={t("焦点：{name}", { name: nameOf(roster, activeKey) })}
        actions={
          <div className="flex items-center gap-1.5">
            <input
              value={relationQuery}
              onChange={(event) => setRelationQuery(event.target.value)}
              placeholder={t("筛选对方")}
              className="h-6 w-28 rounded border border-input bg-transparent px-2 text-[11px] text-foreground placeholder:text-tertiary focus:border-primary focus:outline-none"
            />
            <FactionSelect
              value={activeKey}
              onChange={setFocus}
              ariaLabel={t("外交焦点")}
              placeholder={t("选择势力")}
              className="w-[150px]"
              options={(data?.factions ?? []).map((item) => ({ value: item.key, label: item.name }))}
            />
          </div>
        }
      >
        <PanelState loading={control.loading && !data} error={control.error} onRetry={control.reload}>
          <div className="max-h-[320px] overflow-y-auto pr-1">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10px] uppercase text-tertiary">
                <tr>
                  <th className="pb-1.5 font-normal">{t("对方")}</th>
                  <th className="pb-1.5 font-normal">{t("关系")}</th>
                  <th className="pb-1.5 font-normal">{t("改为")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRelations.slice(0, 60).map((row) => (
                  <tr key={row.key} className="border-t border-border/60">
                    <td className="py-1 pr-2">
                      <FactionTag name={row.name} color={row.color} />
                    </td>
                    <td className="py-1 pr-2">
                      <span
                        className={cn(
                          "rounded-sm border px-1.5 py-0.5 text-[10px]",
                          row.relation === "hostile"
                            ? "border-destructive/50 text-destructive"
                            : row.relation === "friendly"
                              ? "border-success/50 text-success"
                              : "border-border text-muted-foreground"
                        )}
                      >
                        {relationLabel(row.relation, t)}
                      </span>
                    </td>
                    <td className="py-1">
                      <div className="flex gap-1">
                        {(["hostile", "neutral", "friendly"] as const).map((kind) => (
                          <ConfirmAction
                            key={kind}
                            label={relationLabel(kind, t)}
                            title={t("确认改关系")}
                            description={t("把 {a} 与 {b} 的关系改成「{kind}」。面板会把两边都改，并记一条 GM 操作。", {
                              a: nameOf(roster, activeKey),
                              b: row.name,
                              kind: relationLabel(kind, t),
                            })}
                            disabled={busy !== "" || row.relation === kind}
                            destructive={destructive.has("relation")}
                            compact
                            onConfirm={() =>
                              run(
                                "relation",
                                { a: activeKey, b: row.key, relation: kind },
                                t("{a} ↔ {b}：{kind}", {
                                  a: nameOf(roster, activeKey),
                                  b: row.name,
                                  kind: relationLabel(kind, t),
                                })
                              )
                            }
                          />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRelations.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-muted-foreground">{t("没有关系记录")}</div>
            ) : null}
          </div>
        </PanelState>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel tag="// TEMPO" title={t("节奏参数")} meta={t("共 {n} 项", { n: data?.tempo?.length ?? 0 })}>
          <PanelState loading={control.loading && !data} error={control.error} onRetry={control.reload}>
            <div className="max-h-[300px] overflow-y-auto pr-1">
              <table className="w-full text-left text-[11.5px]">
                <thead className="text-[10px] uppercase text-tertiary">
                  <tr>
                    <th className="pb-1.5 font-normal">{t("项")}</th>
                    <th className="pb-1.5 font-normal">{t("当前")}</th>
                    <th className="pb-1.5 font-normal">{t("文件值")}</th>
                    <th className="pb-1.5 font-normal">{t("说明")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.tempo ?? []).map((row) => (
                    <tr key={row.name} className="border-t border-border/60">
                      <td className="py-1 pr-2 text-foreground">{row.name}</td>
                      <td
                        className={cn(
                          "py-1 pr-2 tabular",
                          row.override ? "text-warning" : "text-muted-foreground"
                        )}
                      >
                        {row.value}×
                      </td>
                      <td className="py-1 pr-2 tabular text-tertiary">{row.file}×</td>
                      <td className="py-1 text-[10.5px] text-tertiary">{row.label ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PanelState>
        </Panel>

        <Panel tag="// LOG" title={t("最近的面板操作")} meta={t("共 {n} 条", { n: data?.recent?.length ?? 0 })}>
          <PanelState loading={control.loading && !data} error={control.error} onRetry={control.reload}>
            <div className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
              {(data?.recent ?? []).map((row) => (
                <div key={row.id} className="flex items-baseline gap-2 text-[11.5px]">
                  <span className="tabular shrink-0 text-tertiary">
                    {new Date(row.at).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                  <span className="min-w-0 flex-1 text-muted-foreground">{row.text}</span>
                </div>
              ))}
              {(data?.recent ?? []).length === 0 ? (
                <div className="py-6 text-center text-[12px] text-muted-foreground">{t("还没有面板操作")}</div>
              ) : null}
            </div>
          </PanelState>
        </Panel>
      </div>

      <Panel tag="// FACTIONS" title={t("逐家暂停 / 继续")} meta={t("共 {n} 家", { n: data?.paging.total ?? 0 })}>
        <PanelState loading={control.loading && !data} error={control.error} onRetry={control.reload}>
          <div className="flex flex-wrap gap-1.5">
            {(data?.rows ?? []).map((row) => (
              <button
                key={row.key}
                type="button"
                disabled={busy !== ""}
                onClick={() =>
                  run(
                    row.paused ? "resume" : "pause",
                    { key: row.key },
                    row.paused ? t("继续 {name}", { name: row.name }) : t("暂停 {name}", { name: row.name })
                  )
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] transition-colors disabled:opacity-50",
                  row.paused
                    ? "border-warning/50 text-warning"
                    : "border-border text-muted-foreground hover:border-primary/60"
                )}
              >
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: colorByKey.get(row.key) ?? "#64748b" }}
                />
                {row.name}
                {row.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
              </button>
            ))}
            {(data?.rows ?? []).length === 0 ? (
              <div className="w-full py-6 text-center text-[12px] text-muted-foreground">{t("没有势力行")}</div>
            ) : null}
          </div>
          <div className="mt-3 text-[11px] text-tertiary">
            {t("面板一页给 {n} 家，剩下的在面板自己的分页里。", { n: data?.paging.size ?? 0 })}
            <span className="ml-2">
              {t("顾问 {n} 位", { n: data?.advisors?.length ?? 0 })}
            </span>
            <span className="ml-2">
              {t("可执行动作 {n} 个", { n: data?.actions?.length ?? 0 })}
            </span>
            <span className="ml-2 inline-flex items-center gap-1">
              <Zap className="size-3" />
              {t("面板累计操作 {n} 条", { n: formatQty(data?.recent?.length ?? 0) })}
            </span>
          </div>
        </PanelState>
      </Panel>
    </div>
  )
}

function relationLabel(relation: string, t: (source: string) => string): string {
  const map: Record<string, string> = { hostile: "敌对", friendly: "友好", neutral: "中立" }
  return map[relationKind(relation)] ? t(map[relationKind(relation)]) : relation
}

/** 破坏性动作的二次确认：触发按钮 + 启动器自己的 AlertDialog */
function ConfirmAction({
  label,
  title,
  description,
  disabled,
  destructive,
  compact,
  icon,
  onConfirm,
}: {
  label: string
  title: string
  description: string
  disabled?: boolean
  destructive?: boolean
  compact?: boolean
  icon?: ReactNode
  onConfirm: () => void | Promise<void>
}) {
  const { t } = useLocale()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded border transition-colors disabled:opacity-40",
            compact ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11.5px]",
            destructive
              ? "border-destructive/50 text-destructive hover:bg-destructive/10"
              : "border-border text-muted-foreground hover:border-primary hover:text-primary"
          )}
        >
          {icon}
          {label}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>{t("确认执行")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
