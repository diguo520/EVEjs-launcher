import { Badge } from "@/components/ui/badge"
import type { BackupKind } from "@/lib/types"

type KindTone = "primary" | "neutral" | "warn"

const KIND_TONE: Record<BackupKind, KindTone> = {
  手动: "primary",
  自动: "neutral",
  启动前: "warn",
}

/** 快照类型徽标：手动 / 自动 / 启动前，时间线与详情面板共用同一套色。 */
export function BackupKindBadge({ kind, className }: { kind: BackupKind; className?: string }) {
  return (
    <Badge tone={KIND_TONE[kind]} className={className}>
      {kind}
    </Badge>
  )
}
