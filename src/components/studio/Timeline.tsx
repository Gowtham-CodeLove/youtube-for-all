import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import type { Piece } from "../../lib/clip-look";
import { filmstrip, waveform } from "../../lib/clip-render";
import { cx } from "../ui";

export type Source = { blob: Blob; duration: number; title: string; width: number; height: number };

export const fmtTime = (s: number, tenths = true) => {
  const neg = s < 0;
  // Rounded first, so 59.97 shows as 1:00.0 and not 0:60.0.
  const units = tenths ? Math.round(Math.abs(s) * 10) : Math.floor(Math.abs(s) + 1e-6);
  const whole = tenths ? Math.floor(units / 10) : units;
  const m = Math.floor(whole / 60);
  const sec = String(whole - m * 60).padStart(2, "0");
  return `${neg ? "-" : ""}${m}:${sec}${tenths ? `.${units % 10}` : ""}`;
};

// Picture strips and waveforms, made once per clip file. Strip pictures arrive one by one.
type Strip = { urls: string[]; every: number; listeners: Set<() => void> };
const stripCache = new WeakMap<Blob, Strip>();
const waveCache = new WeakMap<Blob, Promise<number[]>>();

function useStrip(blob: Blob, duration: number) {
  const [, setTick] = useState(0);
  let s = stripCache.get(blob);
  if (!s) {
    const count = Math.max(4, Math.min(36, Math.ceil(duration / 2)));
    const made: Strip = { urls: [], every: duration / count, listeners: new Set() };
    s = made;
    stripCache.set(blob, made);
    void filmstrip(blob, 0, duration, count, 80, (i, url) => {
      made.urls[i] = url;
      for (const l of made.listeners) l();
    });
  }
  useEffect(() => {
    const strip = stripCache.get(blob)!;
    const l = () => setTick((n) => n + 1);
    strip.listeners.add(l);
    return () => void strip.listeners.delete(l);
  }, [blob]);
  return s;
}

function useWave(blob: Blob, duration: number) {
  const [wave, setWave] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    let p = waveCache.get(blob);
    if (!p) {
      p = waveform(blob, Math.max(100, Math.min(3000, Math.round(duration * 8))));
      waveCache.set(blob, p);
    }
    p.then((w) => live && setWave(w));
    return () => {
      live = false;
    };
  }, [blob, duration]);
  return wave;
}

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_PIECE = 0.2;

