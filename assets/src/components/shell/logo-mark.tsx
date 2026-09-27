/** EVEJS 标识：外层六边形 = 星域边界，内层 = 恒星系轨道 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <polygon
        points="20,3 36,12 36,28 20,37 4,28 4,12"
        stroke="hsl(var(--primary))"
        strokeWidth="1.5"
        fill="hsl(var(--primary) / 0.08)"
      />
      <polygon
        points="20,9 31,15 31,25 20,31 9,25 9,15"
        stroke="hsl(var(--telemetry))"
        strokeWidth="1"
        fill="none"
        opacity="0.65"
      />
      <circle cx="20" cy="20" r="2.5" fill="hsl(var(--primary))" />
      <circle
        cx="20"
        cy="20"
        r="6"
        stroke="hsl(var(--primary))"
        strokeWidth="0.5"
        opacity="0.45"
      />
    </svg>
  )
}
