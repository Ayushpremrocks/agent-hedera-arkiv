import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";

export type Agent = { id: string; arkivKey: string | null; balance: string | null; allowance: string | null; stats: Record<string, any> };
export type Me = { account: string; mirrorDown?: boolean; agent: Agent | null };
export type TaskRow = {
  jobHash: string;
  label: string;
  status: "queued" | "running" | "done" | "failed";
  deadline: number;
  providerName: string | null;
  serial: number | null;
  start: number | null;
  onTime: boolean | null;
  finishedAt: number | null;
  failure: string | null;
  price: string | null;
  rushPaid: string | null;
  preview: string | null;
  scheduleId: string | null;
  createdAt: string;
};
// startBy: the start providers guarantee now (or refund); runSeconds: the job's hard run limit.
export type Quote = { price: string; startBy: number; runSeconds: number; providers: number; at: number };

export function useMe() {
  const { account, api } = useSession();
  return useQuery({ queryKey: ["me", account], queryFn: () => api<Me>("/me"), enabled: !!account, refetchInterval: 8000 });
}

export function useTasks() {
  const { account, api } = useSession();
  return useQuery({ queryKey: ["tasks", account], queryFn: () => api<{ tasks: TaskRow[] }>("/tasks").then((r) => r.tasks), enabled: !!account, refetchInterval: 5000 });
}

export function useQuote() {
  const { account, api } = useSession();
  return useQuery({ queryKey: ["quote", account], queryFn: () => api<Quote>("/quote"), enabled: !!account, refetchInterval: 15_000 });
}

/** Customer-facing words for a task's state. */
export function statusOf(t: Pick<TaskRow, "status" | "onTime">): { label: string; tone: "ok" | "late" | "bad" | "wait" | "run" } {
  if (t.status === "done") return t.onTime ? { label: "Delivered", tone: "ok" } : { label: "Delivered late", tone: "late" };
  if (t.status === "running") return { label: "Running", tone: "run" };
  if (t.status === "failed") return { label: "Failed", tone: "bad" };
  return { label: "Scheduled", tone: "wait" };
}
