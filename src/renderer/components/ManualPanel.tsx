import { useEffect } from "react";

interface Props {
  open: boolean;
  onClose(): void;
}

/** 指令手册：内嵌本地 HTML（src/renderer/public/manual/manual.html → dist/renderer/manual/manual.html） */
export default function ManualPanel({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal manual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-close" onClick={onClose} title="关闭">
          ✕
        </div>
        <h2>指令手册 · v0.12.8.1</h2>
        <iframe className="manual-frame" src="manual/manual.html" title="EVE.js 全指令手册" />
      </div>
    </div>
  );
}
