# RCC Drawing Extraction — Multi-Element LangGraph.js Plan

## What changed from v1 (slab-only)

The cowork repo revealed the real scope: four parallel Python pipelines —
beam (14 patterns), column (15), slab (9), footing (10) — each a near-copy of
the others: 4 pattern_detectors, 4 vision_extractors, 4 extraction_guards,
48 main_N.py files. The differences between them are **data, not logic**:
the JSON schema, the id field, the pattern count, and the prompts.

So the architecture makes elements *configuration*:

```
src/elements/registry.ts     ← ONE entry per element: schema, idField,
                               patternCount, classifier hints, row validators
prompts/{beam,column,slab,footing}/prompt_N.txt   ← all 48, unchanged
```

Every node is generic and reads the registry. Adding STAIRCASE or LINTEL
later = one registry entry + a prompts folder. Zero new orchestration code.

## The graph

```
START → ingest → supervisor ──┬─→ extract(beam,   page 2) ──┐
                              ├─→ extract(column, page 3) ──┤
                              ├─→ extract(slab,   page 1) ──┼→ context → validate → persist → END
                              └─→ extract(footing,page 4) ──┘
                                   (parallel via Send())
```

1. **supervisor** — looks at every page (low-detail, header structure only)
   and emits a task list of (page, element) pairs. A single sheet can carry
   beam + column schedules; a task is created for each.
2. **extract** (fan-out branch, runs in parallel per task) —
   a. detects the element-specific pattern (1..14 for beam, 1..15 for column…)
   b. runs the guarded tool loop: think → zoom_region → confirm_read →
      add_beam / add_column / add_slab / add_footing.
   The add tool's schema comes from the registry, so the model is forced
   into the exact JSON shape for that element (strict Zod → tool schema).
3. **context** — reads GENERAL NOTES pages for M25 / FE500 and stores them
   as globalContext.
4. **validate** — registry-driven per-row checks across all elements, plus a
   cross-check: if the supervisor saw a schedule but a branch returned zero
   rows, that's an ERROR.
5. **persist** — back-fills mix/steel_grade from notes into records whose own
   schedule left them blank (schedule values always win), writes one combined
   JSON + one trace JSON.

## Combined output shape

```json
{
  "beams":    [{ "beam_id": "B1", "size": {"width":200,"depth":600,"length":null},
                 "reinforcement": ["2-T16","2-T20"], "stirrups": {"dia":["T8"],"spacing":["150 C/C"]} }],
  "columns":  [{ "column_no": "C1,C7", "column_name": "GROUND LEVEL", "size": {...},
                 "reinforcement": ["8-T16"], "stirrups": {...}, "mix": "M25", "steel_grade": "FE500" }],
  "slabs":    [{ "slab_id": "S1", "thickness": 225, "type": "", "mix": "M25",
                 "reinforcement": {"dia":["T12","T8"],"spacing":["100 C/C","175 C/C"]} }],
  "footings": [{ "footing_id": "F1", "column_id": "C1,C18", "size": {"width":3200,"depth":300,"length":4100},
                 "reinforcement": {"short_span":{"dia":"16","spacing":"130 C/C"},
                                   "long_span":{"dia":"16","spacing":"130 C/C"}},
                 "nos": null, "mix": "M200", "steel_grade": null }],
  "global_context": { "mix": "M25", "steel_grade": "FE500" }
}
```

These shapes are taken verbatim from beam_schema.py and the prompt files of
each pipeline — your existing per-element output JSONs remain valid subsets.


## Beam LAYOUT mode (v3 — from the Layout POC)

Beams appear two ways on real sheets, and they need different machinery:

| | schedule (table) | layout (detail drawings) |
|---|---|---|
| What's on the page | header + data rows | cross-section rectangles, bars drawn inside, stirrup tables, labels below |
| Extraction strategy | guarded tool loop (think → zoom → confirm → add_beam) | DPI-capped re-render → stripe/grid slicing → parallel per-slice extraction → merge |
| Prompts | prompt_1..14.txt | layout_stripe / layout_grid / layout_table (+ layout_classifier) |
| Patterns | 14 header patterns | stripe (horizontal rows), grid (2D matrix), table fallback |

The supervisor now reports `representation: "schedule" | "layout"` per element
per page, and the extract branch routes accordingly. Pipeline for layout
(faithful port of layout_extractor.py):

1. **High-res re-render** — layout annotations are tiny; the page is
   re-rendered so the longer edge hits 10,000px (DPI clamped 500–1200),
   instead of the ~216 DPI ingest render that suffices for tables.
2. **Layout classification** — cheap 1500px thumbnail, low detail:
   stripe vs grid vs table.
3. **Slicing** — stripe: 7 full-width horizontal stripes, bottom overlap
   max(10px, 12% of stripe height) so labels at boundaries are never lost;
   grid: 5×5 tiles with 100px overlap on all sides.
4. **Parallel slice extraction** — structured output per slice (3 workers),
   with the POC's battle-tested prompts (empty-stripe rule, above-only rule,
   own-rectangle rule, full beam-id prefix taxonomy).
5. **Fragment merge** — a beam cut by a slice boundary appears in two
   slices; null sizes are filled, bars/stirrups deduped order-preserving.
6. **Prefix-group union with size guard** — B1a/B1b/B1c share one design
   section, so their bars/stirrups are unioned; but if member sizes
   disagree, the ids were likely mis-read and the union is skipped to
   prevent cross-contamination. (Unit-tested.)
7. **nos zones** — grid layouts carry per-beam stirrup zone tables
   {left, mid_span, right}; included only in grid mode, never unioned.

Both modes emit the same BeamSchema, so downstream (context backfill,
validation, combined JSON) is unchanged — layout beams simply have
size.depth or size.length null where the drawing doesn't state it.

## OpenAI Agents SDK → LangGraph mapping

| Agents SDK | LangGraph.js | Here |
|---|---|---|
| Agent | node | supervisor, extract branch, context |
| Handoff | edge / Send() | supervisor fan-out to element branches |
| Guardrail | runtime guard + validate node | ExtractionGuard, registry validators |
| Run state | Annotation.Root | combined-result merging reducer |
| Tracing | trace channel + LangSmith | per-tool audit in _trace.json |

## Element-specific tooling (column's cell grid)

Your column pipeline has extras (cell_cropper, pattern15_pdf_grid, cell
verifiers). The tool factory takes the element config — Phase 2 adds an
optional `extraTools(guard, imagePath)` hook on ElementConfig so column
pattern 15 can expose a `read_grid_cell` tool without touching other
elements. Same for pattern-specific batching.

## Build order

1. **Parity per element** — run each element's reference PDFs through the
   generic pipeline; diff against the Python pipelines' committed output
   JSONs (you already have ground truth for all four).
2. **Multi-schedule sheets** — test PDFs where one page holds two schedules,
   and multi-page sets; verify fan-out and the combined merge.
3. **Validation loop** — re-add the retry edge (validate → extract for only
   the failing tasks, with issues injected into the prompt).
4. **Pattern library** — per-element Qdrant collections (beam notation differs
   from footing notation); corrections endpoint already in the API.
5. **Hardening** — BullMQ queue, Prisma/Postgres for jobs + records,
   LangGraph checkpointer for crash resume, LangSmith tracing.

## Cost notes

- Supervisor uses detail:"low" across all pages in ONE call — cheap.
- Pattern detection per branch is one structured call.
- The expensive part stays the guarded extraction loop; cap zoom calls and
  run branches with p-limit if rate limits bite.
