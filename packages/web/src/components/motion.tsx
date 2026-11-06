// Micro-interactions, in the spirit of bencho.dev's blocks, built on `motion`. Values follow the
// better-ui rules: press scale 0.96, icon swaps scale 0.25 -> 1 with 4px blur, springs with bounce 0,
// staggered entrances at 100ms, and everything collapses to static under prefers-reduced-motion.
import { CheckCircle, CircleNotch, Copy, Check, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

const spring = { type: "spring", duration: 0.3, bounce: 0 } as const;
const iconSwap = {
  initial: { opacity: 0, scale: 0.25, filter: "blur(4px)" },
  animate: { opacity: 1, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, scale: 0.25, filter: "blur(4px)" },
  transition: spring,
};

// ---------- staged page entrance ----------
/** Children enter one after another (100ms apart): used once per page, where order shows hierarchy. */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className={className} initial={reduce ? false : "hidden"} animate="show" variants={{ show: { transition: { staggerChildren: 0.1 } } }}>
      {children}
    </motion.div>
  );
}
export function Item({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.2, 0, 0, 1] } } }}
    >
      {children}
    </motion.div>
  );
}

// ---------- numbers that move to their new value ----------
export function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (n) => format(n));
  useEffect(() => {
    if (reduce) return mv.set(value);
    const c = animate(mv, value, { duration: 0.6, ease: [0.2, 0, 0, 1] });
    return () => c.stop();
  }, [value, reduce, mv]);
  return <motion.span>{text}</motion.span>;
}

// ---------- buttons ----------
type ProgressState = "idle" | "loading" | "done" | "error";
/** A button that shows what happened: spinner while working, a check when done, a mark on error. */
export function ProgressButton({
  state = "idle",
  children,
  doneLabel,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { state?: ProgressState; doneLabel?: string }) {
  const icon = state === "loading" ? <CircleNotch key="l" className="spin" weight="bold" /> : state === "done" ? <Check key="d" weight="bold" /> : state === "error" ? <WarningCircle key="e" weight="bold" /> : null;
  return (
    <button {...rest} className={`press ${className} ${state === "done" ? "is-done" : ""}`} disabled={rest.disabled || state === "loading"} aria-busy={state === "loading"}>
      <span className="btn-icon" aria-hidden>
        <AnimatePresence initial={false} mode="popLayout">
          {icon && (
            <motion.span key={state} style={{ display: "inline-flex" }} {...iconSwap}>
              {icon}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span>{state === "done" && doneLabel ? doneLabel : children}</span>
    </button>
  );
}

/** Copy a value; the icon swaps to a check for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button press"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={copied ? "c" : "n"} style={{ display: "inline-flex" }} {...iconSwap}>
          {copied ? <Check weight="bold" /> : <Copy />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

// ---------- loading ----------
export function Dots({ label = "Working" }: { label?: string }) {
  return (
    <span className="dots" role="status" aria-label={label}>
      <i />
      <i />
      <i />
    </span>
  );
}
export function Skeleton({ h = 16, w = "100%", r = 6 }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
}

// ---------- toasts ----------
type Toast = { id: number; kind: "success" | "error" | "info"; title: string; body?: string };
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let nextId = 1;
export function toast(kind: Toast["kind"], title: string, body?: string) {
  const t = { id: nextId++, kind, title, body };
  toasts = [...toasts, t].slice(-4);
  emit();
  setTimeout(() => dismiss(t.id), kind === "error" ? 8000 : 4500);
}
function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
export function Toaster() {
  const list = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  );
  return (
    <div className="toaster" aria-live="polite">
      <AnimatePresence initial={false}>
        {list.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast ${t.kind}`}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.15, ease: "easeOut" } }}
            transition={spring}
          >
            <span className="toast-icon" aria-hidden>
              {t.kind === "success" ? <CheckCircle weight="fill" /> : t.kind === "error" ? <WarningCircle weight="fill" /> : <CircleNotch />}
            </span>
            <div>
              <b>{t.title}</b>
              {t.body && <p>{t.body}</p>}
            </div>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---------- agent status ----------
/** What the agent is doing right now. The orb only pulses while there is real work in flight. */
export function AgentStatus({ working, label }: { working: boolean; label: string }) {
  return (
    <span className={`agent-status ${working ? "on" : ""}`}>
      <span className="orb" aria-hidden />
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={label} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
          {label}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// ---------- sliding selection (nav, tabs) ----------
/** The highlight under the selected item slides between items instead of jumping. */
export function SlidingHighlight({ id, className = "slide-hl" }: { id: string; className?: string }) {
  return <motion.span layoutId={id} className={className} transition={spring} aria-hidden />;
}
