import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { memo } from "react";

import { useWorkspaceStore } from "../../store/useWorkspaceStore";

export const GlobalNotice = memo(function GlobalNotice() {
  const notices = useWorkspaceStore((state) => state.notices);
  const dismissNotice = useWorkspaceStore((state) => state.dismissNotice);
  if (!notices.length) return null;

  return (
    <aside className="global-notices" aria-label="Avisos del agente">
      {notices.map((notice) => {
        const Icon =
          notice.severity === "error"
            ? AlertCircle
            : notice.severity === "warning"
              ? AlertTriangle
              : Info;
        return (
          <div
            key={notice.id}
            className={`global-notice global-notice--${notice.severity}`}
            role={notice.severity === "error" ? "alert" : "status"}
          >
            <Icon aria-hidden="true" size={15} />
            <div>
              <strong>{notice.code}</strong>
              <span>{notice.message}</span>
            </div>
            {notice.recoverable ? (
              <button
                type="button"
                aria-label={`Cerrar aviso ${notice.code}`}
                onClick={() => dismissNotice(notice.id)}
              >
                <X aria-hidden="true" size={13} />
              </button>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
});
