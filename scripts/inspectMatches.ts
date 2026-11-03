// Developer tool (not a skill): shows WHY listings matched, with similarity scores and a cleaned description snippet.
// Usage: node scripts/inspectMatches.ts "<description>"
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../src/readOnlyDb.ts";
import { createEmbedder } from "../src/embeddingClient.ts";
import { loadIndex } from "../src/vectorIndex.ts";
import { parsePropertyQuery } from "../src/parsePropertyQuery.ts";
import { hasAnyFilter } from "../src/searchPipeline.ts";
import { buildActiveIdSearch } from "../src/sqlBuilder.ts";
import { cleanRemarks } from "../src/listingText.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const query = process.argv.slice(2).join(" ").trim();
if (!query) throw new Error('Usage: node scripts/inspectMatches.ts "<description>"');

process.loadEnvFile(join(root, ".env.agent"));
const index = loadIndex(join(root, ".cache", "embeddings"));
if (!index) throw new Error("No index built yet.");
const citiesPath = join(root, "skills/property-query-parser/cities.txt");
const cities = existsSync(citiesPath) ? readFileSync(citiesPath, "utf8").split("\n").map((c) => c.trim()).filter(Boolean) : [];

const db = createRunner();
try {
  const filters = parsePropertyQuery(query, { cities });
  let allowed: Set<string> | undefined;
  if (hasAnyFilter(filters)) {
    const q = buildActiveIdSearch(filters);
    allowed = new Set((await db.run(q.sql, q.params)).map((r) => String(r.L_ListingID)));
  }
  const embedder = createEmbedder({ apiKey: process.env.GEMINI_API_KEY ?? "", dims: index.meta.dims, model: index.meta.model });
  const hits = index.topK(await embedder.embedQuery(query), 8, allowed);
  const ids = hits.map((h) => h.id);
  const rows = await db.run(
    `SELECT L_ListingID, L_Address, L_Remarks FROM rets_property WHERE L_ListingID IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [String(r.L_ListingID), r]));
  console.log(`Query: ${query}\nIndexed listings: ${index.meta.count}\n`);
  for (const h of hits) {
    const r = byId.get(h.id);
    console.log(`${h.score.toFixed(3)}  ${r?.L_Address ?? h.id}`);
    console.log(`       ${cleanRemarks(String(r?.L_Remarks ?? "")).slice(0, 220)}...\n`);
  }
} finally {
  await db.close();
}