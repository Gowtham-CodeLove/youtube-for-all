// Makes the finished MP4 of a Clip Studio edit in this browser (WebCodecs via mediabunny): any number of
// pieces from any number of clips, played one after another (trim, split, delete parts, join), drawn into the
// chosen frame with the picture placement and text, and the voice pitched / louder or quieter.
// Nothing is uploaded and nothing is installed.

import type { AudioBufferSource, CanvasSource, Input, InputAudioTrack, InputVideoTrack } from "mediabunny";
import { boxesAt, drawTextBoxes, loadTextFonts, makePainter, type Framing, type TextBox, type TextVars, type Voice } from "./clip-look";
import { pitchShift } from "./pitch";

/** A failure with a message fit to show the user. */
export class RenderError extends Error {}

export interface Segment {
  source: Blob;
  start: number;
  end: number;
}

export interface RenderJob {
  segments: Segment[];
  width: number;
  height: number;
  framing: Framing;
  texts: TextBox[];
  vars: TextVars;
  voice: Voice;
  quality?: "medium" | "high" | "max";
}

export interface RenderResult {
  video: Blob;
  thumb: Blob | null;
  durationSec: number;
}

const FPS = 30;

let supported: Promise<boolean> | null = null;
/** Whether this browser can make videos by itself (WebCodecs with H.264). */
export function canRender(): Promise<boolean> {
  supported ??= (async () => {
    if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined" || typeof OffscreenCanvas === "undefined") return false;
    try {
      const { canEncodeVideo } = await import("mediabunny");
      return await canEncodeVideo("avc", { width: 1080, height: 1920 });
    } catch {
      supported = null;
      return false;
    }
  })();
  return supported;
}

/**
 * Renders the edit; `onProgress` gets 0–1. The graphics card's encoder gives up now and then, so a render that
 * breaks is run once more on the browser's own (slower) encoder before it counts as failed.
 */
export async function renderEdit(job: RenderJob, onProgress?: (share: number) => void, signal?: AbortSignal): Promise<RenderResult> {
  if (!job.segments.length) throw new RenderError("Nothing to make: every part was removed.");
  try {
    return await renderOnce(job, false, onProgress, signal);
  } catch (e) {
    if (e instanceof RenderError || signal?.aborted) throw e;
    console.warn("Render failed, trying the software encoder:", e);
  }
  try {
    return await renderOnce(job, true, onProgress, signal);
  } catch (e) {
    if (e instanceof RenderError || signal?.aborted) throw e;
    console.error("Render failed:", e);
    const reason = e instanceof Error && e.name !== "Error" ? ` (${e.name})` : "";
    throw new RenderError(`The video couldn't be made in this browser${reason}. Close other tabs playing video and try again, or use Chrome / Edge on a computer.`);
  }
}

type Opened = { input: Input; video: InputVideoTrack | null; audio: InputAudioTrack | null };

