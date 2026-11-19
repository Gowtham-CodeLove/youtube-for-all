// How a clip looks in the Clip Studio: its frame shape, where the picture sits in it, and the text on it.
// The live preview and the finished video are drawn by the same functions here, so what is seen is what is made.

export type Shape = "9:16" | "16:9" | "1:1" | "4:5";

export const SHAPES: { value: Shape; label: string; hint: string }[] = [
  { value: "9:16", label: "9:16", hint: "Shorts / Reels" },
  { value: "16:9", label: "16:9", hint: "YouTube video" },
  { value: "1:1", label: "1:1", hint: "Square" },
  { value: "4:5", label: "4:5", hint: "Portrait post" },
];

export const SHAPE_SIZE: Record<Shape, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/** The shape nearest to a `w`×`h` picture. */
export function nearestShape(w: number, h: number): Shape {
  if (!w || !h) return "9:16";
  const r = w / h;
  let best: Shape = "9:16";
  let diff = Infinity;
  for (const s of SHAPES) {
    const { width, height } = SHAPE_SIZE[s.value];
    const d = Math.abs(Math.log(r / (width / height)));
    if (d < diff) {
      diff = d;
      best = s.value;
    }
  }
  return best;
}

// ---------- Picture placement ----------

export interface Framing {
  /** `contain`: the whole picture shows. `cover`: the picture fills the frame (edges cut off). */
  fit: "contain" | "cover";
  /** Extra zoom on top of `fit` (1 = none). */
  scale: number;
  /** 0 = picture against the left edge (or its left side shown), 1 = right; 0.5 = centred. */
  x: number;
  /** 0 = against the top (or its top shown), 1 = bottom; 0.5 = centred. */
  y: number;
  /** What fills the frame where the picture doesn't reach. */
  background: "blur" | "black" | "white";
}

export const DEFAULT_FRAMING: Framing = { fit: "contain", scale: 1, x: 0.5, y: 0.5, background: "blur" };
export const SCALE_MIN = 0.4;
export const SCALE_MAX = 4;

/** Width of the picture as a share of the frame width, for a `pw`×`ph` picture in a `fw`×`fh` frame. */
function zoomOf(pw: number, ph: number, fw: number, fh: number, f: Framing) {
  const ratio = (fh * pw) / (ph * fw);
  const base = f.fit === "cover" ? Math.max(1, ratio) : Math.min(1, ratio);
  return base * f.scale;
}

type Rect = { x: number; y: number; width: number; height: number };

