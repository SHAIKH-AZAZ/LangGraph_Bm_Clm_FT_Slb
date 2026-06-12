import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { OPENAI_MODEL } from "../config.js";
import type { PipelineStateType } from "../graph/state.js";
import { encodeImage, imageContent } from "../lib/image.js";

const NotesOut = z.object({
  mix: z.string().nullable().describe("Concrete grade, e.g. M25"),
  steel_grade: z.string().nullable().describe("Steel grade, e.g. FE500"),
});

/**
 * Context agent: reads GENERAL NOTES pages for global mix / steel grade.
 * The values land in state.globalContext; the persist node back-fills any
 * record whose schedule left mix/steel_grade empty. (Schedule-level values
 * always win over notes-level values.)
 */
export async function contextNode(
  state: PipelineStateType,
): Promise<Partial<PipelineStateType>> {
  if (state.notesPages.length === 0) return {};

  const model = new ChatOpenAI({ model: OPENAI_MODEL, temperature: 0 })
    .withStructuredOutput(NotesOut, { name: "extract_notes" });

  const images = await Promise.all(
    state.notesPages.map(async (p) =>
      imageContent(await encodeImage(state.imagePaths[p - 1])),
    ),
  );

  const notes = await model.invoke([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "From these GENERAL NOTES, extract the concrete mix grade (e.g. M25) and steel grade (e.g. FE500). null if not stated.",
        },
        ...images,
      ],
    },
  ]);

  return {
    globalContext: notes,
    trace: [
      {
        ts: Date.now(),
        tool: "context_notes",
        args: { pages: state.notesPages },
        result: notes,
      },
    ],
  };
}
