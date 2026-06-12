import { z } from "zod";
import {
  BeamSchema,
  ColumnSchema,
  FootingSchema,
  SlabSchema,
  type AnyRecord,
  type ElementKindT,
  type ValidationIssue,
} from "../schemas/elements.schema.js";

/**
 * THE central abstraction.
 *
 * In the Python repos, beam/column/slab/footing are four copied codebases
 * (4 pattern_detectors, 4 vision_extractors, 48 main_N.py). Here, an element
 * is *data*: the generic graph nodes read this config. Adding a fifth element
 * type (e.g. STAIRCASE) = one registry entry + a prompts folder.
 */
export interface ElementConfig {
  kind: ElementKindT;
  resultKey: "beams" | "columns" | "slabs" | "footings";
  idField: string;                    // dedupe key inside the guard
  recordSchema: z.ZodTypeAny;         // add_<element> tool schema
  patternCount: number;               // prompt_1..N available
  classifierHints: string;            // header cues for pattern detection
  validate: (r: AnyRecord) => ValidationIssue[]; // deterministic per-row checks
}

const issue = (
  element: ElementKindT,
  record_id: string | null,
  field: string,
  msg: string,
  severity: ValidationIssue["severity"] = "REVIEW_REQUIRED",
): ValidationIssue => ({ element, record_id, field, issue: msg, severity });

export const ELEMENTS: Record<ElementKindT, ElementConfig> = {
  beam: {
    kind: "beam",
    resultKey: "beams",
    idField: "beam_id",
    recordSchema: BeamSchema,
    patternCount: 14,
    classifierHints:
      "Headers like BEAM NUMBERS / BEAM NO. / BEAM MARK; SIZE as B x D or WIDTH/DEPTH; BOTTOM and TOP REINFORCEMENT with LEFT / MID SPAN / RIGHT; STIRRUPS column.",
    validate: (r) => {
      const b = r as z.infer<typeof BeamSchema>;
      const out: ValidationIssue[] = [];
      if (b.size.width == null || b.size.depth == null)
        out.push(issue("beam", b.beam_id, "size", "Missing width/depth"));
      if (b.reinforcement.length === 0)
        out.push(issue("beam", b.beam_id, "reinforcement", "No reinforcement"));
      if (b.stirrups.dia.length === 0)
        out.push(issue("beam", b.beam_id, "stirrups.dia", "No stirrup dia"));
      return out;
    },
  },

  column: {
    kind: "column",
    resultKey: "columns",
    idField: "column_no",
    recordSchema: ColumnSchema,
    patternCount: 15,
    classifierHints:
      "Headers like COLUMN NOS. / COLUMN MARK; level/floor labels on the side; SIZE; REINF.; STIRRUPS / TIES; sometimes a transposed grid of columns per storey.",
    validate: (r) => {
      const c = r as z.infer<typeof ColumnSchema>;
      const out: ValidationIssue[] = [];
      if (c.size.width == null || c.size.depth == null)
        out.push(issue("column", c.column_no, "size", "Missing width/depth"));
      if (c.reinforcement.length === 0)
        out.push(issue("column", c.column_no, "reinforcement", "No reinforcement"));
      return out;
    },
  },

  slab: {
    kind: "slab",
    resultKey: "slabs",
    idField: "slab_id",
    recordSchema: SlabSchema,
    patternCount: 9,
    classifierHints:
      "Headers like SLAB / TYPE with THICKNESS; STEEL ALONG SPAN / ACROSS SPAN, SHORT SPAN / LONG SPAN, or MAIN REINF. / DISTRIBUTION REINF.",
    validate: (r) => {
      const s = r as z.infer<typeof SlabSchema>;
      const out: ValidationIssue[] = [];
      if (s.remarks?.toUpperCase() === "DELETED") return out;
      if (s.thickness == null)
        out.push(issue("slab", s.slab_id, "thickness", "Missing thickness"));
      if (s.reinforcement.dia.length === 0)
        out.push(issue("slab", s.slab_id, "reinforcement.dia", "No bar diameters"));
      if (s.reinforcement.spacing.length === 0)
        out.push(issue("slab", s.slab_id, "reinforcement.spacing", "No spacing"));
      return out;
    },
  },

  footing: {
    kind: "footing",
    resultKey: "footings",
    idField: "footing_id",
    recordSchema: FootingSchema,
    patternCount: 10,
    classifierHints:
      "Headers like FOOTING / FOOTING MARK with COLUMN reference; SIZE L x B x D; SHORT SPAN and LONG SPAN reinforcement; NOS.; MIX.",
    validate: (r) => {
      const f = r as z.infer<typeof FootingSchema>;
      const out: ValidationIssue[] = [];
      if (f.size.width == null || f.size.length == null)
        out.push(issue("footing", f.footing_id, "size", "Missing plan dimensions"));
      if (!f.reinforcement.short_span.dia && !f.reinforcement.long_span.dia)
        out.push(issue("footing", f.footing_id, "reinforcement", "No span reinforcement"));
      return out;
    },
  },
};

export function getElement(kind: ElementKindT): ElementConfig {
  return ELEMENTS[kind];
}
