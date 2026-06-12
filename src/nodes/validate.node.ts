import type { PipelineStateType } from "../graph/state.js";
import { ELEMENTS } from "../elements/registry.js";
import type { ValidationIssue } from "../schemas/elements.schema.js";

/**
 * Deterministic validation across ALL extracted elements.
 * Per-row rules live in the registry (each element knows its own checks),
 * so this node never changes when a new element type is added.
 */
export async function validateNode(
  state: PipelineStateType,
): Promise<Partial<PipelineStateType>> {
  const issues: ValidationIssue[] = [];
  const c = state.combined;

  // If the supervisor found schedules but a branch produced nothing, flag it.
  for (const task of state.tasks) {
    const el = ELEMENTS[task.element];
    if ((c[el.resultKey] as unknown[]).length === 0) {
      issues.push({
        element: el.kind,
        record_id: null,
        field: el.resultKey,
        issue: `Supervisor detected a ${el.kind} schedule on page ${task.page} but no rows were extracted.`,
        severity: "ERROR",
      });
    }
  }

  for (const el of Object.values(ELEMENTS)) {
    for (const record of c[el.resultKey]) {
      issues.push(...el.validate(record));
    }
  }

  const blocking = issues.some(
    (i) => i.severity === "ERROR" || i.severity === "REVIEW_REQUIRED",
  );

  return { issues, status: blocking ? "REVIEW_REQUIRED" : "OK" };
}