async function renderOnce(job: RenderJob, software: boolean, onProgress?: (share: number) => void, signal?: AbortSignal): Promise<RenderResult> {
  const mb = await import("mediabunny");
  const { width: W, height: H } = job;

  // Each source file opened once.
  const opened = new Map<Blob, Opened>();
  for (const seg of job.segments) {
    if (opened.has(seg.source)) continue;
    const input = new mb.Input({ source: new mb.BlobSource(seg.source), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack().catch(() => null);
    const audio = await input.getPrimaryAudioTrack().catch(() => null);
    if (!video || !(await video.canDecode())) {
      input.dispose();
      for (const o of opened.values()) o.input.dispose();
      throw new RenderError("One of the clips isn't a video this browser can read. Use MP4 (H.264) clips.");
    }
    opened.set(seg.source, { input, video, audio: audio && (await audio.canDecode()) ? audio : null });
  }

  try {
    const frameCounts = job.segments.map((s) => Math.max(1, Math.round((s.end - s.start) * FPS)));
    const totalFrames = frameCounts.reduce((a, b) => a + b, 0);
    const durationSec = totalFrames / FPS;
    const withAudio = [...opened.values()].some((o) => o.audio);
    const firstAudio = [...opened.values()].find((o) => o.audio)?.audio ?? null;
    const rate = firstAudio ? firstAudio.sampleRate || 48000 : 48000;

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new RenderError("Your browser couldn't set up the drawing surface.");
    const paint = makePainter(W, H);

    // Text layers, made once per set of boxes on screen.
    await loadTextFonts(job.texts.map((b) => b.font));
    const layers = new Map<string, OffscreenCanvas | null>();
    const layerAt = (t: number) => {
      const on = boxesAt(job.texts, t);
      const key = on.map((b) => b.id).join(",");
      if (!layers.has(key)) {
        if (!on.length) layers.set(key, null);
        else {
          const c = new OffscreenCanvas(W, H);
          const cx = c.getContext("2d");
          if (cx) drawTextBoxes(cx, on, job.vars, W, H);
          layers.set(key, c);
        }
      }
      return layers.get(key) ?? null;
    };

    const quality = job.quality === "max" ? mb.QUALITY_VERY_HIGH : job.quality === "medium" ? mb.QUALITY_MEDIUM : mb.QUALITY_HIGH;
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
    const videoSource: CanvasSource = new mb.CanvasSource(canvas, {
      codec: "avc",
      quality,
      keyFrameInterval: 2,
      hardwareAcceleration: software ? "prefer-software" : "no-preference",
    });
    output.addVideoTrack(videoSource, { frameRate: FPS });

    let audioSource: AudioBufferSource | null = null;
    if (withAudio) {
      const codec = (await mb.canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: rate })) ? "aac" : "opus";
      audioSource = new mb.AudioBufferSource({ codec, quality: mb.QUALITY_HIGH });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    let thumb: Blob | null = null;
    const thumbAt = Math.min(1, durationSec / 2);
    let framesDone = 0;
    let outFrame = 0;

    for (let si = 0; si < job.segments.length; si++) {
      const seg = job.segments[si];
      const src = opened.get(seg.source)!;
      const track = src.video!;
      const count = frameCounts[si];

      // ----- picture -----
      const long = Math.max(track.displayWidth, track.displayHeight);
      const sinkOpts = long > 2560 ? (track.displayWidth >= track.displayHeight ? { width: 1920 } : { height: 1920 }) : {};
      const sink = new mb.CanvasSink(track, { poolSize: 2, ...sinkOpts });
      const first = await track.getFirstTimestamp();
      const times = Array.from({ length: count }, (_, k) => Math.max(first, seg.start + k / FPS + 0.0005));
      let last: { canvas: HTMLCanvasElement | OffscreenCanvas } | null = null;
      for await (const wrapped of sink.canvasesAtTimestamps(times)) {
        if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
        if (wrapped) last = wrapped;
        const t = outFrame / FPS;
        if (last) paint(ctx, last.canvas, last.canvas.width, last.canvas.height, job.framing);
        else {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, W, H);
        }
        const layer = layerAt(t);
        if (layer) ctx.drawImage(layer, 0, 0);
        await videoSource.add(t, 1 / FPS);
        if (!thumb && t >= thumbAt - 0.02) {
          const still = new OffscreenCanvas(Math.round(W / 2), Math.round(H / 2));
          still.getContext("2d")?.drawImage(canvas, 0, 0, still.width, still.height);
          thumb = await still.convertToBlob({ type: "image/jpeg", quality: 0.82 }).catch(() => null);
        }
        outFrame++;
        framesDone++;
        if (framesDone % 5 === 0) onProgress?.(Math.min(0.97, (framesDone / totalFrames) * 0.95));
      }
      // A stream that ended early: hold the last picture for the frames still owed.
      while (outFrame < frameCounts.slice(0, si + 1).reduce((a, b) => a + b, 0)) {
        const t = outFrame / FPS;
        const layer = layerAt(t);
        if (layer) ctx.drawImage(layer, 0, 0);
        await videoSource.add(t, 1 / FPS);
        outFrame++;
        framesDone++;
      }

      // ----- sound -----
      if (audioSource) await addSegmentSound(audioSource, src.audio, seg.start, count / FPS, rate, job.voice, si > 0, mb);
    }

    onProgress?.(0.98);
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new RenderError("The video couldn't be made in this browser.");
    onProgress?.(1);
    return { video: new Blob([buffer], { type: "video/mp4" }), thumb, durationSec: Math.round(durationSec * 100) / 100 };
  } finally {
    for (const o of opened.values()) o.input.dispose();
  }
}

