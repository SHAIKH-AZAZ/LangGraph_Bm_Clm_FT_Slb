import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import pLimit from "p-limit";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { OPENAI_MODEL, PROMPTS_DIR } from "../../config.js";
import { imageContent } from "../../lib/image.js";
import type { Beam, TraceEvent } from "../../schemas/elements.schema.js";

/* ------------------------------------------------------------------ */
/* Tunables (verbatim from layout_extractor.py)                        */
/* ------------------------------------------------------------------ */

const STRIPE_COUNT = 7;
const STRIPE_OVERLAP = 10;        // px legacy fallback
const STRIPE_OVERLAP_PCT = 0.12;  // fraction of one stripe height
const TILE_ROWS = 5;
const TILE_COLS = 5;
const TILE_OVERLAP = 100;         // px, all four sides
const CLASSIFIER_THUMB_PX = 1500;
const MAX_WORKERS = 3;

export type LayoutKind = "stripe" | "grid" | "table";

/* ------------------------------------------------------------------ */
/* Step 0 — DPI-capped high-res render (port of compute_optimal_dpi)   */
/* ------------------------------------------------------------------ */

const DPI_PIXEL_CAP = 10_000; // px on the longer edge
const DPI_MAX = 1200;
const DPI_MIN = 500;

/**
 * Layout sheets carry small bar annotations; the ~216 DPI ingest render is
 * not enough. Re-render this page so the longer edge hits DPI_PIXEL_CAP,
 * with DPI clamped to [500, 1200]. A cheap scale-1 render measures the page
 * first (at pdfjs scale 1, 1px = 1pt = 1/72in).
 */
export async function renderPageHighRes(
  pdfPath: string,
  page: number,
  outDir: string,
): Promise<string> {
  const { pdfToPng } = await import("pdf-to-png-converter");

  const probe = await pdfToPng(pdfPath, {
    viewportScale: 1,
    pagesToProcess: [page],
  });
  const meta = await sharp(probe[0].content).metadata();
  const longerEdgePts = Math.max(meta.width ?? 1, meta.height ?? 1);

  let dpi = Math.floor((DPI_PIXEL_CAP / (longerEdgePts / 72)));
  dpi = Math.max(DPI_MIN, Math.min(DPI_MAX, dpi));

  const rendered = await pdfToPng(pdfPath, {
    viewportScale: dpi / 72,
    pagesToProcess: [page],
    outputFolder: outDir,
    outputFileMaskFunc: () => `page_${page}_layout_${dpi}dpi.png`,
  });
  return rendered[0].path;
}

/* ------------------------------------------------------------------ */
/* Per-slice LLM output (loose; normalization tightens it)             */
/* ------------------------------------------------------------------ */

const RawBeam = z.object({
  beam_id: z.string(),
  size: z
    .object({
      width: z.union([z.number(), z.string()]).nullable().optional(),
      depth: z.union([z.number(), z.string()]).nullable().optional(),
      length: z.union([z.number(), z.string()]).nullable().optional(),
    })
    .optional(),
  reinforcement: z.array(z.string()).optional(),
  stirrups: z
    .object({
      dia: z.array(z.string()).optional(),
      spacing: z.array(z.string()).optional(),
    })
    .optional(),
  nos: z
    .object({
      left: z.union([z.number(), z.string()]).nullable().optional(),
      mid_span: z.union([z.number(), z.string()]).nullable().optional(),
      right: z.union([z.number(), z.string()]).nullable().optional(),
    })
    .nullable()
    .optional(),
});
const SliceOut = z.object({ beams: z.array(RawBeam) });

/* ------------------------------------------------------------------ */
/* Step 1 — layout classification (cheap thumbnail, low detail)        */
/* ------------------------------------------------------------------ */

async function thumbnailB64(pngPath: string): Promise<string> {
  const img = sharp(pngPath);
  const { width = 0 } = await img.metadata();
  const out =
    width > CLASSIFIER_THUMB_PX
      ? await img.resize(CLASSIFIER_THUMB_PX).png().toBuffer()
      : await img.png().toBuffer();
  return out.toString("base64");
}

export async function classifyLayout(pngPath: string): Promise<LayoutKind> {
  const prompt = await fs.readFile(
    path.join(PROMPTS_DIR, "beam", "layout_classifier.txt"),
    "utf-8",
  );
  const model = new ChatOpenAI({ model: OPENAI_MODEL, temperature: 0 })
    .withStructuredOutput(
      z.object({ layout: z.enum(["stripe", "grid", "table"]) }),
      { name: "classify_layout" },
    );
  const res = await model.invoke([
    {
      role: "user",
      content: [
        imageContent(await thumbnailB64(pngPath), "low"),
        { type: "text", text: prompt },
      ],
    },
  ]);
  return res.layout;
}

