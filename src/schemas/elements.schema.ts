import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

export const SizeSchema = z.object({
  width: z.number().nullable(),
  depth: z.number().nullable(),
  length: z.number().nullable(),
});

export const StirrupsSchema = z.object({
  dia: z.array(z.string()).optional().nullable().default([]), // ["T8"]
  spacing: z.array(z.string()).optional().nullable().default([]), // ["150 C/C"]
});

const Provenance = {
  remarks: z.string().optional().nullable(), // e.g. "DELETED"
  source_region_ids: z.array(z.string()).optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
};

/* ------------------------------------------------------------------ */
/* BEAM  (beam/src/beam_schema.py — strict schema)                     */
/* ------------------------------------------------------------------ */

export const NosSchema = z.object({
  left: z.string().nullable(),
  mid_span: z.string().nullable(),
  right: z.string().nullable(),
});

export const BeamSchema = z.object({
  beam_id: z.string(), // grouped IDs kept as written
  size: SizeSchema, // "200 x 600" -> w200 d600 l:null
  reinforcement: z.array(z.string()).optional().nullable().default([]), // normalized "2-T16"
  stirrups: StirrupsSchema,
  nos: NosSchema.nullable().optional(), // grid-layout stirrup zones only
  ...Provenance,
});

/* ------------------------------------------------------------------ */
/* COLUMN  (column/src/prompt_*.txt)                                   */
/* ------------------------------------------------------------------ */

export const ColumnSchema = z.object({
  column_no: z.string(), // "C1" or "C1,C7,C8"
  column_name: z.string().optional().nullable().default(""), // level/floor label, verbatim
  size: SizeSchema,
  reinforcement: z.array(z.string()).optional().nullable().default([]),
  stirrups: StirrupsSchema,
  mix: z.string().nullable().default(null),
  steel_grade: z.string().nullable().default(null),
  ...Provenance,
});

/* ------------------------------------------------------------------ */
/* SLAB  (slab/src/prompt_*.txt — unchanged from v1)                   */
/* ------------------------------------------------------------------ */

export const SlabSchema = z.object({
  slab_id: z.string(),
  thickness: z.number().nullable(),
  type: z.string().optional().nullable().default(""),
  mix: z.string().optional().nullable().default(""),
  reinforcement: z.object({
    dia: z.array(z.string()).optional().nullable().default([]),
    spacing: z.array(z.string()).optional().nullable().default([]),
  }),
  ...Provenance,
});

/* ------------------------------------------------------------------ */
/* FOOTING  (footing/src/prompt_*.txt)                                 */
/* ------------------------------------------------------------------ */

const SpanReinf = z.object({
  dia: z.string().nullable(), // "16"
  spacing: z.string().nullable(), // "130 C/C"
});

export const FootingSchema = z.object({
  footing_id: z.string(), // "F1"
  column_id: z.string().nullable().default(null), // "C1,C18"
  size: SizeSchema,
  reinforcement: z.object({
    short_span: SpanReinf,
    long_span: SpanReinf,
  }),
  nos: z.number().nullable().default(null),
  mix: z.string().nullable().default(null),
  steel_grade: z.string().nullable().default(null),
  ...Provenance,
});

/* ------------------------------------------------------------------ */
/* Combined output: one JSON per drawing, all elements                 */
/* ------------------------------------------------------------------ */

export const CombinedResultSchema = z.object({
  beams: z.array(BeamSchema).default([]),
  columns: z.array(ColumnSchema).default([]),
  slabs: z.array(SlabSchema).default([]),
  footings: z.array(FootingSchema).default([]),
  global_context: z
    .object({
      mix: z.string().nullable(), // M25 from general notes
      steel_grade: z.string().nullable(), // FE500 from general notes
    })
    .partial()
    .optional(),
});

export type Beam = z.infer<typeof BeamSchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type Slab = z.infer<typeof SlabSchema>;
export type Footing = z.infer<typeof FootingSchema>;
export type CombinedResult = z.infer<typeof CombinedResultSchema>;
export type AnyRecord = Beam | Column | Slab | Footing;

/* ------------------------------------------------------------------ */
/* Page-level element detection (supervisor output)                    */
/* ------------------------------------------------------------------ */

export const ElementKind = z.enum(["beam", "column", "slab", "footing"]);
export type ElementKindT = z.infer<typeof ElementKind>;

/**
 * How the element is drawn on the sheet:
 *  - schedule: a table with header rows (pattern 1..N pipelines)
 *  - layout:   detail drawings — cross-section rectangles with bar
 *              annotations, stirrup tables, and labels (beam only, currently)
 */
export const Representation = z.enum(["schedule", "layout"]);
export type RepresentationT = z.infer<typeof Representation>;

export const PageClassificationSchema = z.object({
  pages: z.array(
    z.object({
      page: z.number().int().min(1),
      elements: z.array(
        z.object({
          kind: ElementKind,
          representation: Representation,
        }),
      ),
      has_general_notes: z.boolean(),
    }),
  ),
});

/* ------------------------------------------------------------------ */
/* Tool args shared by every element extractor                         */
/* ------------------------------------------------------------------ */

export const ThinkArgs = z.object({
  table_structure: z.string(),
  visible_ids: z.array(z.string()),
  regions_needing_zoom: z.array(z.string()),
  plan: z.string(),
});

export const ZoomRegionArgs = z.object({
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1),
  y2: z.number().min(0).max(1),
  reason: z.string(),
});

export const ConfirmReadArgs = z.object({
  region_id: z.string(),
  exact_text: z.string(),
});

/* ------------------------------------------------------------------ */
/* Trace / validation                                                  */
/* ------------------------------------------------------------------ */

export const TraceEventSchema = z.object({
  ts: z.number(),
  element: z.string().optional().nullable(),
  page: z.number().optional().nullable(),
  tool: z.string(),
  args: z.unknown(),
  result: z.unknown(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const ValidationIssueSchema = z.object({
  element: ElementKind.nullable(),
  record_id: z.string().nullable(),
  field: z.string(),
  issue: z.string(),
  severity: z.enum(["WARNING", "REVIEW_REQUIRED", "ERROR"]),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
