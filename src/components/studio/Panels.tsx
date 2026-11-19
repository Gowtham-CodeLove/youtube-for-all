import type { ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ear,
  Plus,
  RotateCcw,
  Scissors,
  SplitSquareHorizontal,
  Square,
  Trash2,
  Type,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  DEFAULT_FRAMING,
  SCALE_MAX,
  SCALE_MIN,
  SHAPES,
  TEXT_FONTS,
  VOICE_PRESETS,
  newTextBox,
  type Framing,
  type Piece,
  type Shape,
  type TextBox,
  type Voice,
} from "../../lib/clip-look";
import { fmtTime, type Source } from "./Timeline";
import { Button, cx } from "../ui";

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b border-line px-4 py-4 last:border-0">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Chip({ on, onClick, children, title }: { on?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
        on ? "border-accent bg-accent-soft text-accent" : "border-line bg-card text-muted hover:border-faint/50 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onGrab,
  show,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onGrab: () => void;
  show: (v: number) => string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{show(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onGrab}
        onKeyDown={(e) => e.key.startsWith("Arrow") && onGrab()}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </label>
  );
}

// ---------------- Cut ----------------

const TARGETS: { label: string; value: number | null }[] = [
  { label: "Off", value: null },
  { label: "30s", value: 30 },
  { label: "60s", value: 60 },
  { label: "90s", value: 90 },
  { label: "2 min", value: 120 },
  { label: "3 min", value: 180 },
];