/* ------------------------------------------------------------------ */
/* Step 2 — slicing                                                    */
/* ------------------------------------------------------------------ */

interface Slice {
  tag: string;     // "stripe 3" / "tile r2c4"
  b64: string;
}

/** Full-width horizontal stripes; bottom overlap = max(10px, 12% of step). */
export async function makeStripes(pngPath: string): Promise<Slice[]> {
  const img = sharp(pngPath);
  const { width: W = 0, height: H = 0 } = await img.metadata();
  const step = H / STRIPE_COUNT;
  const overlap = Math.max(STRIPE_OVERLAP, Math.floor(step * STRIPE_OVERLAP_PCT));

  const slices: Slice[] = [];
  for (let s = 0; s < STRIPE_COUNT; s++) {
    const y0 = Math.floor(s * step);
    const isLast = s === STRIPE_COUNT - 1;
    const y1 = isLast ? H : Math.min(H, Math.floor((s + 1) * step) + overlap);
    const buf = await sharp(pngPath)
      .extract({ left: 0, top: y0, width: W, height: y1 - y0 })
      .png()
      .toBuffer();
    slices.push({ tag: `stripe ${s}`, b64: buf.toString("base64") });
  }
  return slices;
}

/** rows×cols tiles, each extended `overlap` px in all four directions. */
export async function makeTiles(pngPath: string): Promise<Slice[]> {
  const img = sharp(pngPath);
  const { width: W = 0, height: H = 0 } = await img.metadata();
  const stepW = W / TILE_COLS;
  const stepH = H / TILE_ROWS;

  const slices: Slice[] = [];
  for (let r = 0; r < TILE_ROWS; r++) {
    for (let c = 0; c < TILE_COLS; c++) {
      const x0 = Math.max(0, Math.floor(c * stepW) - TILE_OVERLAP);
      const y0 = Math.max(0, Math.floor(r * stepH) - TILE_OVERLAP);
      const x1 = Math.min(W, Math.floor((c + 1) * stepW) + TILE_OVERLAP);
      const y1 = Math.min(H, Math.floor((r + 1) * stepH) + TILE_OVERLAP);
      const buf = await sharp(pngPath)
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .png()
        .toBuffer();
      slices.push({ tag: `tile r${r}c${c}`, b64: buf.toString("base64") });
    }
  }
  return slices;
}

/* ------------------------------------------------------------------ */
/* Step 3 — normalization (ports of _clean_bar etc.)                   */
/* ------------------------------------------------------------------ */

const dedupOrdered = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const toInt = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

const cleanStr = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function normalizeBeam(raw: z.infer<typeof RawBeam>, includeNos: boolean): Beam {
  const beam: Beam = {
    beam_id: raw.beam_id.trim(),
    size: {
      width: toInt(raw.size?.width),
      depth: toInt(raw.size?.depth),
      length: toInt(raw.size?.length),
    },
    reinforcement: dedupOrdered(raw.reinforcement ?? []),
    stirrups: {
      dia: dedupOrdered(raw.stirrups?.dia ?? []),
      spacing: dedupOrdered(raw.stirrups?.spacing ?? []),
    },
  };
  if (includeNos && raw.nos) {
    beam.nos = {
      left: cleanStr(raw.nos.left),
      mid_span: cleanStr(raw.nos.mid_span),
      right: cleanStr(raw.nos.right),
    };
  }
  return beam;
}

/* ------------------------------------------------------------------ */
/* Step 4 — fragment merge across slices (port of merge_beam_data)     */
/* ------------------------------------------------------------------ */

function mergeBeam(existing: Beam, next: Beam): void {
  for (const f of ["width", "length", "depth"] as const) {
    if (existing.size[f] == null && next.size[f] != null) {
      existing.size[f] = next.size[f];
    }
  }
  existing.reinforcement = dedupOrdered([
    ...existing.reinforcement,
    ...next.reinforcement,
  ]);
  existing.stirrups.dia = dedupOrdered([
    ...existing.stirrups.dia,
    ...next.stirrups.dia,
  ]);
  existing.stirrups.spacing = dedupOrdered([
    ...existing.stirrups.spacing,
    ...next.stirrups.spacing,
  ]);
  if (existing.nos && next.nos) {
    for (const slot of ["left", "mid_span", "right"] as const) {
      if (existing.nos[slot] == null && next.nos[slot] != null) {
        existing.nos[slot] = next.nos[slot];
      }
    }
  } else if (!existing.nos && next.nos) {
    existing.nos = next.nos;
  }
}

