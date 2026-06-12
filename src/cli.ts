import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { randomUUID } from "node:crypto";
import { buildPipeline } from "./graph/buildGraph.js";

/**
 * Usage:
 *   npm run cli -- ./input            # batch a folder (like auto_runner.py)
 *   npm run cli -- ./input/p1.pdf     # single file
 */
const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run cli -- <pdf-or-folder>");
  process.exit(1);
}

const pipeline = buildPipeline();
const limit = pLimit(2); // concurrent drawings

/** Colours & symbols for each known node */
const NODE_STYLE: Record<string, { icon: string; color: string }> = {
  ingest:     { icon: "📄", color: "\x1b[36m"  }, // cyan
  supervisor: { icon: "🔍", color: "\x1b[33m"  }, // yellow
  extract:    { icon: "⚙️ ", color: "\x1b[34m"  }, // blue
  context:    { icon: "📝", color: "\x1b[35m"  }, // magenta
  validate:   { icon: "✅", color: "\x1b[32m"  }, // green
  persist:    { icon: "💾", color: "\x1b[32m"  }, // green
};
const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";

function shortSummary(nodeName: string, update: unknown): string {
  const u = update as Record<string, unknown>;
  if (nodeName === "ingest") {
    const imgs = (u.imagePaths as string[] | undefined) ?? [];
    return `${imgs.length} page(s) ingested`;
  }
  if (nodeName === "supervisor") {
    const tasks = (u.tasks as unknown[] | undefined) ?? [];
    return `${tasks.length} task(s) dispatched`;
  }
  if (nodeName === "extract") {
    const combined = u.combined as Record<string, unknown[]> | undefined;
    if (combined) {
      const counts = ["beams","columns","slabs","footings"]
        .map((k) => `${k}:${(combined[k] ?? []).length}`)
        .join(" ");
      return counts;
    }
    return "branch complete";
  }
  if (nodeName === "context") {
    const gc = u.globalContext as Record<string, unknown> | undefined;
    return gc ? `mix=${gc.mix ?? "?"} steel=${gc.steel_grade ?? "?"}` : "no notes found";
  }
  if (nodeName === "validate") {
    const issues = (u.issues as unknown[] | undefined) ?? [];
    const status = (u.status as string | undefined) ?? "?";
    return `status=${status}, issues=${issues.length}`;
  }
  if (nodeName === "persist") {
    return "output files written";
  }
  return "";
}

async function runOne(pdfPath: string) {
  const jobId = `${path.basename(pdfPath, ".pdf")}-${randomUUID().slice(0, 6)}`;
  const label = `[${path.basename(pdfPath)}]`;
  console.log(`\n▶  ${label}  jobId=${jobId}`);
  console.log(`${DIM}${"─".repeat(55)}${RESET}`);

  const startMs = Date.now();
  let lastResult: Record<string, unknown> = {};

  // Stream node-by-node updates
  const stream = await pipeline.stream(
    { pdfPath, jobId },
    { recursionLimit: 50, streamMode: "updates" },
  );

  for await (const chunk of stream) {
    for (const [nodeName, update] of Object.entries(chunk)) {
      const style = NODE_STYLE[nodeName] ?? { icon: "▸", color: "\x1b[37m" };
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const summary = shortSummary(nodeName, update);
      console.log(
        `  ${style.icon}  ${style.color}${nodeName.padEnd(12)}${RESET}` +
        `${summary ? `  ${DIM}${summary}${RESET}` : ""}` +
        `  ${DIM}+${elapsed}s${RESET}`,
      );
      lastResult = { ...lastResult, ...(update as object) };
    }
  }

  console.log(`${DIM}${"─".repeat(55)}${RESET}`);
  const c = (lastResult.combined ?? { beams:[], columns:[], slabs:[], footings:[] }) as {
    beams: unknown[]; columns: unknown[]; slabs: unknown[]; footings: unknown[];
  };
  const totalMs = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `✔  ${label}  beams:${c.beams.length} columns:${c.columns.length}` +
    ` slabs:${c.slabs.length} footings:${c.footings.length}` +
    `  status=${lastResult.status ?? "?"}  ${DIM}(${totalMs}s total)${RESET}\n`,
  );
}

const stat = await fs.stat(target);
if (stat.isDirectory()) {
  const pdfs = (await fs.readdir(target))
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(target, f));
  await Promise.all(pdfs.map((p) => limit(() => runOne(p))));
} else {
  await runOne(target);
}
