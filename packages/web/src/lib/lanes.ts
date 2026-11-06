// The hero's "promise lines": a live replay of the rule every Dani.ai provider runs.
// Jobs arrive, get promised the start they'd have if every job ahead used its whole run limit
// (a dashed amber tick), wait as a ghost at that worst-case spot, and start when a worker frees up:
// always at or before the tick, because real jobs end early. One clock: GSAP's ticker.
// Everything is drawn straight into the SVG (no React renders per frame).
import { gsap } from "gsap";

const NS = "http://www.w3.org/2000/svg";
export const W = 1200; // viewBox width
const LANE_H = 54;
const TOP = 34;
const WORKERS = 3;
export const H = TOP + WORKERS * LANE_H + 26;
const PAST = 14; // seconds of history shown left of "now"
const AHEAD = 22; // seconds of future shown right of "now"
const SPEED = 1.4; // simulated seconds per real second
const GUT = 104; // left gutter for the worker labels; jobs are clipped to the right of it
const SPAN = W - GUT;
const NOW_X = GUT + (PAST / (PAST + AHEAD)) * SPAN;
const x = (t: number, now: number) => NOW_X + ((t - now) / (PAST + AHEAD)) * SPAN;

type Job = {
  id: number;
  limit: number; // worst case (seconds)
  actual: number; // what it really takes (always less)
  startBy: number; // promised at booking
  start?: number;
  worker?: number;
  g: SVGGElement;
  ghost: SVGRectElement;
  bar: SVGRectElement;
  tick: SVGLineElement;
  label: SVGTextElement;
  gx: number; // ghost x, eased toward its target
  gy: number;
};

