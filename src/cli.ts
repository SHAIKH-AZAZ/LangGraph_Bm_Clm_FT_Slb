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

async function runOne(pdfPath: string) {
  const jobId = `${path.basename(pdfPath, ".pdf")}-${randomUUID().slice(0, 6)}`;
  console.log(`▶ ${pdfPath}`);
  const result = await pipeline.invoke(
    { pdfPath, jobId },
    { recursionLimit: 50 },
  );
  const c = result.combined;
  console.log(
    `✔ ${pdfPath} — beams:${c.beams.length} columns:${c.columns.length} slabs:${c.slabs.length} footings:${c.footings.length}, status=${result.status}`,
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
