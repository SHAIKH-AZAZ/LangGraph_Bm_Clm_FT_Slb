import fs from "node:fs/promises";
import path from "node:path";
import { pdfToPng } from "pdf-to-png-converter";
import { PDF_RENDER_SCALE, PROCESSED_DIR } from "../config.js";
import type { PipelineStateType } from "../graph/state.js";

/** Convert the uploaded PDF into one PNG per page at ~216 DPI. */
export async function ingestNode(
  state: PipelineStateType,
): Promise<Partial<PipelineStateType>> {
  const outDir = path.join(PROCESSED_DIR, state.jobId);
  await fs.mkdir(outDir, { recursive: true });

  const pages = await pdfToPng(state.pdfPath, {
    viewportScale: PDF_RENDER_SCALE,
    outputFolder: outDir,
    outputFileMaskFunc: (n) => `page_${n}.png`,
  });

  if (pages.length === 0) {
    throw new Error("No image generated from PDF.");
  }

  return {
    imagePaths: pages.map((p) => p.path),
    outputDir: outDir,
  };
}
