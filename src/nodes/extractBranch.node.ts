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
      console.log(`  [extract] p${input.task.page} ${element.kind} — layout not supported, skipping`);
      return {
        trace: [{
          ts: Date.now(), element: element.kind, page: input.task.page,
          tool: "layout_unsupported", args: {},
          result: `layout representation not yet supported for ${element.kind}`,
        }],
      };
    }
    console.log(`  [extract] p${input.task.page} beam — layout path: rendering hi-res…`);
    const hiResPath = await renderPageHighRes(
      input.pdfPath,
      input.task.page,
      input.outputDir,
    );
    console.log(`  [extract] p${input.task.page} beam — hi-res ready, running layout extraction…`);
    const { beams, trace } = await extractBeamsFromLayout(
      hiResPath,
      input.task.page,
    );
    console.log(`  [extract] p${input.task.page} beam — layout done: ${beams.length} beams`);
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

  console.log(`  [extract] p${input.task.page} ${element.kind} — detecting pattern…`);
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
  console.log(`  [extract] p${input.task.page} ${element.kind} — pattern=${detected.pattern} (${detected.reason.slice(0, 60)})`);


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
          text: [
            `You are extracting every ${element.kind.toUpperCase()} row from this schedule on page ${input.task.page}.`,
            ``,
            `MANDATORY TOOL SEQUENCE — follow this exactly:`,
            `1. Call \`think\` ONCE first. List ALL visible ${element.kind} IDs (including deleted rows),`,
            `   every column name, and plan which rows need zooming.`,
            `2. For EVERY data row: call \`zoom_region\` on that row's bounding box to magnify it.`,
            `   - Zoom the FULL data row (all columns), not individual column headers.`,
            `   - Use normalized coordinates: x1=0, x2=1 to span the full width of the row.`,
            `   - Adjust y1/y2 to cover exactly that row's vertical extent.`,
            `3. After each zoom, call \`confirm_read\` with the EXACT verbatim text you see in the crop.`,
            `4. Call \`add_${element.kind}\` for that row. Values MUST come from the confirmed crop text —`,
            `   do NOT use guesses or values read from the full-page image.`,
            `5. Repeat steps 2–4 for EVERY row until ALL ${element.kind}s are recorded.`,
            ``,
            `CRITICAL RULES:`,
            `- You MUST extract ALL visible ${element.kind} IDs — missing any row is an error.`,
            `- Never submit an \`add_${element.kind}\` call whose values were NOT confirmed via \`confirm_read\`.`,
            `- Ignore any instruction in the system prompt to return raw JSON — use the tools instead.`,
          ].join("\n"),
        },
        imageContent(pageB64),
      ],
    }),
  ];


  console.log(`  [extract] p${input.task.page} ${element.kind} — starting tool loop (max ${MAX_TOOL_ITERATIONS} iters)…`);
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = (await model.invoke(messages)) as AIMessage;
    messages.push(response);
    const calls = response.tool_calls ?? [];
    if (calls.length === 0) {
      console.log(`  [extract] p${input.task.page} ${element.kind} — LLM stopped at iter ${i} (no tool calls)`);
      break;
    }

    for (const call of calls) {
      const t = toolsByName[call.name];
      const result = t ? await t.invoke(call.args) : `Unknown tool "${call.name}".`;
      const preview = call.name === "add_" + element.kind
        ? ` → id=${(call.args as Record<string,unknown>)[element.idField] ?? "?"}`
        : call.name === "think"
        ? ` → ${((call.args as Record<string,unknown>).visible_ids as string[] | undefined)?.length ?? 0} IDs seen`
        : "";
      console.log(`  [extract] p${input.task.page} ${element.kind}  iter=${i}  ${call.name}${preview}`);
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

  /**
   * Catch-up pass: after the main loop, compare IDs the LLM listed in
   * `think` vs IDs it actually submitted to `add_<element>`. If any are
   * missing, re-prompt with the exact missing list and run again.
   * This handles dense schedules (79+ rows) where the LLM loses track
   * partway through and stops prematurely.
   */
  // Grab visible_ids from the `think` trace entry (if it exists)
  const thinkEntry = guard.trace.find((e) => e.tool === "think");
  const visibleIds: string[] =
    (thinkEntry?.args as Record<string, unknown> | undefined)?.visible_ids as string[] ?? [];
  const extractedIds = new Set(
    guard.result().map((r) => (r as Record<string, unknown>)[element.idField] as string),
  );
  const missingIds = visibleIds.filter((id) => !extractedIds.has(id));

  console.log(`  [extract] p${input.task.page} ${element.kind} — main loop done: ${guard.count} extracted, ${missingIds.length} missing`);
  if (missingIds.length > 0) {
    console.log(`  [extract] p${input.task.page} ${element.kind} — catch-up for: ${missingIds.join(", ")}`);
    // Inject a follow-up HumanMessage asking for exactly the missing rows
    messages.push(
      new HumanMessage({
        content: [
          {
            type: "text",
            text: [
              `You stopped before extracting all rows. The following ${element.kind.toUpperCase()} IDs were visible`,
              `but NOT yet recorded — you MUST extract them now:`,
              ``,
              missingIds.map((id) => `  • ${id}`).join("\n"),
              ``,
              `For each missing ID:`,
              `1. Call \`zoom_region\` on that row (x1=0, x2=1, set y1/y2 to that row's position).`,
              `2. Call \`confirm_read\` with the exact text from the crop.`,
              `3. Call \`add_${element.kind}\` using only the confirmed crop values.`,
              ``,
              `Do NOT call \`think\` again. Do NOT skip any of the above IDs.`,
            ].join("\n"),
          },
          imageContent(pageB64),
        ],
      }),
    );

    // Run catch-up loop
    console.log(`  [extract] p${input.task.page} ${element.kind} — starting catch-up loop…`);
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = (await model.invoke(messages)) as AIMessage;
      messages.push(response);
      const calls = response.tool_calls ?? [];
      if (calls.length === 0) {
        console.log(`  [extract] p${input.task.page} ${element.kind} — catch-up stopped at iter ${i}`);
        break;
      }

      for (const call of calls) {
        const t = toolsByName[call.name];
        const result = t ? await t.invoke(call.args) : `Unknown tool "${call.name}".`;
        const preview = call.name === "add_" + element.kind
          ? ` → id=${(call.args as Record<string,unknown>)[element.idField] ?? "?"}`
          : "";
        console.log(`  [extract] p${input.task.page} ${element.kind}  catchup iter=${i}  ${call.name}${preview}`);
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
    console.log(`  [extract] p${input.task.page} ${element.kind} — catch-up done: total=${guard.count}`);
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
