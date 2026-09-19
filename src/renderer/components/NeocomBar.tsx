export type NeocomKey = "services" | "tasks" | "accounts" | "manual" | "settings" | "help";

interface Props {
  active: NeocomKey | null;
  onSelect(key: NeocomKey): void;
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICONS: Array<{ key: NeocomKey; label: string; d: string }> = [
  {
    key: "services",
    label: "服务",
    d: "M12 3l8 4.5-8 4.5-8-4.5L12 3zM4 12.5l8 4.5 8-4.5M4 17l8 4.5 8-4.5"
  },
  {
    key: "tasks",
    label: "任务",
    d: "M9 4h6v3H9zM5 7h14v13H5zM9 11h6M9 15h4"
  },
  {
    key: "accounts",
    label: "账号",
    d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6 8-6s8 2 8 6"
  },
  {
    key: "manual",
    label: "手册",
    d: "M5 4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4zM9 5h6M9 9h6M9 13h4"
  },
  {
    key: "settings",
    label: "设置",
    d: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.5 7.5 0 0 0 .1-2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-6l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h6l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5z"
  },
  {
    key: "help",
    label: "帮助",
    d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9a2.6 2.6 0 0 1 5 1c0 1.5-2.4 2-2.4 3.4M12 17h.01"
  }
];

export default function NeocomBar({ active, onSelect }: Props) {
  return (
    <nav className="neocom">
      <div className="neocom-logo" title="EvEJS">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" />
          <path d="M12 7l5 3v4l-5 3-5-3v-4l5-3z" />
        </svg>
      </div>
      <div className="neocom-divider" />
      {ICONS.map((ic) => (
        <div
          key={ic.key}
          className={`neocom-item${active === ic.key ? " active" : ""}`}
          title={ic.label}
          onClick={() => onSelect(ic.key)}
        >
          <Icon d={ic.d} />
        </div>
      ))}
    </nav>
  );
}