/** The part of the picture that shows (`source`, picture pixels) and where it lands (`dest`, frame pixels). */
export function placePicture(pw: number, ph: number, fw: number, fh: number, f: Framing): { source: Rect; dest: Rect } {
  const width = fw * zoomOf(pw, ph, fw, fh, f);
  const scale = width / pw;
  const height = ph * scale;
  const left = (fw - width) * f.x;
  const top = (fh - height) * f.y;
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(fw, left + width);
  const y1 = Math.min(fh, top + height);
  return {
    dest: { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) },
    source: { x: (x0 - left) / scale, y: (y0 - top) / scale, width: Math.max(0, x1 - x0) / scale, height: Math.max(0, y1 - y0) / scale },
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Picture = CanvasImageSource;

/** Draws video frames into a `width`×`height` frame. Keeps a small canvas for the blurred background. */
export function makePainter(width: number, height: number) {
  const small = new OffscreenCanvas(Math.max(2, Math.round(width / 6)), Math.max(2, Math.round(height / 6)));
  const smallCtx = small.getContext("2d", { alpha: false });
  return (ctx: Ctx, pic: Picture, pw: number, ph: number, f: Framing) => {
    ctx.save();
    ctx.fillStyle = f.background === "white" ? "#ffffff" : "#000000";
    ctx.fillRect(0, 0, width, height);
    if (!pw || !ph) return ctx.restore();
    if (f.background === "blur" && smallCtx) {
      // Cover-fit copy drawn small, then blurred up: looks the same as a full-size blur and costs far less.
      const scale = Math.max(small.width / pw, small.height / ph);
      const sw = small.width / scale;
      const sh = small.height / scale;
      smallCtx.drawImage(pic, (pw - sw) / 2, (ph - sh) / 2, sw, sh, 0, 0, small.width, small.height);
      if ("filter" in ctx) ctx.filter = `blur(${Math.round(width / 40)}px) brightness(0.8)`;
      const pad = width / 20;
      ctx.drawImage(small, -pad, -pad, width + 2 * pad, height + 2 * pad);
      if ("filter" in ctx) ctx.filter = "none";
    }
    const { source, dest } = placePicture(pw, ph, width, height, f);
    if (dest.width >= 1 && dest.height >= 1) ctx.drawImage(pic, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);
    ctx.restore();
  };
}

// ---------- Text boxes ----------

export interface TextBox {
  id: string;
  /** `{n}` part number, `{total}` how many parts, `{title}` the clip's title. New lines are kept. */
  text: string;
  /** Box position and size as 0–1 shares of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Letter size on a 1080-wide frame; shrinks when the text needs it to fit. */
  size: number;
  font: string;
  color: string;
  background: "none" | "box";
  backgroundColor: string;
  backgroundOpacity: number;
  align: "left" | "center" | "right";
  outline: boolean;
  /** Shown from / until this second of the finished clip; null = from the start / to the end. */
  from: number | null;
  to: number | null;
}

export interface TextVars {
  n: number;
  total: number;
  title: string;
}

export const fillText = (template: string, v: TextVars) =>
  template.replaceAll("{n}", String(v.n)).replaceAll("{total}", String(v.total)).replaceAll("{title}", v.title);

const newId = () => Math.random().toString(36).slice(2, 10);

export function newTextBox(kind: "plain" | "part" | "title" | "caption" = "plain"): TextBox {
  const base: TextBox = {
    id: newId(),
    text: "Your text",
    x: 0.08,
    y: 0.7,
    w: 0.84,
    h: 0.1,
    size: 64,
    font: "catamaran",
    color: "#ffffff",
    background: "none",
    backgroundColor: "#000000",
    backgroundOpacity: 0.6,
    align: "center",
    outline: true,
    from: null,
    to: null,
  };
  if (kind === "part") return { ...base, text: "Part {n}", x: 0.3, y: 0.2, w: 0.4, h: 0.06, size: 60, background: "box", backgroundColor: "#059669", backgroundOpacity: 0.95, outline: false };
  if (kind === "title") return { ...base, text: "{title}", x: 0.05, y: 0.06, w: 0.9, h: 0.12, size: 64 };
  if (kind === "caption") return { ...base, text: "Caption", x: 0.06, y: 0.78, w: 0.88, h: 0.09, size: 56, background: "box", backgroundOpacity: 0.55, outline: false };
  return base;
}

/** The boxes shown at second `t` of the finished clip. */
export const boxesAt = (boxes: TextBox[], t: number) => boxes.filter((b) => (b.from === null || t >= b.from) && (b.to === null || t < b.to));

export const TEXT_FONTS = [
  { id: "catamaran", label: "Catamaran", family: "'Catamaran', 'Nirmala UI', sans-serif", weight: 800 },
  { id: "mukta", label: "Mukta Malar", family: "'Mukta Malar', 'Nirmala UI', sans-serif", weight: 800 },
  { id: "noto", label: "Noto Sans Tamil", family: "'Noto Sans Tamil', 'Nirmala UI', sans-serif", weight: 700 },
  { id: "anton", label: "Anton (English)", family: "'Anton', Impact, sans-serif", weight: 400 },
  { id: "system", label: "Arial", family: "Arial, 'Nirmala UI', sans-serif", weight: 700 },
] as const;

export const fontOf = (id: string) => TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0];

