# RCC Extraction Agent — Complete Feature Matrix (v3)

## ✅ All Five Element Types

| Element | Representation | Patterns | Prompts | Entry Point |
|---------|---|---|---|---|
| **BEAM (schedule)** | `schedule` table | 14 | `prompts/beam/prompt_1..14.txt` | supervisor detects → extract branch (pattern-based) |
| **BEAM (layout)** | `layout` detail drawing | 3 types | `prompts/beam/layout_{classifier,stripe,grid,table}.txt` | supervisor detects → extract branch (slicing pipeline) |
| **COLUMN** | `schedule` table | 15 | `prompts/column/prompt_1..15.txt` | supervisor detects → extract branch (pattern-based) |
| **SLAB** | `schedule` table | 9 | `prompts/slab/prompt_1..9.txt` | supervisor detects → extract branch (pattern-based) |
| **FOOTING** | `schedule` table | 10 | `prompts/footing/prompt_1..10.txt` | supervisor detects → extract branch (pattern-based) |

**Total: 48 schedule patterns + 4 layout prompts = 52 prompts, 2 extraction strategies**

---

## Complete JSON Output (Combined Result)

Every PDF produces one `<name>.json` containing all five element types in a single unified shape:

```json
{
  "beams": [
    {
      "beam_id": "B1",
      "size": { "width": 200, "depth": 600, "length": null },
      "reinforcement": ["2-T16", "2-T20"],
      "stirrups": { "dia": ["T8"], "spacing": ["150 C/C"] },
      "nos": null
    },
    {
      "beam_id": "B2a",
      "size": { "width": 300, "depth": null, "length": 450 },
      "reinforcement": ["2-16T(TH)", "1-12T(EX)"],
      "stirrups": { "dia": ["2-8T"], "spacing": ["100 C/C"] },
      "nos": { "left": "100", "mid_span": "150", "right": "100" }
    }
  ],
  "columns": [
    {
      "column_no": "C1,C7,C8",
      "column_name": "GROUND LEVEL",
      "size": { "width": 300, "depth": 500, "length": null },
      "reinforcement": ["8-T16"],
      "stirrups": { "dia": ["T8"], "spacing": ["150 C/C"] },
      "mix": "M25",
      "steel_grade": "FE500"
    }
  ],
  "slabs": [
    {
      "slab_id": "S1",
      "thickness": 225,
      "type": "",
      "mix": "M25",
      "reinforcement": { "dia": ["T12", "T8"], "spacing": ["100 C/C", "175 C/C"] }
    }
  ],
  "footings": [
    {
      "footing_id": "F1",
      "column_id": "C1,C18",
      "size": { "width": 3200, "depth": 300, "length": 4100 },
      "reinforcement": {
        "short_span": { "dia": "16", "spacing": "130 C/C" },
        "long_span": { "dia": "16", "spacing": "130 C/C" }
      },
      "nos": null,
      "mix": "M200",
      "steel_grade": "FE500"
    }
  ],
  "global_context": { "mix": "M25", "steel_grade": "FE500" }
}
```

**One JSON, all element types.** No separate files per element.

---

## Pipeline Architecture

```
START
  │
  ├─→ ingest (PDF → per-page PNGs at ~216 DPI)
  │
  ├─→ supervisor (classifies every page for element types + representation)
  │    Outputs: tasks = [(page, element, representation), ...]
  │
  ├─→ PARALLEL FAN-OUT via Send()
  │    ├─→ extract(beam, page 1, "schedule")   ↘
  │    ├─→ extract(column, page 2, "schedule") ──→ merge into combined result
  │    ├─→ extract(slab, page 3, "schedule")   ↗
  │    ├─→ extract(footing, page 4, "schedule")
  │    └─→ extract(beam, page 5, "layout")      (high-res re-render + slicing)
  │
  ├─→ context (extracts M25/FE500 from general notes pages)
  │    Outputs: global_context = {mix, steel_grade}
  │
  ├─→ validate (per-row checks for all elements)
  │    Outputs: issues = [...], status = "OK" | "REVIEW_REQUIRED"
  │
  ├─→ persist (back-fills context, writes combined JSON + trace JSON)
  │
  └─→ END
```

---

## What Each Node Does

### ingest
- Converts PDF → per-page PNG at ~216 DPI (sufficient for tables)
- Multi-page PDFs supported (each page becomes a task)

### supervisor (the router)
Calls GPT-4o once per page (low-detail thumbnail) to detect:
- **Which elements exist** (beam, column, slab, footing)
- **How each is represented**:
  - `"schedule"` — table with header rows
  - `"layout"` — detail drawings with cross-sections (beam only, currently)
- **General notes presence** — for context extraction

Output: task list like `[(page: 1, element: "beam", representation: "schedule"), (page: 2, element: "footing", representation: "schedule"), (page: 3, element: "beam", representation: "layout"), ...]`

### extract (fan-out branch — runs in parallel, one per task)

