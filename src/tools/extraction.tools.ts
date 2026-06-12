import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  ConfirmReadArgs,
  ThinkArgs,
  ZoomRegionArgs,
  type AnyRecord,
} from "../schemas/elements.schema.js";
import type { ElementConfig } from "../elements/registry.js";
import { ExtractionGuard } from "../guard/extractionGuard.js";
import { cropImageB64 } from "../lib/image.js";

/**
 * Built per (element, page) extraction run. The four shared tools are
 * identical for every element; only the add_<element> tool differs —
 * its schema comes straight from the registry, so the model receives
 * the exact JSON shape for beams vs columns vs slabs vs footings.
 */
export function buildExtractionTools(
  guard: ExtractionGuard,
  element: ElementConfig,
  imagePath: string,
) {
  const pendingCrops: { regionId: string; b64: string }[] = [];

  const think = tool(
    async (args) => {
      const err = guard.registerThink();
      const result = err ?? "Plan recorded. Proceed to zoom_region for unclear areas.";
      guard.log("think", args, result);
      return result;
    },
    {
      name: "think",
      description:
        "MUST be called first, exactly once. Record table structure, every visible id (including DELETED rows), regions needing zoom, and the plan.",
      schema: ThinkArgs,
    },
  );

  const zoomRegion = tool(
    async (args) => {
      const err = guard.requireThink("zoom_region");
      if (err) {
        guard.log("zoom_region", args, err);
        return err;
      }
      const regionId = guard.registerRegion(
        [args.x1, args.y1, args.x2, args.y2],
        args.reason,
      );
      const b64 = await cropImageB64(imagePath, args.x1, args.y1, args.x2, args.y2);
      pendingCrops.push({ regionId, b64 });
      guard.log("zoom_region", args, { regionId });
      return `Region ${regionId} cropped and magnified. The image follows. Read it, then call confirm_read with region_id="${regionId}" and the EXACT text.`;
    },
    {
      name: "zoom_region",
      description:
        "Crop and magnify a region using normalized coordinates (0..1). Use for unclear headers, ids, deleted rows, multi-line cells. Returns a region_id.",
      schema: ZoomRegionArgs,
    },
  );

  const confirmRead = tool(
    async (args) => {
      const err =
        guard.requireThink("confirm_read") ??
        guard.confirmRegion(args.region_id, args.exact_text);
      const result = err ?? `Confirmed read for ${args.region_id}.`;
      guard.log("confirm_read", args, result);
      return result;
    },
    {
      name: "confirm_read",
      description:
        "Record the exact verbatim text of a zoomed region BEFORE citing it as evidence in add_" + element.kind + ".",
      schema: ConfirmReadArgs,
    },
  );

  const addRecord = tool(
    async (args) => {
      const err =
        guard.requireThink(`add_${element.kind}`) ??
        guard.addRecord(args as AnyRecord);
      const result =
        err ?? `${element.kind} recorded (${guard.count} total).`;
      guard.log(`add_${element.kind}`, args, result);
      return result;
    },
    {
      name: `add_${element.kind}`,
      description: `Add one extracted ${element.kind} row. source_region_ids must reference confirmed regions. Never invent values — use null, "" or [] when not visible.`,
      schema: element.recordSchema as z.ZodObject<z.ZodRawShape>,
    },
  );

  return { tools: [think, zoomRegion, confirmRead, addRecord], pendingCrops };
}