let fontLink: HTMLLinkElement | null = null;
/** Loads the text fonts (Tamil + English) and waits until a canvas can draw with them. */
export async function loadTextFonts(ids: Iterable<string>) {
  if (typeof document === "undefined") return;
  if (!fontLink) {
    fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Anton&family=Catamaran:wght@800&family=Mukta+Malar:wght@800&family=Noto+Sans+Tamil:wght@700&display=swap";
    document.head.appendChild(fontLink);
    await new Promise<void>((resolve) => {
      fontLink!.onload = () => resolve();
      fontLink!.onerror = () => resolve();
      setTimeout(resolve, 4000);
    });
  }
  if (!document.fonts) return;
  await Promise.all(
    [...new Set(ids)].map((id) => {
      const f = fontOf(id);
      return document.fonts.load(`${f.weight} 48px ${f.family}`, "தமிழ் Aa").catch(() => undefined);
    }),
  );
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** Letters as people see them — a Tamil letter with its vowel sign stays in one piece. */
const graphemes = (word: string) => (segmenter ? [...segmenter.segment(word)].map((s) => s.segment) : [...word]);

function wrap(ctx: Ctx, text: string, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const tried = line ? `${line} ${word}` : word;
      if (ctx.measureText(tried).width <= max) {
        line = tried;
        continue;
      }
      if (line) lines.push(line);
      if (ctx.measureText(word).width <= max) {
        line = word;
        continue;
      }
      line = "";
      for (const letter of graphemes(word)) {
        if (line && ctx.measureText(line + letter).width > max) {
          lines.push(line);
          line = letter;
        } else line += letter;
      }
    }
    lines.push(line);
  }
  return lines;
}

function hexToRgba(hex: string, alpha: number) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/** Draws the boxes on a `width`×`height` canvas. Letter sizes are relative to a frame whose short side is 1080. */
export function drawTextBoxes(ctx: Ctx, boxes: TextBox[], vars: TextVars, width: number, height: number) {
  const scale = Math.min(width, height) / 1080;
  for (const box of boxes) {
    const text = fillText(box.text, vars).trim();
    const bx = box.x * width;
    const by = box.y * height;
    const bw = box.w * width;
    const bh = box.h * height;
    const font = fontOf(box.font);
    let size = box.size * scale;
    let lines: string[] = [];
    let pad = 0;
    for (let tries = 0; tries < 40; tries++) {
      ctx.font = `${font.weight} ${size}px ${font.family}`;
      pad = box.background === "box" ? size * 0.3 : box.outline ? size * 0.12 : 0;
      lines = text ? wrap(ctx, text, Math.max(1, bw - 2 * pad)) : [];
      const tall = lines.length * size * 1.25 + 2 * pad;
      const wide = Math.max(0, ...lines.map((l) => ctx.measureText(l).width)) + 2 * pad;
      if ((tall <= bh && wide <= bw + 0.5) || size <= 8 * scale) break;
      size *= 0.94;
    }

    ctx.save();
    if (box.background === "box" && text) {
      ctx.fillStyle = hexToRgba(box.backgroundColor, box.backgroundOpacity);
      const r = Math.min(bh / 2, size * 0.28);
      ctx.beginPath();
      if ("roundRect" in ctx) ctx.roundRect(bx, by, bw, bh, r);
      else (ctx as CanvasRenderingContext2D).rect(bx, by, bw, bh);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    ctx.textBaseline = "middle";
    ctx.textAlign = box.align;
    const lineHeight = size * 1.25;
    const x = box.align === "left" ? bx + pad : box.align === "right" ? bx + bw - pad : bx + bw / 2;
    let y = by + (bh - lines.length * lineHeight) / 2 + lineHeight / 2;
    for (const line of lines) {
      if (box.outline) {
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(2 * scale, size * 0.14);
        ctx.strokeStyle = "rgba(0,0,0,0.9)";
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = box.color;
      ctx.fillText(line, x, y);
      y += lineHeight;
    }
    ctx.restore();
  }
}

// ---------- Voice ----------

export interface Voice {
  /** 0.6–1.6; 1 = untouched. The length stays the same. */
  pitch: number;
  /** 0–2; 1 = untouched. */
  volume: number;
}

export const DEFAULT_VOICE: Voice = { pitch: 1, volume: 1 };

export const VOICE_PRESETS: { label: string; pitch: number }[] = [
  { label: "Deep", pitch: 0.8 },
  { label: "Lower", pitch: 0.9 },
  { label: "Normal", pitch: 1 },
  { label: "Higher", pitch: 1.12 },
  { label: "Kid", pitch: 1.3 },
  { label: "Cartoon", pitch: 1.5 },
];

// ---------- The whole edit ----------

/** One kept piece of a source clip, in the order it plays. */
export interface Piece {
  id: string;
  /** Ready to Post item the piece comes from. */
  itemId: string;
  start: number;
  end: number;
}

export interface Look {
  shape: Shape;
  framing: Framing;
  texts: TextBox[];
  voice: Voice;
}

export const pieceId = newId;
