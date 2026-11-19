import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { TextBox } from "../../lib/clip-look";
import { cx } from "../ui";

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const MIN_W = 0.08;
const MIN_H = 0.03;
const SNAP = 0.012;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Handles over the preview for the text boxes on screen (the text itself is drawn on the preview canvas):
 * drag a box to move it, drag a corner to resize it. Middles snap onto the frame's middle.
 */
export function TextLayer({
  frame,
  boxes,
  selected,
  onSelect,
  onChange,
  onGrab,
}: {
  frame: RefObject<HTMLDivElement | null>;
  boxes: TextBox[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, change: Partial<TextBox>) => void;
  /** Called once when a drag starts (for undo). */
  onGrab: () => void;
}) {
  const [guides, setGuides] = useState<{ x: boolean; y: boolean } | null>(null);
  const grab = useRef<{ id: string; corner: Corner | null; px: number; py: number; box: TextBox; moved: boolean } | null>(null);

  function start(e: ReactPointerEvent, box: TextBox, corner: Corner | null) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(box.id);
    grab.current = { id: box.id, corner, px: e.clientX, py: e.clientY, box, moved: false };
  }

  function move(e: ReactPointerEvent) {
    const g = grab.current;
    const rect = frame.current?.getBoundingClientRect();
    if (!g || !rect) return;
    if (!g.moved) {
      g.moved = true;
      onGrab();
    }
    const dx = (e.clientX - g.px) / rect.width;
    const dy = (e.clientY - g.py) / rect.height;
    const b = g.box;
    if (!g.corner) {
      let x = clamp(b.x + dx, 0, 1 - b.w);
      let y = clamp(b.y + dy, 0, 1 - b.h);
      const snapX = Math.abs(x + b.w / 2 - 0.5) < SNAP;
      const snapY = Math.abs(y + b.h / 2 - 0.5) < SNAP;
      if (snapX) x = 0.5 - b.w / 2;
      if (snapY) y = 0.5 - b.h / 2;
      setGuides({ x: snapX, y: snapY });
      onChange(g.id, { x, y });
      return;
    }
    const left = g.corner.endsWith("w");
    const top = g.corner.startsWith("n");
    const x1 = b.x;
    const x2 = b.x + b.w;
    const y1 = b.y;
    const y2 = b.y + b.h;
    const nx1 = left ? clamp(x1 + dx, 0, x2 - MIN_W) : x1;
    const nx2 = left ? x2 : clamp(x2 + dx, x1 + MIN_W, 1);
    const ny1 = top ? clamp(y1 + dy, 0, y2 - MIN_H) : y1;
    const ny2 = top ? y2 : clamp(y2 + dy, y1 + MIN_H, 1);
    onChange(g.id, { x: nx1, y: ny1, w: nx2 - nx1, h: ny2 - ny1 });
  }

  function end() {
    grab.current = null;
    setGuides(null);
  }

  return (
    <>
      {guides && (
        <>
          <span className={cx("pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2", guides.x ? "bg-accent" : "bg-white/30")} />
          <span className={cx("pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2", guides.y ? "bg-accent" : "bg-white/30")} />
        </>
      )}
      {boxes.map((box) => {
        const on = box.id === selected;
        return (
          <div
            key={box.id}
            role="button"
            tabIndex={0}
            aria-label={`Text box: ${box.text || "empty"} — drag to move, drag a corner to resize`}
            onPointerDown={(e) => start(e, box, null)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.02 : 0.004;
              const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const by = moves[e.key];
              if (!by) return;
              e.preventDefault();
              e.stopPropagation();
              onSelect(box.id);
              onChange(box.id, { x: clamp(box.x + by[0], 0, 1 - box.w), y: clamp(box.y + by[1], 0, 1 - box.h) });
            }}
            className={cx(
              "absolute touch-none select-none outline-none",
              on ? "cursor-move ring-2 ring-accent" : "cursor-pointer ring-1 ring-white/25 hover:ring-white/60 focus-visible:ring-white/70",
            )}
            style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
          >
            {on &&
              CORNERS.map((corner) => (
                <span
                  key={corner}
                  onPointerDown={(e) => start(e, box, corner)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                  className={cx(
                    "absolute size-3.5 rounded-[4px] border-2 border-accent bg-white shadow",
                    corner === "nw" && "-left-2 -top-2 cursor-nwse-resize",
                    corner === "se" && "-bottom-2 -right-2 cursor-nwse-resize",
                    corner === "ne" && "-right-2 -top-2 cursor-nesw-resize",
                    corner === "sw" && "-bottom-2 -left-2 cursor-nesw-resize",
                  )}
                />
              ))}
          </div>
        );
      })}
    </>
  );
}
