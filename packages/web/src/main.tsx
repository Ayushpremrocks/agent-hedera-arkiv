import "./lib/polyfill";
import "./style.css";
import "./polish.css";
import "./landing.css";
import "./app.css";
import "./composer.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
// App pages load on demand, so the landing page doesn't download the wallet and chain SDKs.
const page = <K extends string>(name: K, load: () => Promise<Record<K, () => ReactNode>>) => lazy(async () => ({ default: (await load())[name] }));
const Billing = page("Billing", () => import("./pages/Billing"));
const Market = page("Market", () => import("./pages/Market"));
const NewTask = page("NewTask", () => import("./pages/NewTask"));
const Overview = page("Overview", () => import("./pages/Overview"));
const Settings = page("Settings", () => import("./pages/Settings"));
const TaskDetail = page("TaskDetail", () => import("./pages/TaskDetail"));
const Tasks = page("Tasks", () => import("./pages/Tasks"));
const ProviderPage = page("ProviderPage", () => import("./pages/ProviderPage"));
const Provide = page("Provide", () => import("./pages/Provide"));
const Schedules = page("Schedules", () => import("./pages/Schedules"));
import { Toaster } from "./components/motion";
import { SessionProvider, useSession } from "./lib/session";
import { Landing, NotFound } from "./pages/Landing";

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
          <Suspense fallback={null}>
          <Routes>
            <Route index element={<Landing />} />
            <Route path="provide" element={<Provide />} />
            <Route element={<AppShell />}>
              <Route path="network" element={<Market />} />
              <Route path="providers/:id" element={<ProviderPage />} />
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
              <Route path="app/schedules" element={<RequireAccount children={<Schedules />} />} />
              <Route path="app/billing" element={<RequireAccount children={<Billing />} />} />
              <Route path="app/settings" element={<RequireAccount children={<Settings />} />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