export function Timeline({
  pieces,
  sources,
  playhead,
  selectedId,
  target,
  onSeek,
  onSelect,
  onTrim,
  onGrab,
}: {
  pieces: Piece[];
  sources: Record<string, Source>;
  playhead: number;
  selectedId: string | null;
  target: number | null;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  onTrim: (id: string, start: number, end: number) => void;
  onGrab: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [pps, setPps] = useState<number | null>(null); // pixels per second; null = fit
  const total = pieces.reduce((a, p) => a + (p.end - p.start), 0);
  const span = Math.max(total, target ?? 0, 1) * 1.04;
  const fitPps = Math.max(2, (width - 24) / span);
  const scale = pps ?? fitPps;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view while playing / stepping when zoomed in.
  useEffect(() => {
    const el = scroller.current;
    if (!el || pps === null) return;
    const x = playhead * scale + 12;
    if (x < el.scrollLeft + 20 || x > el.scrollLeft + el.clientWidth - 20) el.scrollLeft = Math.max(0, x - el.clientWidth / 3);
  }, [playhead, scale, pps]);

  const offsets = useMemo(() => {
    let at = 0;
    return pieces.map((p) => {
      const o = at;
      at += p.end - p.start;
      return o;
    });
  }, [pieces]);

  const step = STEPS.find((s) => s * scale >= 64) ?? 600;
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= span; t += step) out.push(t);
    return out;
  }, [span, step]);

  // ----- seeking by dragging on the ruler / empty track -----
  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + el.scrollLeft - 12) / scale));
  };
  const scrub = useRef(false);
  const startScrub = (e: ReactPointerEvent) => {
    scrub.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSeek(timeAt(e.clientX));
  };
  const moveScrub = (e: ReactPointerEvent) => scrub.current && onSeek(timeAt(e.clientX));
  const endScrub = () => (scrub.current = false);

  // ----- trimming by the edge handles -----
  const trim = useRef<{ id: string; edge: "start" | "end"; px: number; start: number; end: number; max: number } | null>(null);
  const startTrim = (e: ReactPointerEvent, p: Piece, edge: "start" | "end") => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onGrab();
    onSelect(p.id);
    trim.current = { id: p.id, edge, px: e.clientX, start: p.start, end: p.end, max: sources[p.itemId]?.duration ?? p.end };
  };
  const moveTrim = (e: ReactPointerEvent) => {
    const g = trim.current;
    if (!g) return;
    const d = (e.clientX - g.px) / scale;
    if (g.edge === "start") onTrim(g.id, Math.max(0, Math.min(g.end - MIN_PIECE, g.start + d)), g.end);
    else onTrim(g.id, g.start, Math.min(g.max, Math.max(g.start + MIN_PIECE, g.end + d)));
  };
  const endTrim = () => (trim.current = null);

  const over = target !== null && total > target + 0.05 ? total - target : 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] text-muted">
        <span className="tabular-nums">
          {pieces.length} part{pieces.length === 1 ? "" : "s"} · {fmtTime(total)}
        </span>
        {target !== null && (
          <span className={cx("rounded-full px-2 py-0.5 font-medium tabular-nums", over ? "bg-danger/10 text-danger" : "bg-ok/10 text-ok")}>
            {over ? `${Math.ceil(over)}s over the ${fmtTime(target, false)} limit` : `Fits ${fmtTime(target, false)}`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button className="grid size-7 place-items-center rounded-lg hover:bg-card-hover" title="Zoom out" onClick={() => setPps(Math.max(2, scale / 1.5))}>
            <ZoomOut className="size-4" />
          </button>
          <button className="grid size-7 place-items-center rounded-lg hover:bg-card-hover" title="Zoom in" onClick={() => setPps(Math.min(400, scale * 1.5))}>
            <ZoomIn className="size-4" />
          </button>
          <button className="grid size-7 place-items-center rounded-lg hover:bg-card-hover" title="Fit the whole timeline" onClick={() => setPps(null)}>
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>

      <div ref={scroller} className="relative overflow-x-auto overflow-y-hidden pb-2 [scrollbar-width:thin]">
        <div className="relative" style={{ width: span * scale + 24, height: 132 }}>
          {/* Ruler */}
          <div className="absolute inset-x-0 top-0 h-6 cursor-ew-resize touch-none" onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={endScrub}>
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-full border-l border-line pl-1 text-[10px] tabular-nums text-faint" style={{ left: 12 + t * scale }}>
                {fmtTime(t, false)}
              </div>
            ))}
          </div>

          {/* Over-the-limit zone */}
          {target !== null && (
            <>
              <div className="pointer-events-none absolute bottom-0 top-6 bg-danger/8" style={{ left: 12 + target * scale, width: Math.max(0, (span - target) * scale) }} />
              <div className="pointer-events-none absolute bottom-0 top-0 z-10 border-l-2 border-dashed border-danger" style={{ left: 12 + target * scale }}>
                <span className="absolute -top-0.5 left-1 rounded bg-danger px-1 text-[9px] font-semibold text-white">{fmtTime(target, false)}</span>
              </div>
            </>
          )}

          {/* Track */}
          <div className="absolute inset-x-0 top-7 h-[100px] touch-none" onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onPointerCancel={endScrub}>
            {pieces.map((p, i) => {
              const src = sources[p.itemId];
              if (!src) return null;
              return (
                <PieceBlock
                  key={p.id}
                  piece={p}
                  index={i}
                  src={src}
                  left={12 + offsets[i] * scale}
                  scale={scale}
                  selected={p.id === selectedId}
                  multiSource={new Set(pieces.map((x) => x.itemId)).size > 1}
                  onPick={(e) => {
                    e.stopPropagation();
                    onSelect(p.id);
                    startScrub(e);
                  }}
                  onMove={moveScrub}
                  onUp={endScrub}
                  onTrimStart={(e) => startTrim(e, p, "start")}
                  onTrimEnd={(e) => startTrim(e, p, "end")}
                  onTrimMove={moveTrim}
                  onTrimUp={endTrim}
                />
              );
            })}
          </div>

          {/* Playhead */}
          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-fg" style={{ left: 12 + playhead * scale - 1 }}>
            <span className="absolute -left-[5px] top-0 size-3 rotate-45 rounded-[2px] bg-fg" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PieceBlock({
  piece,
  index,
  src,
  left,
  scale,
  selected,
  multiSource,
  onPick,
  onMove,
  onUp,
  onTrimStart,
  onTrimEnd,
  onTrimMove,
  onTrimUp,
}: {
  piece: Piece;
  index: number;
  src: Source;
  left: number;
  scale: number;
  selected: boolean;
  multiSource: boolean;
  onPick: (e: ReactPointerEvent) => void;
  onMove: (e: ReactPointerEvent) => void;
  onUp: () => void;
  onTrimStart: (e: ReactPointerEvent) => void;
  onTrimEnd: (e: ReactPointerEvent) => void;
  onTrimMove: (e: ReactPointerEvent) => void;
  onTrimUp: () => void;
}) {
  const strip = useStrip(src.blob, src.duration);
  const wave = useWave(src.blob, src.duration);
  const dur = piece.end - piece.start;
  const w = Math.max(6, dur * scale - 2);

  const bars = useMemo(() => {
    if (!wave || !wave.length) return null;
    const per = wave.length / src.duration;
    const from = Math.floor(piece.start * per);
    const to = Math.ceil(piece.end * per);
    const slice = wave.slice(from, to);
    const want = Math.max(1, Math.floor(w / 3));
    const out: number[] = [];
    for (let i = 0; i < want; i++) {
      const a = Math.floor((i / want) * slice.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / want) * slice.length));
      let m = 0;
      for (let k = a; k < b && k < slice.length; k++) m = Math.max(m, slice[k]);
      out.push(m);
    }
    return out;
  }, [wave, src.duration, piece.start, piece.end, w]);

  return (
    <div
      className={cx(
        "group absolute top-0 h-full cursor-pointer overflow-hidden rounded-lg border-2 bg-zinc-800",
        selected ? "z-10 border-accent shadow-lg shadow-accent/20" : "border-transparent hover:border-white/40",
      )}
      style={{ left, width: w }}
      onPointerDown={onPick}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* Pictures */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[62px] overflow-hidden">
        {strip?.urls.map((u, k) => {
          const t = k * strip.every;
          if (t + strip.every < piece.start || t > piece.end || !u) return null;
          return (
            <img
              key={k}
              src={u}
              alt=""
              draggable={false}
              className="absolute top-0 h-full object-cover"
              style={{ left: (t - piece.start) * scale, width: Math.max(1, strip.every * scale + 1) }}
            />
          );
        })}
      </div>
      {/* Sound */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[34px] items-center gap-px bg-zinc-900/90 px-0.5">
        {bars?.map((b, k) => <span key={k} className="w-[2px] shrink-0 rounded-full bg-accent/70" style={{ height: `${Math.max(6, b * 100)}%` }} />)}
      </div>
      {/* Label */}
      <div className="pointer-events-none absolute left-1.5 top-1 max-w-[calc(100%-12px)] truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
        {index + 1}
        {multiSource ? ` · ${src.title}` : ""} · {fmtTime(dur)}
      </div>
      {/* Trim handles */}
      <span
        role="slider"
        aria-label="Trim start"
        aria-valuenow={piece.start}
        onPointerDown={onTrimStart}
        onPointerMove={onTrimMove}
        onPointerUp={onTrimUp}
        onPointerCancel={onTrimUp}
        className={cx(
          "absolute inset-y-0 left-0 z-10 flex w-3 cursor-ew-resize touch-none items-center justify-center bg-accent transition-opacity",
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-80",
        )}
      >
        <span className="h-6 w-0.5 rounded bg-white/90" />
      </span>
      <span
        role="slider"
        aria-label="Trim end"
        aria-valuenow={piece.end}
        onPointerDown={onTrimEnd}
        onPointerMove={onTrimMove}
        onPointerUp={onTrimUp}
        onPointerCancel={onTrimUp}
        className={cx(
          "absolute inset-y-0 right-0 z-10 flex w-3 cursor-ew-resize touch-none items-center justify-center bg-accent transition-opacity",
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-80",
        )}
      >
        <span className="h-6 w-0.5 rounded bg-white/90" />
      </span>
    </div>
  );
}