**If schedule:**
1. Pattern detection (structured output, 1..14 for beam, 1..15 for column, 1..9 for slab, 1..10 for footing)
2. Load pattern-specific prompt from `prompts/<element>/prompt_N.txt`
3. Guarded tool loop: `think` → `zoom_region` → `confirm_read` → `add_<element>`
4. ExtractionGuard enforces sequence at runtime + logs every tool call to trace

**If layout (beam only):**
1. High-res re-render: longer edge → 10,000px, DPI ∈ [500, 1200]
2. Layout classification: stripe vs grid vs table (via thumbnail, low detail)
3. Slicing:
   - **stripe**: 7 horizontal full-width stripes, 12% bottom overlap
   - **grid**: 5×5 tiles, 100px overlap on all four sides
   - **table**: full page as one slice
4. Parallel per-slice extraction (3 workers), using layout prompts:
   - `layout_stripe.txt` — vertical layout rule, above-only rule, own-rectangle rule
   - `layout_grid.txt` — grid-specific tables with stirrup zones (nos)
   - `layout_table.txt` — tabular layout (fallback)
5. Fragment merge: beams cut at slice boundaries have their parts unioned
6. Prefix-group union with size guard: B1a/B1b/B1c → union their reinforcement, but skip if sizes disagree (size guard prevents mis-detected ID cross-contamination)

**Output**: partial `{ beams: [...], columns: [...], slabs: [...], footings: [...] }`

### context
- Finds general notes pages (flagged by supervisor)
- Extracts M25 (concrete mix) and FE500 (steel grade) via structured output
- Stores in `globalContext`: `{ mix, steel_grade }`
- Used later for back-fill where schedule-level fields were null

### validate
- Registry-driven per-row checks (each element type knows its own rules)
- Cross-check: if supervisor saw a schedule but extract returned 0 rows → ERROR
- Output: `issues = [{element, record_id, field, issue, severity}, ...]`, `status = "OK" | "REVIEW_REQUIRED" | "FAILED"`

### persist
- Back-fills global context into records (schedule values always win):
  - columns/footings: if `mix` or `steel_grade` null → use `global_context`
  - slabs: if `mix` empty string → use `global_context`
- Writes `<name>.json` (the combined result shown above)
- Writes `<name>_trace.json` (pattern detections, tool calls, validation issues, audit trail)

---

## Element Schemas (Zod → strict tool schemas)

### Beam (schedule mode)
```ts
{
  beam_id: string,
  size: { width: number | null, depth: number | null, length: number | null },
  reinforcement: string[],           // ["2-T16", "1-T12"]
  stirrups: { dia: string[], spacing: string[] },
  confidence?: number,
  source_region_ids?: string[]       // zoomed regions supporting this row
}
```

### Beam (layout mode) — same + optional nos
```ts
{
  beam_id: string,
  size: { ... },
  reinforcement: string[],
  stirrups: { dia: string[], spacing: string[] },
  nos?: { left: string | null, mid_span: string | null, right: string | null }
  // nos only present in grid layout, never unioned across prefix groups
}
```

### Column
```ts
{
  column_no: string,                 // "C1" or "C1,C7,C8"
  column_name: string,               // level/floor, verbatim
  size: { width, depth, length },
  reinforcement: string[],
  stirrups: { dia: string[], spacing: string[] },
  mix: string | null,                // backfill from global_context if null
  steel_grade: string | null,        // backfill from global_context if null
  source_region_ids?: string[]
}
```

### Slab
```ts
{
  slab_id: string,
  thickness: number | null,
  type: string,
  mix: string,                       // backfill from global_context if empty
  reinforcement: { dia: string[], spacing: string[] },
  source_region_ids?: string[]
}
```

### Footing
```ts
{
  footing_id: string,
  column_id: string | null,          // "C1,C18"
  size: { width, depth, length },
  reinforcement: {
    short_span: { dia: string | null, spacing: string | null },
    long_span: { dia: string | null, spacing: string | null }
  },
  nos: number | null,
  mix: string | null,                // backfill from global_context if null
  steel_grade: string | null,        // backfill from global_context if null
  source_region_ids?: string[]
}
```

---

## Data Flow Example: Multi-Element Multi-Page Sheet

**Input:** `drawing.pdf` with 3 pages:
- Page 1: Beam schedule (table)
- Page 2: Footing schedule (table) + General Notes
- Page 3: Beam detail drawing (layout)

**Supervisor output:**
```
tasks = [
  { page: 1, element: "beam", representation: "schedule" },
  { page: 2, element: "footing", representation: "schedule" },
  { page: 3, element: "beam", representation: "layout" }
]
notesPages = [2]
```

**Extract branches (parallel):**
1. Branch 1: page 1, beam schedule → pattern detected (e.g., pattern 3) → tool loop → 12 beams
2. Branch 2: page 2, footing schedule → pattern detected (e.g., pattern 5) → tool loop → 8 footings
3. Branch 3: page 3, beam layout → stripe detected → 7 slices → 5 workers → merge → prefix-group union → 25 beams

