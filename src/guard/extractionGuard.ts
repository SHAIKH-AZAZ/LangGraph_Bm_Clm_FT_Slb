import { randomUUID } from "node:crypto";
import type { AnyRecord, TraceEvent } from "../schemas/elements.schema.js";

/**
 * Generalized port of the four extraction_guard.py files (beam/column/slab/
 * footing all enforce the same machine). Runtime enforcement of:
 *
 *   think  →  zoom_region*  →  confirm_read*  →  add_record*
 *
 *  - `think` first, exactly once
 *  - confirm_read only for region_ids created by zoom_region
 *  - add_record only with confirmed source_region_ids; duplicate ids rejected
 */
export class ExtractionGuard {
  private thought = false;
  private regions = new Map<string, { bbox: number[]; reason: string }>();
  private confirmed = new Map<string, string>();
  private records = new Map<string, AnyRecord>();
  readonly trace: TraceEvent[] = [];

  constructor(
    private readonly idField: string,
    private readonly meta: { element: string; page: number },
  ) {}

  log(tool: string, args: unknown, result: unknown) {
    this.trace.push({ ts: Date.now(), ...this.meta, tool, args, result });
  }

  registerThink(): string | null {
    if (this.thought) return "think was already called. Continue with zoom_region.";
    this.thought = true;
    return null;
  }

  requireThink(tool: string): string | null {
    return this.thought ? null : `Rejected: call "think" before "${tool}".`;
  }

  registerRegion(bbox: number[], reason: string): string {
    const id = `R${this.regions.size + 1}_${randomUUID().slice(0, 6)}`;
    this.regions.set(id, { bbox, reason });
    return id;
  }

  confirmRegion(regionId: string, exactText: string): string | null {
    if (!this.regions.has(regionId)) {
      return `Rejected: unknown region_id "${regionId}". Call zoom_region first.`;
    }
    this.confirmed.set(regionId, exactText);
    return null;
  }

  addRecord(record: AnyRecord): string | null {
    const id = (record as Record<string, unknown>)[this.idField];
    if (typeof id !== "string" || !id.trim()) {
      return `Rejected: "${this.idField}" is required and must be a non-empty string.`;
    }
    const unsupported = (record.source_region_ids ?? []).filter(
      (r) => !this.confirmed.has(r),
    );
    if (unsupported.length > 0) {
      return `Rejected: region_ids [${unsupported.join(", ")}] have no confirm_read.`;
    }
    if (this.records.has(id)) {
      return `Rejected: ${this.idField} "${id}" already added. Do not duplicate rows.`;
    }
    this.records.set(id, record);
    return null;
  }

  get count() {
    return this.records.size;
  }

  result(): AnyRecord[] {
    return [...this.records.values()];
  }
}
