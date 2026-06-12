import fs from "node:fs/promises";
import path from "node:path";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { MAX_TOOL_ITERATIONS, OPENAI_MODEL, PROMPTS_DIR } from "../config.js";
import type { ExtractBranchInput, PipelineStateType } from "../graph/state.js";
import { getElement } from "../elements/registry.js";
import { ExtractionGuard } from "../guard/extractionGuard.js";
import { buildExtractionTools } from "../tools/extraction.tools.js";
import { encodeImage, imageContent } from "../lib/image.js";
import type { CombinedResult } from "../schemas/elements.schema.js";
import {
  extractBeamsFromLayout,
  renderPageHighRes,
} from "../elements/layout/beamLayout.js";

/**
 * One fan-out branch = one (page, element) task.
 * Step 1: detect the element-specific pattern (beam has 14, column 15,
 *         slab 9, footing 10) from header structure.
 * Step 2: run the guarded tool loop with the pattern's prompt and the
 *         element's add_<element> tool.
 * Returns a partial state; the `combined` reducer merges records in.
 */
export async function extractBranchNode(
  input: ExtractBranchInput,
): Promise<Partial<PipelineStateType>> {
  const element = getElement(input.task.element);

  /* ---------- LAYOUT representation: slicing pipeline ------------------ */
  /* Beam detail drawings are not tables — no pattern prompts, no guarded  */
  /* tool loop. Instead: classify stripe/grid, slice with overlap, extract */
  /* per slice in parallel, merge fragments, prefix-group union.           */
  if (input.task.representation === "layout") {
    if (element.kind !== "beam") {
      return {
        trace: [{
          ts: Date.now(), element: element.kind, page: input.task.page,
          tool: "layout_unsupported", args: {},
          result: `layout representation not yet supported for ${element.kind}`,
        }],
      };
    }
    const hiResPath = await renderPageHighRes(
      input.pdfPath,
      input.task.page,
      input.outputDir,
    );
    const { beams, trace } = await extractBeamsFromLayout(
      hiResPath,
      input.task.page,
    );
    return {
      combined: { beams } as CombinedResult,
      trace,
    };
  }

  /* ---------- SCHEDULE representation: pattern + guarded tool loop ----- */
  const pageB64 = await encodeImage(input.imagePath);

  /* ---------- Step 1: pattern detection (header-only, structured) ----- */
  const PatternOut = z.object({
    pattern: z.number().int().min(1).max(element.patternCount),
    reason: z.string(),
  });
  const classifier = new ChatOpenAI({ model: OPENAI_MODEL, temperature: 0 })
    .withStructuredOutput(PatternOut, { name: "detect_pattern" });

  const detected = await classifier.invoke([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `You are an expert at identifying RCC ${element.kind.toUpperCase()} schedule header patterns. Look ONLY at the HEADER structure; ignore data rows. There are EXACTLY ${element.patternCount} patterns for ${element.kind} schedules. Pick the matching pattern number.`,
        },
        imageContent(pageB64),
      ],
    },
  ]);

  /* ---------- Step 2: guarded tool-loop extraction --------------------- */
  const promptPath = path.join(
    PROMPTS_DIR,
    element.kind,
    `prompt_${detected.pattern}.txt`,
  );
  const systemPrompt = await fs.readFile(promptPath, "utf-8");

  const guard = new ExtractionGuard(element.idField, {
    element: element.kind,
    page: input.task.page,
  });
  const { tools, pendingCrops } = buildExtractionTools(
    guard,
    element,
    input.imagePath,
  );
  type Invokable = { name: string; invoke: (args: unknown) => Promise<unknown> };
  const toolsByName: Record<string, Invokable> = Object.fromEntries(
    (tools as unknown as Invokable[]).map((t) => [t.name, t]),
  );

  const model = new ChatOpenAI({ model: OPENAI_MODEL, temperature: 0 }).bindTools(
    tools,
    { tool_choice: "auto" },
  );

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage({
      content: [
        {
          type: "text",
          text: `Extract every ${element.kind} from this schedule (page ${input.task.page}). Begin with the \`think\` tool, and record rows with \`add_${element.kind}\`.`,
        },
        imageContent(pageB64),
      ],
    }),
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = (await model.invoke(messages)) as AIMessage;
    messages.push(response);
    const calls = response.tool_calls ?? [];
    if (calls.length === 0) break;

    for (const call of calls) {
      const t = toolsByName[call.name];
      const result = t ? await t.invoke(call.args) : `Unknown tool "${call.name}".`;
      messages.push(
        new ToolMessage({
          content: String(result),
          tool_call_id: call.id ?? "",
          name: call.name,
        }),
      );
    }

    while (pendingCrops.length > 0) {
      const crop = pendingCrops.shift()!;
      messages.push(
        new HumanMessage({
          content: [
            { type: "text", text: `Magnified crop for region ${crop.regionId}:` },
            imageContent(crop.b64),
          ],
        }),
      );
    }
  }

  const combined: Partial<CombinedResult> = {
    [element.resultKey]: guard.result(),
  };

  return {
    combined: combined as CombinedResult,
    trace: [
      {
        ts: Date.now(),
        element: element.kind,
        page: input.task.page,
        tool: "detect_pattern",
        args: {},
        result: detected,
      },
      ...guard.trace,
    ],
  };
}