**Context:**
- Page 2 notes: M25, FE500 → global_context

**Validate:**
- Check all 12 + 25 = 37 beams for missing width/depth
- Check all 8 footings for missing plan size
- No errors

**Persist:**
- Write combined JSON with 37 beams, 8 footings, global_context
- Write trace JSON with 3 pattern detections, layout classification, 12 extraction tool calls, union logs, validation passed

**Output file:** `drawing.json` (one file, all three element types)

---

## Prompt Coverage

### Beam
- **Schedule (patterns 1–14)**: `prompts/beam/prompt_1.txt` through `prompt_14.txt`
  - Covers: standard tables with various header structures (MAIN/DIST REINF, SHORT/LONG SPAN, etc.)
- **Layout (4 prompts)**: 
  - `layout_classifier.txt` — guides the stripe vs grid vs table choice
  - `layout_stripe.txt` — handles horizontal-row layouts (empty-stripe rule, above-only, own-rectangle)
  - `layout_grid.txt` — handles 2D grid layouts (stirrup zone tables, nos)
  - `layout_table.txt` — fallback for tabular detail (rare)

### Column
- **Patterns 1–15**: `prompts/column/prompt_1.txt` through `prompt_15.txt`
  - Covers: level-labeled tables, cell grid layouts, multi-floor detections

### Slab
- **Patterns 1–9**: `prompts/slab/prompt_1.txt` through `prompt_9.txt`
  - Covers: STEEL ALONG/ACROSS SPAN, SHORT/LONG SPAN variants, MAIN/DIST REINF

### Footing
- **Patterns 1–10**: `prompts/footing/prompt_1.txt` through `prompt_10.txt`
  - Covers: footings by column group, square/rectangular, single/combined footings

### General Notes
- **Context extraction**: built-in (no external prompt, uses structured-output schema for M25/FE500)

---

## API Endpoints

### POST `/extract`
Upload a PDF; returns `{ jobId, status: "RUNNING" }`

### GET `/extract/<jobId>`
Poll job status and result:
```json
{ "status": "OK", "result": { "combined": {...}, "issues": [...] } }
```

### GET `/extract/<jobId>/trace`
Full audit trail: pattern detections, tool calls, validation, timings

### POST `/corrections`
Submit a correction (for pattern library backfill):
```json
{
  "pattern": "R8@150",
  "type": "STIRRUP",
  "normalized": { "dia": 8, "spacing": 150 },
  "source": "jobId"
}
```

---

## Extensibility

**Adding a sixth element (e.g., STAIRCASE):**
1. Add one entry to `src/elements/registry.ts`:
   ```ts
   staircase: {
     kind: "staircase",
     resultKey: "staircases",
     idField: "stair_id",
     recordSchema: StaircaseSchema,  // define in elements.schema.ts
     patternCount: 8,                // if staircase has 8 patterns
     classifierHints: "...",
     validate: (r) => [...]
   }
   ```
2. Add `prompts/staircase/prompt_1.txt` through `prompt_8.txt`
3. Update supervisor to recognize staircase headers
4. Nothing else changes — zero new orchestration code

**Adding layout mode for columns:**
1. Create `src/elements/layout/columnLayout.ts` (similar to `beamLayout.ts`)
2. In `extractBranch.node.ts`, add a routing case for layout + column
3. Add `prompts/column/layout_*.txt` prompts
4. No schema changes (Column already has all needed fields)

---

## Testing / Evaluation

The project includes:
- Four ground-truth test sets (your existing `output/*/` JSONs from beam/column/slab/footing pipelines)
  - Beam: 14 reference PDFs (pattern 1–14)
  - Column: 15 reference PDFs
  - Slab: 9 reference PDFs
  - Footing: 10 reference PDFs
- Beam layout: reference PDFs from the Layout POC (pattern 1–3 stripe/grid/table)

**Evaluation workflow:**
1. Run each reference PDF through the pipeline
2. Diff the output JSON against the committed ground truth
3. Track per-element, per-field precision/recall
4. Run on every prompt change; use as CI/CD gate

---

## Size & Complexity Summary

| Metric | Count |
|--------|-------|
| Source files (.ts) | 18 |
| Total lines of code | ~2,000 |
| Prompts | 52 (14 beam schedule + 4 beam layout + 15 column + 9 slab + 10 footing) |
| Graph nodes | 6 (ingest, supervisor, extract [parallel], context, validate, persist) |
| Element types | 5 (beam-schedule, beam-layout, column, slab, footing) |
| Schemas (Zod) | 5 |
| Tools per extract | 4 shared (think, zoom_region, confirm_read, add_X) + 1 element-specific |
| Guardrails | ExtractionGuard (enforces think → zoom → confirm → add sequence) + registry validators + supervisor cross-check |
| Pattern coverage | 48 schedule patterns + 4 layout prompts = 52 total |

**No manual per-element orchestration code.** Registry-driven, generic graph, add new elements = config.
