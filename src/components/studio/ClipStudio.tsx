import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Crop,
  Mic,
  Pause,
  Play,
  Redo2,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Type,
  Undo2,
  X,
  Bookmark,
  Layers,
  FilePlus2,
  Replace,
} from "lucide-react";
import { useUser } from "../../lib/auth";
import { newItemId, patchItem, removeItem, saveItem, type Item } from "../../lib/items";
import { clipInfo, getClip, putClip } from "../../lib/clip-store";
import {
  DEFAULT_FRAMING,
  DEFAULT_VOICE,
  SCALE_MAX,
  SCALE_MIN,
  SHAPE_SIZE,
  boxesAt,
  drawTextBoxes,
  loadTextFonts,
  makePainter,
  nearestShape,
  pieceId,
  type Framing,
  type Look,
  type Piece,
  type Shape,
  type TextBox,
  type TextVars,
  type Voice,
} from "../../lib/clip-look";
import { RenderError, canRender, renderEdit, voiceSample, type RenderJob } from "../../lib/clip-render";
import { readSavedLook, readTarget, saveLook, saveTarget } from "../../lib/studio-prefs";
import { Timeline, fmtTime, type Source } from "./Timeline";
import { CutPanel, FramePanel, TextPanel, VoicePanel } from "./Panels";
import { TextLayer } from "./TextLayer";
import { Button, Spinner, cx, useToast } from "../ui";

type Tab = "cut" | "frame" | "text" | "voice";
type Snap = { pieces: Piece[]; look: Look };

const FRAME = 1 / 30;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Where output second `t` falls: which piece, and the second inside its source clip. */
function locate(pieces: Piece[], t: number) {
  let at = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const d = p.end - p.start;
    if (t < at + d - 1e-6 || i === pieces.length - 1) return { index: i, piece: p, offset: at, src: clamp(p.start + (t - at), p.start, p.end) };
    at += d;
  }
  return null;
}

const totalOf = (pieces: Piece[]) => pieces.reduce((a, p) => a + (p.end - p.start), 0);

const kindFor = (shape: Shape, duration: number): Item["kind"] => (shape === "16:9" || duration > 180 ? "video" : "short");

/**
 * Clip Studio: a small video editor for Ready to Post clips. Trim, split, delete or reorder parts, join other
 * clips, place the picture in a 9:16 / 16:9 / 1:1 / 4:5 frame, add timed text and change the voice — then save
 * over the clip, as a new clip, or each part as its own clip. Everything is made in this browser.
 */