/** Deterministic randomness, so the first frame is always a composed one. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent: Element) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

export function startLanes(svg: SVGSVGElement, opts: { still: boolean }) {
  const rand = rng(7);
  const clip = el("clipPath", { id: "ln-clip" }, el("defs", {}, svg));
  el("rect", { x: GUT, y: 0, width: SPAN, height: H }, clip);
  const layer = el("g", { "clip-path": "url(#ln-clip)" }, svg);
  const nowLine = el("line", { class: "ln-now", y1: TOP - 18, y2: H - 18, x1: NOW_X, x2: NOW_X }, svg);
  el("text", { class: "ln-now-label", x: NOW_X, y: TOP - 22, "text-anchor": "middle" }, svg).textContent = "now";
  for (let w = 0; w < WORKERS; w++) {
    el("text", { class: "ln-lane-label", x: 8, y: TOP + w * LANE_H + 26 }, svg).textContent = `GPU worker ${w + 1}`;
    el("line", { class: "ln-lane", x1: GUT, x2: W, y1: TOP + w * LANE_H + LANE_H - 6, y2: TOP + w * LANE_H + LANE_H - 6 }, svg);
  }

  let now = 0;
  let nextId = 1;
  let nextArrival = 0;
  const jobs: Job[] = [];
  const queued = () => jobs.filter((j) => j.start === undefined);
  const running = () => jobs.filter((j) => j.start !== undefined && now < j.start + j.actual);

  /** Worst-case plan: when each worker is free if every job uses its whole limit; queue in order. */
  function plan() {
    const free = Array.from({ length: WORKERS }, () => now);
    for (const j of running()) free[j.worker!] = Math.max(now, j.start! + j.limit);
    const out = new Map<number, { t: number; w: number }>();
    for (const j of queued()) {
      let w = 0;
      for (let k = 1; k < WORKERS; k++) if (free[k] < free[w]) w = k;
      out.set(j.id, { t: free[w], w });
      free[w] += j.limit;
    }
    return out;
  }

  function arrive() {
    if (queued().length >= 7) return;
    const limit = 2.5 + rand() * 5.5;
    const job = { id: nextId++, limit, actual: limit * (0.3 + rand() * 0.5) } as Job;
    jobs.push(job); // its promise: where the worst-case plan puts it now, behind everything sold
    const spot = plan().get(job.id)!;
    job.startBy = spot.t;
    job.g = el("g", { class: "ln-job" }, layer);
    job.ghost = el("rect", { class: "ln-ghost", height: LANE_H - 18, rx: 5 }, job.g);
    job.bar = el("rect", { class: "ln-bar", height: LANE_H - 18, rx: 5, width: 0 }, job.g);
    job.tick = el("line", { class: "ln-tick" }, job.g);
    job.label = el("text", { class: "ln-tick-label" }, job.g);
    job.label.textContent = "starts by";
    job.gx = x(spot.t, now);
    job.gy = TOP + spot.w * LANE_H;
  }

  function dispatch() {
    const busy = new Set(running().map((j) => j.worker));
    for (let w = 0; w < WORKERS; w++) {
      if (busy.has(w)) continue;
      const j = queued()[0];
      if (!j) return;
      Object.assign(j, { start: now, worker: w });
      busy.add(w);
      const early = j.startBy - now;
      j.label.textContent = early >= 0.5 ? `${early.toFixed(1)}s early` : ""; // only the gap is news
      j.g.classList.add("ln-started");
    }
  }

  function step(dt: number) {
    now += dt;
    if (now >= nextArrival) {
      arrive();
      nextArrival = now + 0.3 + rand() * 0.9; // a little more work than the workers can take: a queue forms
    }
    dispatch();
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      if (j.start !== undefined && j.start + j.limit < now - PAST) {
        j.g.remove();
        jobs.splice(i, 1);
      }
    }
  }

  function draw(ease: number) {
    const p = plan();
    for (const j of jobs) {
      const target = j.start !== undefined ? { x: x(j.start, now), y: TOP + j.worker! * LANE_H } : { x: x(p.get(j.id)!.t, now), y: TOP + p.get(j.id)!.w * LANE_H };
      // Waiting ghosts glide toward their current worst-case spot; started jobs ride the clock.
      j.gx = j.start !== undefined ? target.x : j.gx + (target.x - j.gx) * ease;
      j.gy = j.gy + (target.y - j.gy) * ease;
      const width = (j.limit / (PAST + AHEAD)) * SPAN;
      const ran = j.start !== undefined ? Math.min(now - j.start, j.actual) : 0;
      j.ghost.setAttribute("x", j.gx.toFixed(1));
      j.ghost.setAttribute("y", j.gy.toFixed(1));
      j.ghost.setAttribute("width", width.toFixed(1));
      j.bar.setAttribute("x", j.gx.toFixed(1));
      j.bar.setAttribute("y", j.gy.toFixed(1));
      j.bar.setAttribute("width", ((ran / (PAST + AHEAD)) * SPAN).toFixed(1));
      const tx = x(j.startBy, now).toFixed(1);
      j.tick.setAttribute("x1", tx);
      j.tick.setAttribute("x2", tx);
      j.tick.setAttribute("y1", (j.gy - 6).toFixed(1));
      j.tick.setAttribute("y2", (j.gy + LANE_H - 12).toFixed(1));
      j.label.setAttribute("x", (Number(tx) + 4).toFixed(1));
      j.label.setAttribute("y", (j.gy - 8 + LANE_H).toFixed(1));
    }
  }

  // Run 30 simulated seconds first: the very first frame is a full, composed one.
  for (let i = 0; i < 300; i++) step(0.1);
  draw(1);
  nowLine.setAttribute("x1", String(NOW_X));
  if (opts.still) return () => {};

  let visible = true;
  const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
  io.observe(svg);
  const tick = (_t: number, deltaMs: number) => {
    if (!visible) return;
    step(Math.min(deltaMs, 100) / 1000 * SPEED);
    draw(0.12);
  };
  gsap.ticker.add(tick);
  return () => {
    gsap.ticker.remove(tick);
    io.disconnect();
  };
}
