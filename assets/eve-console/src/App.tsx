import { HashRouter, Navigate, Route, Routes } from "react-router-dom"
import { Toaster } from "sonner"
import { ServerEngineProvider } from "@/lib/engine"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/layout/AppShell"
import { ConsolePage } from "@/pages/ConsolePage"
import { UniversePage } from "@/pages/UniversePage"
import { AccountsPage } from "@/pages/AccountsPage"
import { LogsPage } from "@/pages/LogsPage"
import { BackupsPage } from "@/pages/BackupsPage"
import { ModsPage } from "@/pages/ModsPage"

export function App() {
  return (
    <ServerEngineProvider>
      <TooltipProvider>
        <HashRouter>
          <AppShell>
            <Routes>
              <Route path="/" element={<ConsolePage />} />
              <Route path="/universe" element={<UniversePage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/backups" element={<BackupsPage />} />
              <Route path="/mods" element={<ModsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
        </HashRouter>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              color: "hsl(var(--foreground))",
              borderRadius: "8px",
              fontFamily: "var(--font-body)",
              fontSize: "13px",
            },
          }}
        />
      </TooltipProvider>
    </ServerEngineProvider>
  )
}
