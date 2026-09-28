import { StatTile } from "@/components/common/panel"
import { t } from "@/lib/i18n"
import { MANUAL_META } from "@/lib/manual-data"
import { formatCount } from "@/lib/mock"

/** 手册规模概览：指令 + 三张大表 */
export function CommandStats({ customCount }: { customCount: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="指令总数"
        value={MANUAL_META.commands + customCount}
        unit="条"
        tone="telemetry"
        delta={
          customCount > 0
            ? t("{count} 个分类 · 含 {custom} 条自定义", {
                count: MANUAL_META.categories,
                custom: customCount,
              })
            : t("{count} 个分类", { count: MANUAL_META.categories })
        }
      />
      <StatTile
        label="异常模板"
        value={MANUAL_META.templates}
        unit="个"
        tone="primary"
        delta="生成站点需身在太空中"
      />
      <StatTile
        label="物品 ID"
        value={MANUAL_META.items}
        unit="件"
        tone="warning"
        delta="中文名自动换成英文名"
      />
      <StatTile
        label="NPC 档案"
        value={MANUAL_META.npcs}
        unit="个"
        tone="success"
        delta="含势力与赏金"
      />
    </div>
  )
}

/** 使用说明 + 使用条件图例 */
export function CommandUsageHint() {
  const requires = MANUAL_META.requires

  return (
    <div className="flex items-start gap-3 rounded-md border-l-2 border-primary bg-primary/5 px-4 py-3">
      <span className="tabular mt-px shrink-0 text-[10px] tracking-[0.1em] text-tertiary">
        // USAGE
      </span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          游戏内以 <span className="tabular text-primary">/</span> 或{" "}
          <span className="tabular text-primary">.</span> 开头输入指令；示例{" "}
          <span className="tabular text-telemetry">/item Tritanium 100</span>（物品进机库）、
          <span className="tabular text-telemetry">/spawnsite client-dungeon:141</span>
          （生成异常站点）；输入 <span className="tabular text-telemetry">/help</span>{" "}
          查看内置列表。
        </p>
        <p className="tabular text-[11px] text-tertiary">
          使用条件分布 · 无限制 {formatCount(requires["无"] ?? 0)} · 需停泊{" "}
          {formatCount(requires["需停泊"] ?? 0)} · 需太空 {formatCount(requires["需太空"] ?? 0)} ·
          需 GM {formatCount(requires["需 GM 角色"] ?? 0)}
        </p>
      </div>
    </div>
  )
}
