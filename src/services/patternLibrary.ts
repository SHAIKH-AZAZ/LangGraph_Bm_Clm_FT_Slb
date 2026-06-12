import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAIEmbeddings } from "@langchain/openai";
import { QDRANT_COLLECTION, QDRANT_URL } from "../config.js";
import { randomUUID } from "node:crypto";

/**
 * Pattern Library — the long-term asset.
 *
 * Every user correction is stored as a (raw_pattern -> normalized) example.
 * Before extraction, similar patterns are retrieved and injected into the
 * system prompt as few-shot examples, so accuracy compounds over time.
 */
export interface PatternExample {
  pattern: string;                       // "R8@150"
  type: "STIRRUP" | "MAIN_BAR" | "SLAB_REINF" | "OTHER";
  normalized: Record<string, unknown>;   // { dia: 8, spacing: 150 }
  source?: string;                       // job id / drawing it came from
}

const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });
const client = new QdrantClient({ url: QDRANT_URL });

export async function ensureCollection() {
  const collections = await client.getCollections();
  if (!collections.collections.some((c) => c.name === QDRANT_COLLECTION)) {
    await client.createCollection(QDRANT_COLLECTION, {
      vectors: { size: 1536, distance: "Cosine" },
    });
  }
}

/** Called whenever a user corrects an extraction in the review UI. */
export async function storeCorrection(example: PatternExample) {
  await ensureCollection();
  const [vector] = await embeddings.embedDocuments([example.pattern]);
  await client.upsert(QDRANT_COLLECTION, {
    points: [{ id: randomUUID(), vector, payload: example as never }],
  });
}

/** Retrieve similar notation examples to inject as few-shots. */
export async function retrieveSimilar(
  rawPattern: string,
  k = 5,
): Promise<PatternExample[]> {
  await ensureCollection();
  const [vector] = await embeddings.embedDocuments([rawPattern]);
  const hits = await client.search(QDRANT_COLLECTION, { vector, limit: k });
  return hits.map((h) => h.payload as unknown as PatternExample);
}

/** Format retrieved examples for prompt injection. */
export function formatFewShots(examples: PatternExample[]): string {
  if (examples.length === 0) return "";
  return (
    "\nKNOWN NOTATION EXAMPLES (from verified corrections):\n" +
    examples
      .map((e) => `"${e.pattern}" -> ${JSON.stringify(e.normalized)}`)
      .join("\n")
  );
}