type MB = typeof import("mediabunny");

/** Pushes exactly `round(dur*rate)` frames of stereo sound for one piece (silence where the clip has none). */
async function addSegmentSound(out: AudioBufferSource, track: InputAudioTrack | null, start: number, dur: number, rate: number, voice: Voice, fadeIn: boolean, mb: MB) {
  const total = Math.round(dur * rate);
  const CHUNK = rate; // one second per AudioBuffer
  const gain = voice.volume;
  const emit = async (left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>) => {
    for (let at = 0; at < left.length; at += CHUNK) {
      const n = Math.min(CHUNK, left.length - at);
      const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: rate });
      buf.copyToChannel(left.subarray(at, at + n), 0);
      buf.copyToChannel(right.subarray(at, at + n), 1);
      await out.add(buf);
    }
  };
  const silence = async (n: number) => {
    for (let at = 0; at < n; at += CHUNK) {
      const k = Math.min(CHUNK, n - at);
      const z = new Float32Array(k);
      await emit(z, z);
    }
  };
  if (!track) return silence(total);

  const pitched = Math.abs(voice.pitch - 1) >= 0.005;
  const sink = new mb.AudioBufferSink(track);

  if (!pitched) {
    // Streamed straight through: sound placed sample by sample where it belongs, gaps filled with silence.
    let written = 0;
    const fadeLen = fadeIn ? Math.round(rate * 0.004) : 0;
    for await (const { buffer, timestamp } of sink.buffers(Math.max(0, start - 0.05), start + dur + 0.05)) {
      if (written >= total) break;
      const step = buffer.sampleRate / rate;
      const L = buffer.getChannelData(0);
      const R = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
      // Output index of this buffer's first sample.
      const at = Math.round((timestamp - start) * rate);
      const outLen = Math.floor(buffer.length / step);
      if (at > written) {
        await silence(Math.min(at, total) - written);
        written = Math.min(at, total);
      }
      const from = written - at; // output samples of this buffer already covered
      const n = Math.min(outLen - from, total - written);
      if (n <= 0) continue;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const pos = (from + i) * step;
        const j = Math.floor(pos);
        const f = pos - j;
        const j1 = Math.min(j + 1, buffer.length - 1);
        let g = gain;
        const o = written + i;
        if (o < fadeLen) g *= o / fadeLen;
        l[i] = clip((L[j] * (1 - f) + L[j1] * f) * g);
        r[i] = clip((R[j] * (1 - f) + R[j1] * f) * g);
      }
      await emit(l, r);
      written += n;
    }
    if (written < total) await silence(total - written);
    return;
  }

  // Pitched: the piece is decoded whole (at its own rate), changed once, then fitted to the output rate.
  const srcRate = track.sampleRate || rate;
  const srcTotal = Math.round(dur * srcRate);
  const L = new Float32Array(srcTotal);
  const R = new Float32Array(srcTotal);
  for await (const { buffer, timestamp } of sink.buffers(Math.max(0, start - 0.05), start + dur + 0.05)) {
    const at = Math.round((timestamp - start) * srcRate);
    const bl = buffer.getChannelData(0);
    const br = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
    for (let i = 0; i < buffer.length; i++) {
      const o = at + i;
      if (o < 0) continue;
      if (o >= srcTotal) break;
      L[o] = bl[i];
      R[o] = br[i];
    }
  }
  const [pl, pr] = pitchShift([L, R], srcRate, voice.pitch);
  const step = srcRate / rate;
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  const fadeLen = Math.round(rate * 0.004);
  for (let i = 0; i < total; i++) {
    const pos = i * step;
    const j = Math.min(Math.floor(pos), pl.length - 1);
    const j1 = Math.min(j + 1, pl.length - 1);
    const f = pos - Math.floor(pos);
    let g = gain;
    if (fadeIn && i < fadeLen) g *= i / fadeLen;
    if (i > total - fadeLen) g *= (total - i) / fadeLen;
    l[i] = clip((pl[j] * (1 - f) + pl[j1] * f) * g);
    r[i] = clip((pr[j] * (1 - f) + pr[j1] * f) * g);
  }
  await emit(l, r);
}

