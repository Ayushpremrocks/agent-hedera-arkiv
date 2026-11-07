// Ported from devl.dev/components (MIT): the split-flap from "Departures" and the live dot from "Log Stream".
// Rewritten for this project's Tailwind theme and without shadcn/coss ui.
import { motion, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

const DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-#/";
const FLIP_MS = 62;
const RIPPLE_MS = 12;
const MAX_TURNS = 4;

/** The last few drum characters before `to`, so a flap visibly rolls instead of jumping. */
function route(from: string, to: string) {
  if (from === to) return [];
  const a = DRUM.indexOf(from);
  const b = DRUM.indexOf(to);
  if (a < 0 || b < 0) return [to];
  const n = Math.min((b - a + DRUM.length) % DRUM.length, MAX_TURNS);
  return Array.from({ length: n }, (_, i) => DRUM[(b - n + 1 + i + DRUM.length) % DRUM.length]);
}

function Half({ c, top }: { c: string; top?: boolean }) {
  return (
    <span className={`absolute inset-x-0 h-1/2 overflow-hidden bg-raised ${top ? "top-0 rounded-t-[3px]" : "bottom-0 rounded-b-[3px]"}`}>
      <span className={`absolute inset-x-0 h-5 text-center leading-5 ${top ? "top-0" : "bottom-0"}`}>{c === " " ? " " : c}</span>
    </span>
  );
}

function Flap({ char, delay }: { char: string; delay: number }) {
  const reduce = useReducedMotion();
  const [s, setS] = useState({ cur: char, prev: char, n: 0 });
  const cur = useRef(char);
  useEffect(() => {
    const seq = reduce ? [] : route(cur.current, char);
    if (!seq.length) {
      cur.current = char;
      setS((p) => (p.cur === char ? p : { cur: char, prev: char, n: p.n }));
      return;
    }
    let i = 0;
    let t = 0;
    const flip = () => {
      const prev = cur.current;
      cur.current = seq[i++];
      setS((p) => ({ cur: cur.current, prev, n: p.n + 1 }));
      if (i < seq.length) t = window.setTimeout(flip, FLIP_MS);
    };
    t = window.setTimeout(flip, delay);
    return () => window.clearTimeout(t);
  }, [char, delay, reduce]);

  return (
    <span aria-hidden className="relative h-5 w-[13px] shrink-0 [perspective:80px]">
      <Half c={s.cur} top />
      <Half c={s.n ? s.prev : s.cur} />
      {s.n > 0 && !reduce && (
        <Fragment key={s.n}>
          <motion.span className="absolute inset-0" initial={{ rotateX: 0 }} animate={{ rotateX: -90 }} transition={{ duration: 0.055, ease: [0.55, 0, 1, 0.45] }}>
            <Half c={s.prev} top />
          </motion.span>
          <motion.span className="absolute inset-0" initial={{ rotateX: 90 }} animate={{ rotateX: 0 }} transition={{ delay: 0.05, duration: 0.11, ease: [0.3, 1.45, 0.55, 1] }}>
            <Half c={s.cur} />
          </motion.span>
        </Fragment>
      )}
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-card/80" />
    </span>
  );
}

/** A fixed-width split-flap word. Screen readers get `text` once, not letter by letter. */
export function FlapWord({ text, size, start = 0, className = "" }: { text: string; size: number; start?: number; className?: string }) {
  const chars = text.toUpperCase().padEnd(size).slice(0, size).split("");
  return (
    <span className={`flex gap-px font-mono text-[12px] font-medium ${className}`}>
      <span className="sr-only">{text}</span>
      {chars.map((c, i) => (
        <Flap key={i} char={c} delay={(start + i) * RIPPLE_MS} />
      ))}
    </span>
  );
}

/** A real live indicator: pings while data is flowing, grey when it isn't. */
export function LiveDot({ on }: { on: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      {on && <span className="absolute inset-0 animate-ping rounded-full bg-kept/50 motion-reduce:hidden" />}
      <span className={`relative size-2 rounded-full ${on ? "bg-kept" : "bg-faint"}`} />
    </span>
  );
}
