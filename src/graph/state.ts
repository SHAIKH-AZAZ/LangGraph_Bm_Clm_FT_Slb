import { Annotation } from "@langchain/langgraph";
import type {
  CombinedResult,
  ElementKindT,
  RepresentationT,
  TraceEvent,
  ValidationIssue,
} from "../schemas/elements.schema.js";

/** One unit of extraction work: (page, element, detected pattern). */
export interface ExtractionTask {
  page: number;            // 1-based
  element: ElementKindT;
  representation: RepresentationT;   // "schedule" table vs "layout" detail drawing
}

const emptyCombined = (): CombinedResult => ({
  beams: [],
  columns: [],
  slabs: [],
  footings: [],
});

export const PipelineState = Annotation.Root({
  /* inputs */
  pdfPath: Annotation<string>,
  jobId: Annotation<string>,

  /* ingest */
  imagePaths: Annotation<string[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),
  outputDir: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),

  /* supervisor: which elements live on which pages */
  tasks: Annotation<ExtractionTask[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),
  notesPages: Annotation<number[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),

  /* fan-out results: each extract branch merges its records in */
  combined: Annotation<CombinedResult>({
    reducer: (prev, next) => ({
      beams: [...prev.beams, ...(next.beams ?? [])],
      columns: [...prev.columns, ...(next.columns ?? [])],
      slabs: [...prev.slabs, ...(next.slabs ?? [])],
      footings: [...prev.footings, ...(next.footings ?? [])],
      global_context: next.global_context ?? prev.global_context,
    }),
    default: emptyCombined,
  }),

  trace: Annotation<TraceEvent[]>({
    reducer: (p, n) => [...p, ...n],
    default: () => [],
  }),

  /* general notes (context agent): applied as backfill at persist time */
  globalContext: Annotation<{ mix: string | null; steel_grade: string | null } | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),

  /* validation */
  issues: Annotation<ValidationIssue[]>({
    reducer: (p, n) => [...p, ...n],
    default: () => [],
  }),
  status: Annotation<"OK" | "REVIEW_REQUIRED" | "FAILED">({
    reducer: (_p, n) => n,
    default: () => "OK" as const,
  }),
});

export type PipelineStateType = typeof PipelineState.State;

/** Private state passed to each fan-out extraction branch via Send(). */
export interface ExtractBranchInput {
  task: ExtractionTask;
  imagePath: string;   // ingest-resolution render (~216 DPI)
  pdfPath: string;     // for layout-mode high-res re-render
  outputDir: string;
}
