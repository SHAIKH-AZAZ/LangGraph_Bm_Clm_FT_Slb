import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_DIR = path.resolve(__dirname, "..");
export const PROMPTS_DIR = path.join(BASE_DIR, "prompts");
export const STORAGE_DIR = path.join(BASE_DIR, "storage");
export const UPLOADS_DIR = path.join(STORAGE_DIR, "uploads");
export const PROCESSED_DIR = path.join(STORAGE_DIR, "processed");
export const EXPORTS_DIR = path.join(STORAGE_DIR, "exports");

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
export const OPENAI_IMAGE_DETAIL = (process.env.OPENAI_IMAGE_DETAIL ?? "high") as
  | "low"
  | "high"
  | "auto";

export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
export const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? "slab_patterns";

export const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS ?? 60);
export const PDF_RENDER_SCALE = Number(process.env.PDF_RENDER_SCALE ?? 3); // ~216 DPI

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY not found in .env file");
}
