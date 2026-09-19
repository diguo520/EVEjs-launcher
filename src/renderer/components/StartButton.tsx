interface Props {
  busy: boolean;
  disabled?: boolean;
  onClick(): void;
}

/** EVE ENGAGE 风格启动按钮（斜切角、按下发光、扫描动效） */
export default function StartButton({ busy, disabled, onClick }: Props) {
  return (
    <button
      className={`engage${busy ? " engage-busy" : ""}`}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? "执行中…" : "一键启动"}
    </button>
  );
}
