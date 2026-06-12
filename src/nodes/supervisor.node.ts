import { ChatOpenAI } from "@langchain/openai";
import { OPENAI_MODEL } from "../config.js";
import { ELEMENTS } from "../elements/registry.js";
import { PageClassificationSchema } from "../schemas/elements.schema.js";
import type { ExtractionTask, PipelineStateType } from "../graph/state.js";
import { encodeImage, imageContent } from "../lib/image.js";

/**
 * Supervisor / drawing classifier.
 *
 * A structural sheet often carries several schedules at once (beam + column
 * on one sheet, footing + general notes on another). For every page we ask:
 * which element schedules are present? Output is a task list — one
 * (page, element) pair per schedule — which the graph fans out in parallel.
 */
export async function supervisorNode(
  state: PipelineStateType,
): Promise<Partial<PipelineStateType>> {
  const hints = Object.values(ELEMENTS)
    .map((e) => `- ${e.kind.toUpperCase()}: ${e.classifierHints}`)
    .join("\n");

  const prompt = `You are an expert at reading RCC structural drawing sheets.
For EACH page image (in order, page numbers start at 1), identify which
structural elements are present and HOW each is represented:

- representation "schedule": a TABLE with header rows and data rows.
  Detect by header structure:
${hints}

- representation "layout": DETAIL DRAWINGS — beam cross-section rectangles
  with bar annotations inside, small stirrup tables, and beam labels like
  B3b(200x600) below each rectangle, arranged in horizontal rows or a 2D
  grid across the sheet. (Currently only beams appear as layouts.)

A page can contain multiple elements, or none. Also flag pages containing
GENERAL NOTES (concrete mix like M25, steel grade like FE500, cover).`;

  const model = new ChatOpenAI({ model: OPENAI_MODEL, temperature: 0 })
    .withStructuredOutput(PageClassificationSchema, { name: "classify_pages" });

  const images = await Promise.all(
    state.imagePaths.map(async (p, i) => [
      { type: "text" as const, text: `--- Page ${i + 1} ---` },
      imageContent(await encodeImage(p), "low"), // low detail: headers suffice
    ]),
  );

  const result = await model.invoke([
    { role: "user", content: [{ type: "text", text: prompt }, ...images.flat()] },
  ]);

  const tasks: ExtractionTask[] = result.pages.flatMap((p) =>
    p.elements.map((e) => ({
      page: p.page,
      element: e.kind,
      representation: e.representation,
    })),
  );
  const notesPages = result.pages
    .filter((p) => p.has_general_notes)
    .map((p) => p.page);

  return {
    tasks,
    notesPages,
    trace: [{ ts: Date.now(), tool: "supervisor", args: {}, result }],
  };
}
