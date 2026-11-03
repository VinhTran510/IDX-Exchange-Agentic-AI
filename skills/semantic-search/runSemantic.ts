// CLI: find active listings whose description matches a free-text idea ("charming craftsman with mountain views").
// Usage: node runSemantic.ts "<description, optionally with city/price/beds>"
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../../src/readOnlyDb.ts";
import { createEmbedder } from "../../src/embeddingClient.ts";
import { loadIndex } from "../../src/vectorIndex.ts";
import { semanticSearch } from "../../src/semanticSearch.ts";
import { describeFilters } from "../../src/searchPipeline.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const query = process.argv.slice(2).join(" ").trim();
if (!query) fail('Usage: node runSemantic.ts "<description>"');
if (query.length > 500) fail("Request too long (max 500 characters).");

try {
  process.loadEnvFile(join(root, ".env.agent"));
} catch {
  fail("Missing .env.agent in the project root.");
}

const index = loadIndex(join(root, ".cache", "embeddings"));
if (!index) fail("The semantic index has not been built yet.");

const citiesPath = join(here, "../property-query-parser/cities.txt");
const cities = existsSync(citiesPath)
  ? readFileSync(citiesPath, "utf8").split("\n").map((c) => c.trim()).filter(Boolean)
  : [];

let db;
try {
  const embedder = createEmbedder({ apiKey: process.env.GEMINI_API_KEY ?? "", dims: index.meta.dims, model: index.meta.model });
  db = createRunner();
  const result = await semanticSearch(query, db.run, embedder, index, { cities });
  console.log(`Filters: ${describeFilters(result.filters)}`);
  console.log(result.text);
} catch (err) {
  const code = (err as { code?: string }).code ?? "unknown";
  fail(`Search error (${code}).`);
} finally {
  await db?.close();
}
