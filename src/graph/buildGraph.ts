import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { PipelineState, type ExtractBranchInput, type PipelineStateType } from "./state.js";
import { ingestNode } from "../nodes/ingest.node.js";
import { supervisorNode } from "../nodes/supervisor.node.js";
import { extractBranchNode } from "../nodes/extractBranch.node.js";
import { contextNode } from "../nodes/context.node.js";
import { validateNode } from "../nodes/validate.node.js";
import { persistNode } from "../nodes/persist.node.js";

/**
 *  START → ingest → supervisor ──┬─→ extract(beam,  p2) ──┐
 *                                ├─→ extract(column,p3) ──┤
 *                                ├─→ extract(slab,  p1) ──┼→ context → validate → persist → END
 *                                └─→ extract(footing,p4)──┘
 *
 * The supervisor decides which element schedules exist on which pages;
 * Send() fans each (page, element) task out in parallel; the `combined`
 * reducer merges all results into one { beams, columns, slabs, footings }.
 */
function fanOut(state: PipelineStateType): Send[] | "context" {
  if (state.tasks.length === 0) return "context"; // nothing detected
  return state.tasks.map(
    (task) =>
      new Send("extract", {
        task,
        imagePath: state.imagePaths[task.page - 1],
        pdfPath: state.pdfPath,
        outputDir: state.outputDir,
      } satisfies ExtractBranchInput),
  );
}

export function buildPipeline() {
  const graph = new StateGraph(PipelineState)
    .addNode("ingest", ingestNode)
    .addNode("supervisor", supervisorNode)
    .addNode("extract", extractBranchNode)
    .addNode("context", contextNode)
    .addNode("validate", validateNode)
    .addNode("persist", persistNode)
    .addEdge(START, "ingest")
    .addEdge("ingest", "supervisor")
    .addConditionalEdges("supervisor", fanOut, ["extract", "context"])
    .addEdge("extract", "context")
    .addEdge("context", "validate")
    .addEdge("validate", "persist")
    .addEdge("persist", END);

  return graph.compile();
}

export type Pipeline = ReturnType<typeof buildPipeline>;