export function CutPanel({
  pieces,
  selected,
  sources,
  total,
  target,
  setTarget,
  playhead,
  others,
  onSplit,
  onDelete,
  onDuplicate,
  onMove,
  onTrimToPlayhead,
  onKeepFirst,
  onKeepLast,
  onSplitAtLimit,
  onSplitEvery,
  onAddClip,
  onReset,
}: {
  pieces: Piece[];
  selected: Piece | null;
  sources: Record<string, Source>;
  total: number;
  target: number | null;
  setTarget: (v: number | null) => void;
  playhead: number;
  others: { id: string; title: string }[];
  onSplit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
  onTrimToPlayhead: (edge: "start" | "end") => void;
  onKeepFirst: () => void;
  onKeepLast: () => void;
  onSplitAtLimit: () => void;
  onSplitEvery: () => void;
  onAddClip: (id: string) => void;
  onReset: () => void;
}) {
  const over = target !== null ? total - target : 0;
  const idx = selected ? pieces.findIndex((p) => p.id === selected.id) : -1;
  return (
    <>
      <Section title="Length limit" hint="The red line on the timeline. Shorts can be up to 3 minutes; 60s is the classic length.">
        <div className="flex flex-wrap gap-1.5">
          {TARGETS.map((t) => (
            <Chip key={t.label} on={target === t.value} onClick={() => setTarget(t.value)}>
              {t.label}
            </Chip>
          ))}
        </div>
        {target !== null && (
          <div className={cx("rounded-xl border p-3 text-xs", over > 0.05 ? "border-danger/30 bg-danger/5" : "border-ok/30 bg-ok/5")}>
            <div className="font-semibold text-fg">
              {over > 0.05 ? `${fmtTime(total)} long — ${Math.ceil(over)}s extra` : `${fmtTime(total)} long — fits ${fmtTime(target, false)}`}
            </div>
            {over > 0.05 && (
              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                <Button size="sm" onClick={onKeepFirst} title="Cut off everything after the limit">
                  Keep first {fmtTime(target, false)}
                </Button>
                <Button size="sm" onClick={onKeepLast} title="Cut off the beginning so the last part fits">
                  Keep last {fmtTime(target, false)}
                </Button>
                <Button size="sm" onClick={onSplitAtLimit} title="Split at the limit: the extra becomes its own part, to delete, trim or save separately">
                  Split off the extra
                </Button>
                <Button size="sm" onClick={onSplitEvery} title="Split the whole thing into parts no longer than the limit">
                  Split every {fmtTime(target, false)}
                </Button>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Edit at the playhead" hint={`Playhead ${fmtTime(playhead)}. Keys: S split · Del delete · Space play · ←/→ step · I/O trim.`}>
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="primary" icon={<Scissors className="size-3.5" />} onClick={onSplit}>
            Split here
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={onDelete} disabled={!selected || pieces.length < 2}>
            Delete part
          </Button>
          <Button size="sm" icon={<ArrowRightToLine className="size-3.5" />} onClick={() => onTrimToPlayhead("start")} title="Cut away the selected part's beginning, up to the playhead (I)">
            Trim start here
          </Button>
          <Button size="sm" icon={<ArrowLeftToLine className="size-3.5" />} onClick={() => onTrimToPlayhead("end")} title="Cut away the selected part's end, from the playhead (O)">
            Trim end here
          </Button>
        </div>
      </Section>

      <Section title="Parts" hint="Each part plays one after another. Drag a part's edges on the timeline to trim it.">
        <ol className="space-y-1">
          {pieces.map((p, i) => (
            <li
              key={p.id}
              className={cx(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs",
                p.id === selected?.id ? "border-accent bg-accent-soft" : "border-line",
              )}
            >
              <span className="grid size-5 shrink-0 place-items-center rounded bg-bg-soft font-semibold tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                {sources[p.itemId]?.title ?? "Clip"} <span className="text-faint tabular-nums">{fmtTime(p.start)}–{fmtTime(p.end)}</span>
              </span>
              <span className="tabular-nums text-muted">{fmtTime(p.end - p.start)}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<ChevronLeft className="size-3.5" />} onClick={() => onMove(-1)} disabled={idx <= 0}>
            Move left
          </Button>
          <Button size="sm" icon={<ChevronRight className="size-3.5" />} onClick={() => onMove(1)} disabled={idx < 0 || idx >= pieces.length - 1}>
            Move right
          </Button>
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={onDuplicate} disabled={!selected}>
            Duplicate
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={onReset}>
            Start over
          </Button>
        </div>
      </Section>

      <Section title="Join another clip" hint="Adds a clip from Ready to Post at the end. Reorder with Move left / right.">
        {others.length === 0 ? (
          <p className="text-xs text-faint">No other clips in Ready to Post.</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {others.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => onAddClip(o.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-xs hover:border-accent hover:bg-accent-soft"
                >
                  <Plus className="size-3.5 shrink-0 text-accent" />
                  <span className="truncate">{o.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// ---------------- Frame ----------------

export function FramePanel({
  shape,
  setShape,
  framing,
  setFraming,
  onGrab,
}: {
  shape: Shape;
  setShape: (s: Shape) => void;
  framing: Framing;
  setFraming: (f: Partial<Framing>, commit?: boolean) => void;
  onGrab: () => void;
}) {
  return (
    <>
      <Section title="Frame shape">
        <div className="grid grid-cols-4 gap-1.5">
          {SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setShape(s.value)}
              title={s.hint}
              className={cx(
                "flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[11px] font-medium transition",
                shape === s.value ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-fg",
              )}
            >
              <span
                className={cx("block rounded-[3px] border-2", shape === s.value ? "border-accent" : "border-current")}
                style={{ width: s.value === "16:9" ? 26 : s.value === "1:1" ? 18 : s.value === "4:5" ? 16 : 12, height: s.value === "16:9" ? 15 : s.value === "1:1" ? 18 : s.value === "4:5" ? 20 : 22 }}
              />
              {s.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Picture" hint="Drag on the preview to move it; scroll on it to zoom.">
        <div className="grid grid-cols-2 gap-1.5">
          <Chip on={framing.fit === "contain"} onClick={() => setFraming({ fit: "contain", scale: 1 }, true)}>
            Show whole
          </Chip>
          <Chip on={framing.fit === "cover"} onClick={() => setFraming({ fit: "cover", scale: 1 }, true)}>
            Fill frame
          </Chip>
        </div>
        <Slider label="Zoom" value={framing.scale} min={SCALE_MIN} max={SCALE_MAX} step={0.01} onGrab={onGrab} onChange={(v) => setFraming({ scale: v })} show={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Left ↔ right" value={framing.x} min={0} max={1} step={0.005} onGrab={onGrab} onChange={(v) => setFraming({ x: v })} show={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Up ↕ down" value={framing.y} min={0} max={1} step={0.005} onGrab={onGrab} onChange={(v) => setFraming({ y: v })} show={(v) => `${Math.round(v * 100)}%`} />
        <div className="flex flex-wrap gap-1.5">
          <Chip onClick={() => setFraming({ y: 0 }, true)}>Top</Chip>
          <Chip onClick={() => setFraming({ x: 0.5, y: 0.5 }, true)}>Centre</Chip>
          <Chip onClick={() => setFraming({ y: 1 }, true)}>Bottom</Chip>
          <Chip onClick={() => setFraming({ ...DEFAULT_FRAMING, background: framing.background }, true)}>
            <span className="inline-flex items-center gap-1">
              <RotateCcw className="size-3" /> Reset
            </span>
          </Chip>
        </div>
      </Section>
      <Section title="Background" hint="Fills the frame where the picture doesn't reach.">
        <div className="grid grid-cols-3 gap-1.5">
          {(["blur", "black", "white"] as const).map((b) => (
            <Chip key={b} on={framing.background === b} onClick={() => setFraming({ background: b }, true)}>
              {b === "blur" ? "Blurred" : b === "black" ? "Black" : "White"}
            </Chip>
          ))}
        </div>
      </Section>
    </>
  );
}

// ---------------- Text ----------------

export function TextPanel({
  texts,
  selectedId,
  setSelected,
  onAdd,
  onChange,
  onRemove,
  onDuplicate,
  onGrab,
  playhead,
  total,
}: {
  texts: TextBox[];
  selectedId: string | null;
  setSelected: (id: string | null) => void;
  onAdd: (b: TextBox) => void;
  onChange: (id: string, change: Partial<TextBox>, commit?: boolean) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onGrab: () => void;
  playhead: number;
  total: number;
}) {
  const box = texts.find((b) => b.id === selectedId) ?? null;
  const set = (c: Partial<TextBox>, commit = true) => box && onChange(box.id, c, commit);
  return (
    <>
      <Section title="Add text" hint="{n} = part number, {total} = number of parts, {title} = the clip's title. Tamil works.">
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" icon={<Type className="size-3.5" />} onClick={() => onAdd(newTextBox("plain"))}>
            Text
          </Button>
          <Button size="sm" icon={<Square className="size-3.5" />} onClick={() => onAdd(newTextBox("caption"))}>
            Caption box
          </Button>
          <Button size="sm" onClick={() => onAdd(newTextBox("part"))}>Part {"{n}"} badge</Button>
          <Button size="sm" onClick={() => onAdd(newTextBox("title"))}>Title on top</Button>
        </div>
        {texts.length > 0 && (
          <ul className="space-y-1">
            {texts.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setSelected(b.id)}
                  className={cx(
                    "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs",
                    b.id === selectedId ? "border-accent bg-accent-soft" : "border-line hover:border-faint/50",
                  )}
                >
                  <Type className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{b.text || "(empty)"}</span>
                  <span className="shrink-0 tabular-nums text-faint">
                    {b.from === null && b.to === null ? "whole" : `${fmtTime(b.from ?? 0, false)}–${b.to === null ? "end" : fmtTime(b.to, false)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {box && (
        <>
          <Section title="Selected text">
            <textarea
              value={box.text}
              rows={3}
              onFocus={onGrab}
              onChange={(e) => set({ text: e.target.value }, false)}
              className="w-full rounded-xl border border-line bg-bg-soft px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <select
                value={box.font}
                onChange={(e) => set({ font: e.target.value })}
                className="col-span-2 rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-xs"
                aria-label="Font"
              >
                {TEXT_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <Slider label="Letter size" value={box.size} min={20} max={200} step={1} onGrab={onGrab} onChange={(v) => set({ size: v }, false)} show={(v) => `${v}`} />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs">
                <input type="color" value={box.color} onChange={(e) => set({ color: e.target.value })} className="size-7 cursor-pointer rounded border border-line bg-transparent" />
                Text
              </label>
              <div className="ml-auto flex gap-1">
                {(["left", "center", "right"] as const).map((a) => {
                  const Icon = a === "left" ? AlignLeft : a === "center" ? AlignCenter : AlignRight;
                  return (
                    <button
                      key={a}
                      type="button"
                      title={`Align ${a}`}
                      onClick={() => set({ align: a })}
                      className={cx("grid size-7 place-items-center rounded-lg border", box.align === a ? "border-accent text-accent" : "border-line text-muted")}
                    >
                      <Icon className="size-3.5" />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Chip on={box.outline} onClick={() => set({ outline: !box.outline })}>
                Outline
              </Chip>
              <Chip on={box.background === "box"} onClick={() => set({ background: box.background === "box" ? "none" : "box" })}>
                Box behind
              </Chip>
            </div>
            {box.background === "box" && (
              <div className="flex items-center gap-2">
                <input type="color" value={box.backgroundColor} onChange={(e) => set({ backgroundColor: e.target.value })} className="size-7 cursor-pointer rounded border border-line bg-transparent" aria-label="Box colour" />
                <div className="flex-1">
                  <Slider label="Box opacity" value={box.backgroundOpacity} min={0.1} max={1} step={0.05} onGrab={onGrab} onChange={(v) => set({ backgroundOpacity: v }, false)} show={(v) => `${Math.round(v * 100)}%`} />
                </div>
              </div>
            )}
          </Section>
          <Section title="When it shows" hint="Times are on the finished clip.">
            <div className="grid grid-cols-2 gap-1.5">
              <Chip on={box.from === null && box.to === null} onClick={() => set({ from: null, to: null })}>
                Whole clip
              </Chip>
              <Chip on={box.from !== null || box.to !== null} onClick={() => set({ from: Math.min(playhead, Math.max(0, total - 1)), to: Math.min(total, playhead + 3) })}>
                Part of it
              </Chip>
            </div>
            {(box.from !== null || box.to !== null) && (
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <div className="rounded-lg border border-line p-2">
                  <div className="text-faint">From</div>
                  <div className="font-semibold tabular-nums">{fmtTime(box.from ?? 0)}</div>
                  <button type="button" className="mt-1 text-accent hover:underline" onClick={() => set({ from: playhead, to: box.to !== null && box.to <= playhead ? null : box.to })}>
                    Set to playhead
                  </button>
                </div>
                <div className="rounded-lg border border-line p-2">
                  <div className="text-faint">Until</div>
                  <div className="font-semibold tabular-nums">{box.to === null ? "End" : fmtTime(box.to)}</div>
                  <button type="button" className="mt-1 text-accent hover:underline" onClick={() => set({ to: playhead > (box.from ?? 0) ? playhead : null })}>
                    Set to playhead
                  </button>
                </div>
              </div>
            )}
          </Section>
          <Section title="Box">
            <div className="flex gap-1.5">
              <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => onDuplicate(box.id)}>
                Duplicate
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => onRemove(box.id)}>
                Remove
              </Button>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

// ---------------- Voice ----------------

export function VoicePanel({
  voice,
  setVoice,
  onGrab,
  onHear,
  hearing,
}: {
  voice: Voice;
  setVoice: (v: Partial<Voice>, commit?: boolean) => void;
  onGrab: () => void;
  onHear: () => void;
  hearing: boolean;
}) {
  return (
    <>
      <Section title="Voice" hint="Changes how high or deep the voice sounds; the length stays the same.">
        <div className="grid grid-cols-3 gap-1.5">
          {VOICE_PRESETS.map((p) => (
            <Chip key={p.label} on={Math.abs(voice.pitch - p.pitch) < 0.005} onClick={() => setVoice({ pitch: p.pitch }, true)}>
              {p.label}
            </Chip>
          ))}
        </div>
        <Slider label="Pitch" value={voice.pitch} min={0.6} max={1.6} step={0.01} onGrab={onGrab} onChange={(v) => setVoice({ pitch: v })} show={(v) => (Math.abs(v - 1) < 0.005 ? "Normal" : `${v > 1 ? "+" : ""}${Math.round((v - 1) * 100)}%`)} />
        <Button size="sm" variant="primary" icon={hearing ? <Square className="size-3.5" /> : <Ear className="size-3.5" />} onClick={onHear} className="w-full">
          {hearing ? "Stop" : "Hear it (6s from the playhead)"}
        </Button>
        <p className="text-[11px] text-faint">The preview player plays the normal voice; the finished clip gets the new one.</p>
      </Section>
      <Section title="Loudness">
        <Slider label="Volume" value={voice.volume} min={0} max={2} step={0.05} onGrab={onGrab} onChange={(v) => setVoice({ volume: v })} show={(v) => (v === 0 ? "Muted" : `${Math.round(v * 100)}%`)} />
        <div className="grid grid-cols-2 gap-1.5">
          <Chip on={voice.volume === 0} onClick={() => setVoice({ volume: voice.volume === 0 ? 1 : 0 }, true)}>
            <span className="inline-flex items-center gap-1">
              <VolumeX className="size-3.5" /> Mute
            </span>
          </Chip>
          <Chip on={voice.volume === 1} onClick={() => setVoice({ volume: 1 }, true)}>
            <span className="inline-flex items-center gap-1">
              <Volume2 className="size-3.5" /> 100%
            </span>
          </Chip>
        </div>
      </Section>
    </>
  );
}

export const SplitIcon = SplitSquareHorizontal;