/* ------------------------------------------------------------------ */
/* Step 5 — prefix-group union with SIZE GUARD                         */
/* (B1a, B1b, B1c share one design section -> union bars/stirrups;     */
/*  if member sizes disagree, the ids were likely mis-detected: skip)  */
/* ------------------------------------------------------------------ */

const GROUP_RE = /^([A-Za-z0-9][A-Za-z0-9_\-]*\d+)([a-zA-Z]+)$/;

export function applyPrefixGroupUnion(beamMap: Map<string, Beam>): string[] {
  const groups = new Map<string, string[]>();
  for (const id of beamMap.keys()) {
    const m = GROUP_RE.exec(id);
    if (m) {
      const list = groups.get(m[1]) ?? [];
      list.push(id);
      groups.set(m[1], list);
    }
  }

  const log: string[] = [];
  for (const [prefix, ids] of groups) {
    if (ids.length < 2) continue;

    const widths = new Set(
      ids.map((i) => beamMap.get(i)!.size.width).filter((w) => w != null),
    );
    const lengths = new Set(
      ids.map((i) => beamMap.get(i)!.size.length).filter((l) => l != null),
    );
    if (widths.size > 1 || lengths.size > 1) {
      log.push(`UNION SKIPPED prefix=${prefix} — sizes differ, likely mis-detected ids`);
      continue;
    }

    const unionR = dedupOrdered(ids.flatMap((i) => beamMap.get(i)!.reinforcement));
    const unionD = dedupOrdered(ids.flatMap((i) => beamMap.get(i)!.stirrups.dia));
    const unionS = dedupOrdered(ids.flatMap((i) => beamMap.get(i)!.stirrups.spacing));
    for (const i of ids) {
      const b = beamMap.get(i)!;
      b.reinforcement = [...unionR];
      b.stirrups.dia = [...unionD];
      b.stirrups.spacing = [...unionS];
      // size and nos stay per-beam — never unioned
    }
    log.push(`UNION prefix=${prefix} members=[${ids.sort().join(",")}] bars=${unionR.length}`);
  }
  return log;
}

/* ------------------------------------------------------------------ */
/* Orchestration: extract all beams from one layout page               */
/* ------------------------------------------------------------------ */

export async function extractBeamsFromLayout(
  pngPath: string,
  page: number,
): Promise<{ beams: Beam[]; trace: TraceEvent[] }> {
  const trace: TraceEvent[] = [];
  const layout = await classifyLayout(pngPath);
  trace.push({ ts: Date.now(), element: "beam", page, tool: "classify_layout", args: {}, result: layout });

  const promptFile =
    layout === "stripe"
      ? "layout_stripe.txt"
      : layout === "grid"
        ? "layout_grid.txt"
        : "layout_table.txt";
  const prompt = await fs.readFile(
    path.join(PROMPTS_DIR, "beam", promptFile),
    "utf-8",
  );

  const slices: Slice[] =
    layout === "stripe"
      ? await makeStripes(pngPath)
      : layout === "grid"
        ? await makeTiles(pngPath)
        : [{ tag: "full page", b64: (await fs.readFile(pngPath)).toString("base64") }];

  const includeNos = layout === "grid";
  const model = new ChatOpenAI({ model: OPENAI_MODEL, temperature: 0 })
    .withStructuredOutput(SliceOut, { name: "extract_beams" });

  const limit = pLimit(MAX_WORKERS);
  const results = await Promise.all(
    slices.map((slice) =>
      limit(async () => {
        try {
          const out = await model.invoke([
            {
              role: "user",
              content: [
                imageContent(slice.b64),
                { type: "text", text: prompt },
              ],
            },
          ]);
          trace.push({
            ts: Date.now(),
            element: "beam",
            page,
            tool: `extract_${layout}`,
            args: { slice: slice.tag },
            result: { count: out.beams.length },
          });
          return out.beams;
        } catch (err) {
          trace.push({
            ts: Date.now(),
            element: "beam",
            page,
            tool: `extract_${layout}`,
            args: { slice: slice.tag },
            result: { error: String(err) },
          });
          return [];
        }
      }),
    ),
  );

  /* merge fragments: a beam cut by a stripe boundary appears in 2 slices */
  const beamMap = new Map<string, Beam>();
  for (const sliceBeams of results) {
    for (const raw of sliceBeams) {
      const beam = normalizeBeam(raw, includeNos);
      if (!beam.beam_id) continue;
      const existing = beamMap.get(beam.beam_id);
      if (existing) mergeBeam(existing, beam);
      else beamMap.set(beam.beam_id, beam);
    }
  }

  const unionLog = applyPrefixGroupUnion(beamMap);
  if (unionLog.length > 0) {
    trace.push({ ts: Date.now(), element: "beam", page, tool: "prefix_group_union", args: {}, result: unionLog });
  }

  return { beams: [...beamMap.values()], trace };
}