const clip = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v || 0);

// ---------- Small helpers for the studio ----------

/** `count` small pictures spread over `start`…`end` of a clip, for the timeline. */
export async function filmstrip(blob: Blob, start: number, end: number, count: number, height = 72, onPicture?: (index: number, url: string) => void): Promise<string[]> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const sink = new mb.CanvasSink(track, { height, poolSize: 1 });
    const times = Array.from({ length: count }, (_, i) => start + ((end - start) * (i + 0.5)) / count);
    const urls: string[] = [];
    for await (const w of sink.canvasesAtTimestamps(times)) {
      if (!w) {
        urls.push("");
        continue;
      }
      const c = w.canvas;
      const blobOut =
        c instanceof OffscreenCanvas
          ? await c.convertToBlob({ type: "image/jpeg", quality: 0.6 })
          : await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, "image/jpeg", 0.6));
      const url = blobOut ? URL.createObjectURL(blobOut) : "";
      urls.push(url);
      if (url) onPicture?.(urls.length - 1, url);
    }
    return urls;
  } catch {
    return [];
  } finally {
    input.dispose();
  }
}

/** Loudness envelope of a clip (0–1 per bucket), for the waveform under the timeline. */
export async function waveform(blob: Blob, buckets: number): Promise<number[]> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return [];
    const duration = await input.computeDuration();
    const peaks = new Float32Array(buckets);
    for await (const { buffer, timestamp } of new mb.AudioBufferSink(track).buffers()) {
      const d = buffer.getChannelData(0);
      const stride = Math.max(1, Math.floor(d.length / 64));
      for (let i = 0; i < d.length; i += stride) {
        const t = timestamp + i / buffer.sampleRate;
        const b = Math.min(buckets - 1, Math.max(0, Math.floor((t / duration) * buckets)));
        const v = Math.abs(d[i]);
        if (v > peaks[b]) peaks[b] = v;
      }
    }
    const max = Math.max(0.05, ...peaks);
    return Array.from(peaks, (p) => p / max);
  } catch {
    return [];
  } finally {
    input.dispose();
  }
}

/** A few seconds of a clip's sound with the voice changed, ready to play — the "Hear it" button. */
export async function voiceSample(blob: Blob, from: number, seconds: number, voice: Voice): Promise<AudioBuffer | null> {
  const { decodeSound } = await import("./pitch");
  const decoded = await decodeSound(blob, from, from + seconds);
  if (!decoded) return null;
  const changed = pitchShift(decoded.channels, decoded.rate, voice.pitch);
  const buf = new AudioBuffer({ length: changed[0].length, numberOfChannels: changed.length, sampleRate: decoded.rate });
  changed.forEach((ch, i) => {
    const out = new Float32Array(ch.length);
    for (let k = 0; k < ch.length; k++) out[k] = clip(ch[k] * voice.volume);
    buf.copyToChannel(out, i);
  });
  return buf;
}
