// Clip Studio choices remembered in this browser: the length limit and the "saved look" that
// Ready to Post's batch "Apply look" puts on many clips at once.

import { DEFAULT_FRAMING, DEFAULT_VOICE, newTextBox, type Look, type TextBox } from "./clip-look";

const LOOK_KEY = "utf-studio-look";
const TARGET_KEY = "utf-studio-target";

export function readSavedLook(): Look | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null") as Look | null;
    if (!v || typeof v !== "object" || !v.shape) return null;
    return {
      shape: v.shape,
      framing: { ...DEFAULT_FRAMING, ...v.framing },
      voice: { ...DEFAULT_VOICE, ...v.voice },
      texts: Array.isArray(v.texts) ? v.texts.map((b: TextBox) => ({ ...newTextBox(), ...b })) : [],
    };
  } catch {
    return null;
  }
}

export function saveLook(look: Look) {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {}
}

/** Length limit in seconds per kind (null = no limit). Shorts default to 60 s. */
export function readTarget(kind: "short" | "video"): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(TARGET_KEY) ?? "{}") as Record<string, number | null>;
    if (kind in all) return all[kind] ?? null;
  } catch {}
  return kind === "short" ? 60 : null;
}

export function saveTarget(kind: "short" | "video", value: number | null) {
  try {
    const all = JSON.parse(localStorage.getItem(TARGET_KEY) ?? "{}") as Record<string, number | null>;
    all[kind] = value;
    localStorage.setItem(TARGET_KEY, JSON.stringify(all));
  } catch {}
}
