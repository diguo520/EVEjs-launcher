/**
 * 势力推演的固定事件夹具（B4，2026-10-29）。
 *
 * `faction-logic.test.ts` 与 `km-page.test.ts` 原本各写了一份**逐字相同**的 12 行字面量
 * （jscpd #2）。这条例子的要点：905 号损失没有 `battleID`、进不了报表，而「b 只出手、一艘没掉」
 * 必须仍然以 0 出现在分侧合计里 —— 两个测试各自验证这个结论的一面。
 */
import type { FactionEvent } from "@/lib/faction-logic"

/** 「a 掉了一艘、b 只出手没挨打」的固定事件序列 */
export function attackerOnlyLossEvent(): FactionEvent[] {
  return [
    {
      id: 1,
      at: 1,
      factionKey: "a",
      type: "loss",
      label: "战损",
      group: "combat",
      text: "",
      payload: { unitID: 1, battleID: 12, systemID: 5, killer: { kind: "engagement", key: "b" } },
    },
  ]
}
