import type { CardStatus, ServiceCardAction } from "../hooks/useServices";

interface Props {
  title: string;
  subtitle: string;
  status: CardStatus;
  detail: string;
  port?: string;
  action?: ServiceCardAction | null;
}

const STATUS_LABEL: Record<CardStatus, string> = {
  idle: "IDLE",
  ready: "READY",
  warn: "WARN",
  error: "ERROR"
};

export default function ServiceCard({ title, subtitle, status, detail, port, action }: Props) {
  return (
    <div className={`svc-card st-${status}`}>
      <h3>
        <span className={`led led-${status}`} />
        {title}
        <span className="svc-status-label">{STATUS_LABEL[status]}</span>
      </h3>
      {port && <span className="svc-port">{port}</span>}
      <div className="svc-subtitle">{subtitle}</div>
      <div className="svc-detail">{detail}</div>
      {action && (
        <button className={`card-btn ${action.disabled ? "card-btn-disabled" : ""}`} onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      )}
    </div>
  );
}