export function ClipStudio({ items, itemIds, onClose }: { items: Item[]; itemIds: string[]; onClose: (message?: string) => void }) {
  const user = useUser();
  const toast = useToast();
  const mainItem = items.find((i) => i.id === itemIds[0]) ?? null;
  const kindKey: "short" | "video" = mainItem?.kind ?? "short";

  // ----- sources (the clip files) -----
  const [sources, setSources] = useState<Record<string, Source>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSource = useCallback(
    async (id: string): Promise<Source | null> => {
      const files = getClip(id);
      const item = items.find((i) => i.id === id);
      if (!files) return null;
      const info = await clipInfo(files.video);
      if (!info || !info.durationSec) return null;
      return { blob: files.video, duration: info.durationSec, title: item?.title || "Clip", width: info.width, height: info.height };
    },
    [items],
  );

  // ----- the edit, with undo / redo -----
  const [snap, setSnap] = useState<Snap>({ pieces: [], look: { shape: "9:16", framing: DEFAULT_FRAMING, texts: [], voice: DEFAULT_VOICE } });
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const initial = useRef<Snap | null>(null);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const [, setHist] = useState(0);
  const bump = () => setHist((h) => h + 1);

  /** Remember the current state for undo (call before a change, or once when a drag starts). */
  const grab = useCallback(() => {
    past.current.push(snapRef.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    bump();
  }, []);
  const commit = useCallback(
    (fn: (s: Snap) => Snap) => {
      grab();
      setSnap(fn);
    },
    [grab],
  );
  const live = useCallback((fn: (s: Snap) => Snap) => setSnap(fn), []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(snapRef.current);
    setSnap(prev);
    bump();
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(snapRef.current);
    setSnap(next);
    bump();
  }, []);

  const { pieces, look } = snap;
  const total = totalOf(pieces);

  useEffect(() => {
    let live = true;
    (async () => {
      const ok = await canRender();
      if (!ok) {
        setLoadError("This browser can't edit videos. Use Chrome or Edge (version 114 or newer) on a computer.");
        setLoading(false);
        return;
      }
      const loaded: Record<string, Source> = {};
      for (const id of itemIds) {
        const s = await loadSource(id);
        if (s) loaded[id] = s;
      }
      if (!live) return;
      const ids = itemIds.filter((id) => loaded[id]);
      if (!ids.length) {
        setLoadError("The video file of this clip isn't in this browser any more (it was added on another device or the browser data was cleared). Delete it and add the video again.");
        setLoading(false);
        return;
      }
      const first = loaded[ids[0]];
      const start: Snap = {
        pieces: ids.map((id) => ({ id: pieceId(), itemId: id, start: 0, end: loaded[id].duration })),
        // A Short stays 9:16 whatever shape its source is; a video keeps the shape nearest its own.
        look: { shape: kindKey === "short" ? "9:16" : nearestShape(first.width, first.height), framing: DEFAULT_FRAMING, texts: [], voice: DEFAULT_VOICE },
      };
      initial.current = start;
      setSources(loaded);
      setSnap(start);
      setSelectedPiece(start.pieces[0]?.id ?? null);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
    // Loaded once when the studio opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- UI state -----
  const [tab, setTab] = useState<Tab>("cut");
  const [selectedPiece, setSelectedPiece] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [target, setTargetState] = useState<number | null>(() => readTarget(kindKey));
  const setTarget = (v: number | null) => {
    setTargetState(v);
    saveTarget(kindKey, v);
  };
  const [saveOpen, setSaveOpen] = useState(false);
  const [removeOthers, setRemoveOthers] = useState(true);
  const [removeOriginal, setRemoveOriginal] = useState(false);
  const [render, setRender] = useState<{ label: string; share: number } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const selected = pieces.find((p) => p.id === selectedPiece) ?? null;

  // ----- preview -----
  const stageWrap = useRef<HTMLDivElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [fontsTick, setFontsTick] = useState(0);
  const vids = useRef(new Map<string, HTMLVideoElement>());
  const playheadRef = useRef(0);
  playheadRef.current = playhead;
  const playingRef = useRef(false);
  const curIndex = useRef(0);
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = stageWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const size = SHAPE_SIZE[look.shape];
  const fit = useMemo(() => {
    const pad = 16;
    const aw = Math.max(50, stage.w - pad * 2);
    const ah = Math.max(50, stage.h - pad * 2);
    const scale = Math.min(aw / size.width, ah / size.height);
    return { w: Math.floor(size.width * scale), h: Math.floor(size.height * scale) };
  }, [stage, size]);

  // One <video> per clip, kept for the whole session (not in the page).
  useEffect(() => {
    for (const [id, s] of Object.entries(sources)) {
      if (vids.current.has(id)) continue;
      const v = document.createElement("video");
      v.src = URL.createObjectURL(s.blob);
      v.preload = "auto";
      v.playsInline = true;
      v.addEventListener("seeked", () => drawRef.current());
      v.addEventListener("loadeddata", () => drawRef.current());
      vids.current.set(id, v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      for (const v of vids.current.values()) {
        v.pause();
        URL.revokeObjectURL(v.src);
        v.removeAttribute("src");
        v.load();
      }
      vids.current.clear();
      stopHear();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    let live = true;
    void loadTextFonts(look.texts.map((t) => t.font)).then(() => live && setFontsTick((n) => n + 1));
    return () => {
      live = false;
    };
  }, [look.texts]);

  const vars: TextVars = useMemo(() => ({ n: 1, total: 1, title: mainItem?.title ?? "" }), [mainItem?.title]);

  const painter = useMemo(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(fit.w * dpr));
    const h = Math.max(2, Math.round(fit.h * dpr));
    return { w, h, paint: makePainter(w, h) };
  }, [fit.w, fit.h]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (c.width !== painter.w) c.width = painter.w;
    if (c.height !== painter.h) c.height = painter.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const s = snapRef.current;
    const loc = locate(s.pieces, playheadRef.current);
    const v = loc ? vids.current.get(loc.piece.itemId) : null;
    if (v && v.readyState >= 2) painter.paint(ctx, v, v.videoWidth, v.videoHeight, s.look.framing);
    else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, c.width, c.height);
    }
    drawTextBoxes(ctx, boxesAt(s.look.texts, playheadRef.current), vars, c.width, c.height);
  }, [painter, vars]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Redraw on any change while paused.
  useEffect(() => {
    if (!playingRef.current) draw();
  }, [draw, snap, fontsTick, playhead]);

  const seek = useCallback(
    (t: number) => {
      const s = snapRef.current;
      const tot = totalOf(s.pieces);
      t = clamp(t, 0, Math.max(0, tot - 0.001));
      playheadRef.current = t;
      setPlayhead(t);
      const loc = locate(s.pieces, t);
      if (!loc) return;
      curIndex.current = loc.index;
      const v = vids.current.get(loc.piece.itemId);
      if (!v) return;
      if (playingRef.current) {
        for (const [id, o] of vids.current) if (id !== loc.piece.itemId) o.pause();
        v.currentTime = loc.src;
        void v.play().catch(() => {});
      } else if (Math.abs(v.currentTime - loc.src) > 0.001) v.currentTime = loc.src;
      else draw();
    },
    [draw],
  );

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(raf.current);
    for (const v of vids.current.values()) v.pause();
  }, []);

  const tick = useCallback(() => {
    if (!playingRef.current) return;
    const s = snapRef.current;
    let i = curIndex.current;
    let p = s.pieces[i];
    if (!p) return pause();
    let v = vids.current.get(p.itemId)!;
    if (v.currentTime >= p.end - 0.015 || v.ended) {
      // On to the next part.
      i++;
      if (i >= s.pieces.length) {
        pause();
        const tot = totalOf(s.pieces);
        playheadRef.current = Math.max(0, tot - 0.001);
        setPlayhead(playheadRef.current);
        draw();
        return;
      }
      const next = s.pieces[i];
      const nv = vids.current.get(next.itemId)!;
      if (nv !== v) v.pause();
      curIndex.current = i;
      nv.currentTime = next.start;
      void nv.play().catch(() => {});
      p = next;
      v = nv;
    }
    let off = 0;
    for (let k = 0; k < i; k++) off += s.pieces[k].end - s.pieces[k].start;
    const t = off + clamp(v.currentTime - p.start, 0, p.end - p.start);
    playheadRef.current = t;
    setPlayhead(t);
    draw();
    raf.current = requestAnimationFrame(tick);
  }, [draw, pause]);

  const play = useCallback(() => {
    const s = snapRef.current;
    const tot = totalOf(s.pieces);
    let t = playheadRef.current;
    if (t >= tot - 0.05) t = 0;
    const loc = locate(s.pieces, t);
    if (!loc) return;
    const v = vids.current.get(loc.piece.itemId);
    if (!v) return;
    curIndex.current = loc.index;
    v.currentTime = loc.src;
    v.volume = clamp(s.look.voice.volume, 0, 1);
    v.muted = s.look.voice.volume === 0;
    playingRef.current = true;
    setPlaying(true);
    void v.play().catch(() => pause());
    raf.current = requestAnimationFrame(tick);
  }, [pause, tick]);

  // Volume follows the voice setting while playing.
  useEffect(() => {
    for (const v of vids.current.values()) {
      v.volume = clamp(look.voice.volume, 0, 1);
      v.muted = look.voice.volume === 0;
    }
  }, [look.voice.volume]);

  // Edits to the parts while playing: stop, so the player doesn't run off the old layout.
  const piecesKey = pieces.map((p) => `${p.id}:${p.start.toFixed(3)}:${p.end.toFixed(3)}`).join("|");
  useEffect(() => {
    if (playingRef.current) pause();
    if (playheadRef.current > total) seek(Math.max(0, total - 0.001));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piecesKey]);

  // ----- frame drag / wheel zoom on the preview -----
  const frameDrag = useRef<{ px: number; py: number; f: Framing } | null>(null);
  const onStageDown = (e: ReactPointerEvent) => {
    if (tab === "text") return setSelectedText(null);
    if (tab !== "frame") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    grab();
    frameDrag.current = { px: e.clientX, py: e.clientY, f: look.framing };
  };
  const onStageMove = (e: ReactPointerEvent) => {
    const g = frameDrag.current;
    if (!g) return;
    const loc = locate(pieces, playhead);
    const v = loc ? vids.current.get(loc.piece.itemId) : null;
    const vw = v?.videoWidth || 16;
    const vh = v?.videoHeight || 9;
    const fw = fit.w;
    const fh = fit.h;
    const ratio = (fh * vw) / (vh * fw);
    const zoom = (g.f.fit === "cover" ? Math.max(1, ratio) : Math.min(1, ratio)) * g.f.scale;
    const pw = fw * zoom;
    const ph = (pw * vh) / vw;
    const dx = e.clientX - g.px;
    const dy = e.clientY - g.py;
    const x = Math.abs(fw - pw) > 1 ? clamp(g.f.x + dx / (fw - pw), 0, 1) : g.f.x;
    const y = Math.abs(fh - ph) > 1 ? clamp(g.f.y + dy / (fh - ph), 0, 1) : g.f.y;
    live((s) => ({ ...s, look: { ...s.look, framing: { ...s.look.framing, x, y } } }));
  };
  const onStageUp = () => (frameDrag.current = null);
  const wheelTimer = useRef(0);
  const onStageWheel = (e: React.WheelEvent) => {
    if (tab !== "frame") return;
    if (!wheelTimer.current) grab();
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => (wheelTimer.current = 0), 400);
    const k = Math.exp(-e.deltaY / 600);
    live((s) => ({ ...s, look: { ...s.look, framing: { ...s.look.framing, scale: clamp(s.look.framing.scale * k, SCALE_MIN, SCALE_MAX) } } }));
  };

  // ----- edit actions -----
  const setPieces = (fn: (p: Piece[]) => Piece[]) => commit((s) => ({ ...s, pieces: fn(s.pieces) }));

  const split = () => {
    const loc = locate(pieces, playhead);
    if (!loc) return;
    const p = loc.piece;
    if (loc.src - p.start < 0.1 || p.end - loc.src < 0.1) return toast("info", "Move the playhead inside a part (not at its very edge) to split it.");
    const a: Piece = { ...p, id: pieceId(), end: loc.src };
    const b: Piece = { ...p, id: pieceId(), start: loc.src };
    setPieces((ps) => ps.flatMap((x) => (x.id === p.id ? [a, b] : [x])));
    setSelectedPiece(b.id);
  };

  const deletePiece = (id = selectedPiece) => {
    if (!id) return;
    if (pieces.length < 2) return toast("info", "That's the only part left. Trim it instead, or close without saving.");
    const i = pieces.findIndex((p) => p.id === id);
    setPieces((ps) => ps.filter((p) => p.id !== id));
    const next = pieces[i + 1] ?? pieces[i - 1];
    setSelectedPiece(next?.id ?? null);
  };

  const duplicatePiece = () => {
    if (!selected) return;
    const copy = { ...selected, id: pieceId() };
    setPieces((ps) => ps.flatMap((p) => (p.id === selected.id ? [p, copy] : [p])));
    setSelectedPiece(copy.id);
  };

  const movePiece = (dir: -1 | 1) => {
    if (!selected) return;
    setPieces((ps) => {
      const i = ps.findIndex((p) => p.id === selected.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ps.length) return ps;
      const out = [...ps];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  };

  const trimToPlayhead = (edge: "start" | "end") => {
    const loc = locate(pieces, playhead);
    if (!loc) return;
    const p = loc.piece;
    if (edge === "start" && p.end - loc.src < 0.2) return toast("info", "Too close to the end of the part.");
    if (edge === "end" && loc.src - p.start < 0.2) return toast("info", "Too close to the start of the part.");
    setPieces((ps) => ps.map((x) => (x.id === p.id ? (edge === "start" ? { ...x, start: loc.src } : { ...x, end: loc.src }) : x)));
    setSelectedPiece(p.id);
    if (edge === "start") window.setTimeout(() => seek(loc.offset), 0);
  };

  /** Pieces cut to the first / last `len` seconds of the whole timeline. */
  const keepRange = (from: number, to: number) => {
    const out: Piece[] = [];
    let at = 0;
    for (const p of pieces) {
      const d = p.end - p.start;
      const a = Math.max(from, at);
      const b = Math.min(to, at + d);
      if (b - a > 0.05) out.push({ ...p, id: pieceId(), start: p.start + (a - at), end: p.start + (b - at) });
      at += d;
    }
    return out;
  };

  const splitAt = (cuts: number[], ps: Piece[]) => {
    let out = ps;
    for (const c of cuts) {
      const loc = locate(out, c);
      if (!loc) continue;
      const p = loc.piece;
      if (loc.src - p.start < 0.05 || p.end - loc.src < 0.05) continue;
      out = out.flatMap((x) => (x.id === p.id ? [{ ...p, id: pieceId(), end: loc.src }, { ...p, id: pieceId(), start: loc.src }] : [x]));
    }
    return out;
  };

  const keepFirst = () => target && setPieces(() => keepRange(0, target));
  const keepLast = () => target && setPieces(() => keepRange(total - target, total));
  const splitAtLimit = () => {
    if (!target) return;
    const out = splitAt([target], pieces);
    setPieces(() => out);
    const loc = locate(out, target + 0.01);
    if (loc) setSelectedPiece(loc.piece.id);
    window.setTimeout(() => seek(target), 0);
    toast("info", "The extra is now its own part (selected). Delete it, trim it, or save each part as its own clip.");
  };
  const splitEvery = () => {
    if (!target) return;
    const cuts: number[] = [];
    for (let t = target; t < total - 0.5; t += target) cuts.push(t);
    setPieces(() => splitAt(cuts, pieces));
    toast("info", `Split into ${cuts.length + 1} parts. Use Save → "Each part as its own clip" to make them separate.`);
  };

  const addClip = async (id: string) => {
    let s = sources[id];
    if (!s) {
      const loaded = await loadSource(id);
      if (!loaded) return toast("error", "That clip's video file isn't in this browser.");
      s = loaded;
      setSources((all) => ({ ...all, [id]: loaded }));
    }
    const p: Piece = { id: pieceId(), itemId: id, start: 0, end: s.duration };
    setPieces((ps) => [...ps, p]);
    setSelectedPiece(p.id);
    toast("ok", `“${s.title}” added at the end.`);
  };

  const reset = () => initial.current && commit(() => initial.current!);

  // ----- look actions -----
  const setShape = (shape: Shape) => commit((s) => ({ ...s, look: { ...s.look, shape } }));
  const setFraming = (f: Partial<Framing>, doCommit = false) =>
    (doCommit ? commit : live)((s) => ({ ...s, look: { ...s.look, framing: { ...s.look.framing, ...f } } }));
  const setVoice = (v: Partial<Voice>, doCommit = false) => (doCommit ? commit : live)((s) => ({ ...s, look: { ...s.look, voice: { ...s.look.voice, ...v } } }));
  const changeText = (id: string, c: Partial<TextBox>, doCommit = false) =>
    (doCommit ? commit : live)((s) => ({ ...s, look: { ...s.look, texts: s.look.texts.map((b) => (b.id === id ? { ...b, ...c } : b)) } }));
  const addText = (b: TextBox) => {
    commit((s) => ({ ...s, look: { ...s.look, texts: [...s.look.texts, b] } }));
    setSelectedText(b.id);
    setTab("text");
  };
  const removeText = (id: string) => {
    commit((s) => ({ ...s, look: { ...s.look, texts: s.look.texts.filter((b) => b.id !== id) } }));
    setSelectedText(null);
  };
  const duplicateText = (id: string) => {
    const b = look.texts.find((x) => x.id === id);
    if (!b) return;
    const copy = { ...b, id: pieceId(), y: clamp(b.y + 0.05, 0, 1 - b.h) };
    commit((s) => ({ ...s, look: { ...s.look, texts: [...s.look.texts, copy] } }));
    setSelectedText(copy.id);
  };

  // ----- hear the new voice -----
  const hearCtx = useRef<{ ctx: AudioContext; node: AudioBufferSourceNode } | null>(null);
  const [hearing, setHearing] = useState(false);
  const stopHear = () => {
    try {
      hearCtx.current?.node.stop();
      void hearCtx.current?.ctx.close();
    } catch {}
    hearCtx.current = null;
    setHearing(false);
  };
  const hear = async () => {
    if (hearing) return stopHear();
    pause();
    const loc = locate(pieces, playhead);
    const s = loc ? sources[loc.piece.itemId] : null;
    if (!loc || !s) return;
    setHearing(true);
    try {
      const buf = await voiceSample(s.blob, loc.src, Math.min(6, Math.max(1, s.duration - loc.src)), look.voice);
      if (!buf) {
        setHearing(false);
        return toast("info", "This clip has no sound to change.");
      }
      const ctx = new AudioContext();
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      node.onended = () => stopHear();
      node.start();
      hearCtx.current = { ctx, node };
    } catch (e) {
      setHearing(false);
      toast("error", (e as Error).message || "Couldn't play the voice sample.");
    }
  };

  // ----- save -----
  const jobFor = (ps: Piece[], v: TextVars): RenderJob => ({
    segments: ps.map((p) => ({ source: sources[p.itemId].blob, start: p.start, end: p.end })),
    width: size.width,
    height: size.height,
    framing: look.framing,
    texts: look.texts,
    vars: v,
    voice: look.voice,
  });

  const fileMeta = (blob: Blob, name: string): Item["file"] => ({ name, size: blob.size, type: "video/mp4", storage: "drive", path: "" });
  const safeName = (s: string) => (s.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "clip") + ".mp4";

  const newItemFrom = (base: Item, patch: Partial<Item>, at: number): Item => ({
    ...base,
    id: newItemId(),
    status: "draft",
    youtubeId: null,
    publishAt: null,
    error: null,
    thumb: null,
    createdAt: base.createdAt + at,
    updatedAt: Date.now(),
    uploadedAt: null,
    ...patch,
  });

  // Firestore applies writes to its local cache at once (Ready to Post shows them); the server copy syncs in the background.
  const bg = (e: unknown) => toast("error", `Couldn't sync to your account: ${(e as Error).message}`);

  const run = async (mode: "replace" | "new" | "parts") => {
    if (!mainItem) return;
    setSaveOpen(false);
    pause();
    stopHear();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const sourceIds = [...new Set(pieces.map((p) => p.itemId))];
    try {
      if (mode === "parts") {
        const n = pieces.length;
        const made: Item[] = [];
        for (let i = 0; i < n; i++) {
          setRender({ label: `Making part ${i + 1} of ${n}`, share: 0 });
          const res = await renderEdit(jobFor([pieces[i]], { n: i + 1, total: n, title: mainItem.title }), (sh) => setRender({ label: `Making part ${i + 1} of ${n}`, share: sh }), ctrl.signal);
          const title = `${mainItem.title.replace(/\s*[-–|]\s*Part \d+$/i, "").slice(0, 88)} – Part ${i + 1}`.slice(0, 100);
          const item = newItemFrom(mainItem, { title, kind: kindFor(look.shape, res.durationSec), durationSec: res.durationSec, file: fileMeta(res.video, safeName(title)) }, i + 1);
          putClip(item.id, { video: res.video, thumb: res.thumb, original: null });
          saveItem(user.uid, item).catch(bg);
          made.push(item);
        }
        if (removeOriginal) for (const id of sourceIds) removeItem(user.uid, id).catch(bg);
        onClose(`${made.length} clips added to Ready to Post.`);
        return;
      }

      setRender({ label: "Making your video", share: 0 });
      const res = await renderEdit(jobFor(pieces, vars), (sh) => setRender({ label: "Making your video", share: sh }), ctrl.signal);
      const kind = kindFor(look.shape, res.durationSec);
      if (mode === "replace") {
        const prev = getClip(mainItem.id);
        putClip(mainItem.id, { video: res.video, thumb: res.thumb, original: prev?.original ?? prev?.video ?? null });
        patchItem(user.uid, mainItem.id, { kind, durationSec: res.durationSec, file: fileMeta(res.video, mainItem.file?.name || safeName(mainItem.title)) }).catch(bg);
        if (removeOthers) for (const id of sourceIds) if (id !== mainItem.id) removeItem(user.uid, id).catch(bg);
        onClose(`“${mainItem.title}” saved.`);
      } else {
        const title = sourceIds.length > 1 ? `${mainItem.title} (joined)`.slice(0, 100) : `${mainItem.title} (edit)`.slice(0, 100);
        const item = newItemFrom(mainItem, { title, kind, durationSec: res.durationSec, file: fileMeta(res.video, safeName(title)) }, 1);
        putClip(item.id, { video: res.video, thumb: res.thumb, original: null });
        saveItem(user.uid, item).catch(bg);
        if (sourceIds.length > 1 && removeOthers) for (const id of sourceIds) removeItem(user.uid, id).catch(bg);
        onClose(`“${title}” added to Ready to Post.`);
      }
    } catch (e) {
      if (ctrl.signal.aborted) toast("info", "Stopped.");
      else toast("error", e instanceof RenderError ? e.message : (e as Error).message || "Couldn't make the video.");
      setRender(null);
    } finally {
      abort.current = null;
    }
  };

  const keepLook = () => {
    saveLook({ ...look, texts: look.texts });
    toast("ok", "Look saved. In Ready to Post, select clips and use “Apply saved look” to put it on all of them.");
  };
  const useSavedLook = () => {
    const l = readSavedLook();
    if (!l) return toast("info", "No saved look yet. Set one up and press “Save look”.");
    commit((s) => ({ ...s, look: l }));
    toast("ok", "Saved look applied.");
  };

  const close = () => {
    if (render) return;
    if (past.current.length && !confirm("Close the studio? Your changes here will be lost.")) return;
    onClose();
  };

  // ----- keyboard -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (render) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        return e.shiftKey ? redo() : undo();
      }
      if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        return redo();
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === " ") {
        e.preventDefault();
        return playingRef.current ? pause() : play();
      }
      if (k === "s") return split();
      if (k === "delete" || k === "backspace") {
        if (tab === "text" && selectedText) return removeText(selectedText);
        return deletePiece();
      }
      if (k === "arrowleft") return seek(playheadRef.current - (e.shiftKey ? 1 : FRAME));
      if (k === "arrowright") return seek(playheadRef.current + (e.shiftKey ? 1 : FRAME));
      if (k === "home") return seek(0);
      if (k === "end") return seek(total);
      if (k === "i") return trimToPlayhead("start");
      if (k === "o") return trimToPlayhead("end");
      if (k === "escape") return saveOpen ? setSaveOpen(false) : close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The page under the studio doesn't scroll.
  useEffect(() => {
    const before = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = before;
    };
  }, []);

  const others = items.filter((i) => i.status === "draft" && getClip(i.id)).map((i) => ({ id: i.id, title: i.title }));
  const multi = new Set(pieces.map((p) => p.itemId)).size > 1;
  const visibleTexts = look.texts.filter((b) => b.id === selectedText || boxesAt([b], playhead).length);

  const TABS: { id: Tab; label: string; icon: typeof Scissors }[] = [
    { id: "cut", label: "Cut", icon: Scissors },
    { id: "frame", label: "Frame", icon: Crop },
    { id: "text", label: "Text", icon: Type },
    { id: "voice", label: "Voice", icon: Mic },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg text-fg" role="dialog" aria-modal="true" aria-label="Clip Studio">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <button onClick={close} className="grid size-9 place-items-center rounded-xl hover:bg-card-hover" aria-label="Close">
          <X className="size-5" />
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{multi ? "Join clips" : mainItem?.title || "Clip Studio"}</div>
          <div className="hidden text-[11px] text-muted sm:block">Clip Studio · made in your browser, nothing uploaded</div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={undo} disabled={!past.current.length} className="grid size-9 place-items-center rounded-xl hover:bg-card-hover disabled:opacity-30" title="Undo (Ctrl+Z)">
            <Undo2 className="size-4.5" />
          </button>
          <button onClick={redo} disabled={!future.current.length} className="grid size-9 place-items-center rounded-xl hover:bg-card-hover disabled:opacity-30" title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="size-4.5" />
          </button>
          <div className="mx-1 hidden h-6 w-px bg-line sm:block" />
          <span className="hidden items-center gap-1 md:flex">
            <Button size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={keepLook} title="Remember frame, text and voice for batch apply">
              Save look
            </Button>
            <Button size="sm" variant="ghost" onClick={useSavedLook}>
              Use saved look
            </Button>
          </span>
          <div className="relative">
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={loading || !!loadError || !!render} onClick={() => setSaveOpen((o) => !o)}>
              Save <ChevronDown className="size-3.5" />
            </Button>
            {saveOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border border-line bg-card p-2 shadow-2xl shadow-black/30">
                <SaveOption icon={<Replace className="size-4" />} title={multi ? "Save joined video over the first clip" : "Save over this clip"} hint="The first version is kept: “Restore original” on the card brings it back." onClick={() => run("replace")} />
                <SaveOption icon={<FilePlus2 className="size-4" />} title={multi ? "Save joined video as a new clip" : "Save as a new clip"} hint="Leaves this clip as it is." onClick={() => run("new")} />
                <SaveOption
                  icon={<Layers className="size-4" />}
                  title={`Each part as its own clip (${pieces.length})`}
                  hint="Every part on the timeline becomes a separate clip, titled “… – Part 1, 2, 3”. {n} in text becomes the part number."
                  onClick={() => run("parts")}
                  disabled={pieces.length < 2}
                />
                <div className="mt-1 space-y-1.5 border-t border-line px-2.5 pb-1 pt-2.5 text-xs">
                  {multi && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={removeOthers} onChange={(e) => setRemoveOthers(e.target.checked)} className="accent-[var(--accent)]" />
                      Remove the joined clips from Ready to Post
                    </label>
                  )}
                  {pieces.length > 1 && (
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={removeOriginal} onChange={(e) => setRemoveOriginal(e.target.checked)} className="accent-[var(--accent)]" />
                      After “each part”, remove the original clip
                    </label>
                  )}
                  <div className="pt-1 text-faint">
                    Output {size.width}×{size.height} · {fmtTime(total)} · {kindFor(look.shape, total) === "short" ? "Short" : "Video"}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {loading ? (
        <div className="grid flex-1 place-items-center">
          <div className="flex flex-col items-center gap-3 text-sm text-muted">
            <Spinner />
            Opening the clip…
          </div>
        </div>
      ) : loadError ? (
        <div className="grid flex-1 place-items-center p-6">
          <div className="max-w-md text-center">
            <p className="text-sm text-muted">{loadError}</p>
            <Button className="mt-4" onClick={() => onClose()}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        // Phones: one scrolling column (preview, timeline, tools). Computers: tools on the left, nothing scrolls.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {/* Tool rail + panel */}
          <aside className="order-2 flex shrink-0 flex-col border-line lg:order-1 lg:min-h-0 lg:w-[22rem] lg:shrink lg:flex-row lg:border-r">
            <nav className="flex shrink-0 border-b border-line lg:w-16 lg:flex-col lg:border-b-0 lg:border-r lg:py-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cx(
                    "flex flex-1 flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-medium transition lg:flex-none lg:py-3",
                    tab === t.id ? "text-accent" : "text-muted hover:text-fg",
                  )}
                >
                  <span className={cx("grid size-9 place-items-center rounded-xl", tab === t.id && "bg-accent-soft")}>
                    <t.icon className="size-4.5" />
                  </span>
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {tab === "cut" && (
                <CutPanel
                  pieces={pieces}
                  selected={selected}
                  sources={sources}
                  total={total}
                  target={target}
                  setTarget={setTarget}
                  playhead={playhead}
                  others={others.filter((o) => !pieces.some((p) => p.itemId === o.id))}
                  onSplit={split}
                  onDelete={() => deletePiece()}
                  onDuplicate={duplicatePiece}
                  onMove={movePiece}
                  onTrimToPlayhead={trimToPlayhead}
                  onKeepFirst={keepFirst}
                  onKeepLast={keepLast}
                  onSplitAtLimit={splitAtLimit}
                  onSplitEvery={splitEvery}
                  onAddClip={(id) => void addClip(id)}
                  onReset={reset}
                />
              )}
              {tab === "frame" && <FramePanel shape={look.shape} setShape={setShape} framing={look.framing} setFraming={setFraming} onGrab={grab} />}
              {tab === "text" && (
                <TextPanel
                  texts={look.texts}
                  selectedId={selectedText}
                  setSelected={setSelectedText}
                  onAdd={addText}
                  onChange={changeText}
                  onRemove={removeText}
                  onDuplicate={duplicateText}
                  onGrab={grab}
                  playhead={playhead}
                  total={total}
                />
              )}
              {tab === "voice" && <VoicePanel voice={look.voice} setVoice={setVoice} onGrab={grab} onHear={() => void hear()} hearing={hearing} />}
            </div>
          </aside>

          {/* Stage + transport + timeline */}
          <main className="order-1 flex shrink-0 flex-col lg:order-2 lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink">
            <div
              ref={stageWrap}
              className={cx(
                "relative grid h-[46vh] shrink-0 place-items-center overflow-hidden bg-zinc-950 lg:h-auto lg:min-h-0 lg:flex-1",
                tab === "frame" && "cursor-grab touch-none active:cursor-grabbing",
              )}
              onPointerDown={onStageDown}
              onPointerMove={onStageMove}
              onPointerUp={onStageUp}
              onPointerCancel={onStageUp}
              onWheel={onStageWheel}
            >
              <div ref={frameBox} className="relative shadow-2xl shadow-black/60" style={{ width: fit.w, height: fit.h }}>
                <canvas ref={canvasRef} className="block size-full" />
                {tab === "text" && (
                  <TextLayer
                    frame={frameBox}
                    boxes={visibleTexts}
                    selected={selectedText}
                    onSelect={setSelectedText}
                    onChange={(id, c) => changeText(id, c)}
                    onGrab={grab}
                  />
                )}
              </div>
              {tab === "frame" && <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-white/80">Drag to move · scroll to zoom</div>}
            </div>

            <div className="flex shrink-0 items-center justify-center gap-2 border-y border-line bg-card px-3 py-2">
              <button className="grid size-9 place-items-center rounded-xl hover:bg-card-hover" onClick={() => seek(0)} title="To the start (Home)">
                <SkipBack className="size-4" />
              </button>
              <button className="grad-bg grid size-10 place-items-center rounded-full text-on-accent shadow" onClick={() => (playing ? pause() : play())} title="Play / pause (Space)">
                {playing ? <Pause className="size-4.5" /> : <Play className="ml-0.5 size-4.5" />}
              </button>
              <button className="grid size-9 place-items-center rounded-xl hover:bg-card-hover" onClick={() => seek(total)} title="To the end (End)">
                <SkipForward className="size-4" />
              </button>
              <span className="ml-2 font-mono text-xs tabular-nums text-muted">
                {fmtTime(playhead)} / {fmtTime(total)}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" icon={<Scissors className="size-3.5" />} onClick={split} title="Split at the playhead (S)">
                  Split
                </Button>
              </div>
            </div>

            <div className="shrink-0 bg-card pt-2">
              <Timeline
                pieces={pieces}
                sources={sources}
                playhead={playhead}
                selectedId={selectedPiece}
                target={target}
                onSeek={(t) => seek(t)}
                onSelect={setSelectedPiece}
                onTrim={(id, start, end) => live((s) => ({ ...s, pieces: s.pieces.map((p) => (p.id === id ? { ...p, start, end } : p)) }))}
                onGrab={grab}
              />
            </div>
          </main>
        </div>
      )}

      {render && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-bg/80 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-card p-6 text-center shadow-2xl">
            <Spinner className="mx-auto size-7" />
            <div className="mt-3 font-semibold">{render.label}</div>
            <div className="mt-1 text-sm tabular-nums text-muted">{Math.round(render.share * 100)}%</div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg-soft">
              <div className="grad-bg h-full rounded-full transition-all" style={{ width: `${Math.max(3, render.share * 100)}%` }} />
            </div>
            <p className="mt-3 text-xs text-faint">Keep this tab open. Your computer does the work, so it can take about as long as the video.</p>
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

function SaveOption({ icon, title, hint, onClick, disabled }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}
