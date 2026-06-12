import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UPLOADS_DIR, PROCESSED_DIR } from "../config.js";
import { buildPipeline } from "../graph/buildGraph.js";
import { storeCorrection } from "../services/patternLibrary.js";

const app = Fastify({ logger: true });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

const pipeline = buildPipeline();
const jobs = new Map<string, { status: string; result?: unknown }>();

/* POST /extract — upload a PDF, run the graph, return job id */
app.post("/extract", async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "PDF file required" });

  const jobId = randomUUID();
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const pdfPath = path.join(UPLOADS_DIR, `${jobId}.pdf`);
  await fs.writeFile(pdfPath, await file.toBuffer());

  jobs.set(jobId, { status: "RUNNING" });

  // fire-and-poll; swap for BullMQ/Redis in production
  pipeline
    .invoke({ pdfPath, jobId })
    .then((finalState) => {
      jobs.set(jobId, {
        status: finalState.status,
        result: { combined: finalState.combined, issues: finalState.issues },
      });
    })
    .catch((err) => {
      req.log.error(err);
      jobs.set(jobId, { status: "FAILED", result: { error: String(err) } });
    });

  return { jobId, status: "RUNNING" };
});

/* GET /extract/:jobId — poll status / result */
app.get<{ Params: { jobId: string } }>("/extract/:jobId", async (req, reply) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return reply.code(404).send({ error: "Unknown job" });
  return job;
});

/* GET /extract/:jobId/trace — full audit trail */
app.get<{ Params: { jobId: string } }>("/extract/:jobId/trace", async (req, reply) => {
  const dir = path.join(PROCESSED_DIR, req.params.jobId);
  try {
    const files = await fs.readdir(dir);
    const traceFile = files.find((f) => f.endsWith("_trace.json"));
    if (!traceFile) return reply.code(404).send({ error: "No trace yet" });
    return JSON.parse(await fs.readFile(path.join(dir, traceFile), "utf-8"));
  } catch {
    return reply.code(404).send({ error: "Unknown job" });
  }
});

/* POST /corrections — review UI feeds the pattern library */
app.post<{
  Body: { pattern: string; type: "STIRRUP" | "MAIN_BAR" | "SLAB_REINF" | "OTHER"; normalized: Record<string, unknown>; source?: string };
}>("/corrections", async (req) => {
  await storeCorrection(req.body);
  return { stored: true };
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`RCC extraction API (beam/column/slab/footing) on :${port}`);
});
