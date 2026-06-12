import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineStateType } from "../graph/state.js";
import type { CombinedResult } from "../schemas/elements.schema.js";

/**
 * Back-fill global context (M25 / FE500 from general notes) into records
 * whose own schedule left mix / steel_grade empty, then write:
 *   <name>.json        — combined { beams, columns, slabs, footings }
 *   <name>_trace.json  — pattern detections, tool calls, issues, status
 */
export async function persistNode(
  state: PipelineStateType,
): Promise<Partial<PipelineStateType>> {
  const gc = state.globalContext;
  const c = state.combined;

  const finalResult: CombinedResult = {
    beams: c.beams,
    columns: c.columns.map((r) => ({
      ...r,
      mix: r.mix ?? gc?.mix ?? null,
      steel_grade: r.steel_grade ?? gc?.steel_grade ?? null,
    })),
    slabs: c.slabs.map((r) => ({ ...r, mix: r.mix || gc?.mix || "" })),
    footings: c.footings.map((r) => ({
      ...r,
      mix: r.mix ?? gc?.mix ?? null,
      steel_grade: r.steel_grade ?? gc?.steel_grade ?? null,
    })),
    global_context: gc ?? undefined,
  };

  const base = path.basename(state.pdfPath, path.extname(state.pdfPath));
  await fs.writeFile(
    path.join(state.outputDir, `${base}.json`),
    JSON.stringify(finalResult, null, 2),
  );
  await fs.writeFile(
    path.join(state.outputDir, `${base}_trace.json`),
    JSON.stringify(
      {
        tasks: state.tasks,
        notesPages: state.notesPages,
        status: state.status,
        issues: state.issues,
        trace: state.trace,
      },
      null,
      2,
    ),
  );

  return { combined: finalResult };
}
