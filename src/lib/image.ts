import fs from "node:fs/promises";
import sharp from "sharp";
import { OPENAI_IMAGE_DETAIL } from "../config.js";

export async function encodeImage(imagePath: string): Promise<string> {
  const buf = await fs.readFile(imagePath);
  return buf.toString("base64");
}

export function imageContent(base64: string, detail = OPENAI_IMAGE_DETAIL) {
  return {
    type: "image_url" as const,
    image_url: { url: `data:image/png;base64,${base64}`, detail },
  };
}

/**
 * Crop using normalized [0..1] coordinates, clamp degenerate boxes,
 * and upscale so the longest side is >= 1200px (mirrors the Python crop).
 */
export async function cropImageB64(
  imagePath: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<string> {
  const img = sharp(imagePath);
  const { width: w = 0, height: h = 0 } = await img.metadata();

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  x1 = clamp(x1); y1 = clamp(y1); x2 = clamp(x2); y2 = clamp(y2);
  if (x2 <= x1) x2 = Math.min(1, x1 + 0.05);
  if (y2 <= y1) y2 = Math.min(1, y1 + 0.05);

  // Pixel coords — ensure left/top are strictly inside the image
  const left   = Math.min(Math.floor(x1 * w), w - 1);
  const top    = Math.min(Math.floor(y1 * h), h - 1);
  const right  = Math.min(Math.ceil(x2 * w),  w);
  const bottom = Math.min(Math.ceil(y2 * h),  h);

  // Guarantee at least 1px in each dimension so sharp never gets width=0
  const cropW = Math.max(right  - left, 1);
  const cropH = Math.max(bottom - top,  1);

  let cropped = sharp(await img.extract({
    left,
    top,
    width:  Math.min(cropW, w - left),   // never overflow the image edge
    height: Math.min(cropH, h - top),
  }).toBuffer());

  const meta = await cropped.metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longest > 0 && longest < 1200) {
    const scale = 1200 / longest;
    cropped = cropped.resize(
      Math.round((meta.width ?? 0) * scale),
      Math.round((meta.height ?? 0) * scale),
      { kernel: "lanczos3" },
    );
  }
  return (await cropped.png().toBuffer()).toString("base64");
}
