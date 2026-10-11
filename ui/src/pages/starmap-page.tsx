import { useLocale } from "@/components/shell/locale-provider"
import { FactionScreen, useFactionShell } from "@/components/faction/faction-shell"
import { FactionStarmap } from "@/components/faction/faction-starmap"

/**
 * 星图页（侧栏「群星 → 星图」）。
 *
 * 原先它是势力页里的一个页签，2026-10-11 单独提出来：这张图有缩放 / 拖动 / 图层开关 / 点选星系
 * 这一整套交互，跟其它几页「读表」的节奏不是一回事，值得占一个导航位 —— 也正好和 KM（交战详情）
 * 凑成一组「看态势」的入口。
 */
export function StarmapPage() {
  const { t } = useLocale()
  const shell = useFactionShell()
  return (
    <FactionScreen title={t("星图")} sub="// STAR MAP" shell={shell}>
      <FactionStarmap
        faction={shell.faction}
        roster={shell.roster}
        colorByKey={shell.colorByKey}
        preferZh={shell.preferZh}
      />
    </FactionScreen>
  )
}
