import "./lib/polyfill";
import "./style.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { SessionProvider, useSession } from "./lib/session";
import { Billing } from "./pages/Billing";
import { Landing } from "./pages/Landing";
import { Market } from "./pages/Market";
import { NewTask } from "./pages/NewTask";
import { Overview } from "./pages/Overview";
import { Settings } from "./pages/Settings";
import { TaskDetail } from "./pages/TaskDetail";
import { Tasks } from "./pages/Tasks";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function RequireAccount({ children }: { children: ReactNode }) {
  const { account } = useSession();
  return account ? children : <Navigate to="/" replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <Routes>
            <Route index element={<Landing />} />
            <Route element={<AppShell />}>
              <Route path="network" element={<Market />} />
              <Route
                path="app"
                element={
                  <RequireAccount>
                    <Overview />
                  </RequireAccount>
                }
              />
              <Route path="app/tasks" element={<RequireAccount children={<Tasks />} />} />
              <Route path="app/tasks/new" element={<RequireAccount children={<NewTask />} />} />
              <Route path="app/tasks/:jobHash" element={<RequireAccount children={<TaskDetail />} />} />
              <Route path="app/billing" element={<RequireAccount children={<Billing />} />} />
              <Route path="app/settings" element={<RequireAccount children={<Settings />} />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
