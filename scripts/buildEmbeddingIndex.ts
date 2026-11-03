// Builds (or resumes) the semantic index from active listings. Read-only against the database.
// Usage: node scripts/buildEmbeddingIndex.ts [--city "Pasadena"] [--limit 500] [--dims 768]
// The index lands in .cache/embeddings (git-ignored). Re-running skips listings that are already embedded.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../src/readOnlyDb.ts";
import { createEmbedder, DEFAULT_DIMS } from "../src/embeddingClient.ts";
import { IndexWriter } from "../src/vectorIndex.ts";
import { buildListingText } from "../src/listingText.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let city: string | undefined;
let limit = Infinity;
let dims = DEFAULT_DIMS;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--city") city = args[++i];
  else if (args[i] === "--limit") limit = Number(args[++i]);
  else if (args[i] === "--dims") dims = Number(args[++i]);
}
if (!Number.isFinite(limit) && limit !== Infinity) throw new Error("--limit must be a number");

process.loadEnvFile(join(root, ".env.agent"));
const embedder = createEmbedder({ apiKey: process.env.GEMINI_API_KEY ?? "", dims });
const writer = new IndexWriter(join(root, ".cache", "embeddings"), embedder.model, dims);
const db = createRunner();

const PAGE = 500;
let lastId: string | null = null;
let embedded = 0;
let skippedNoText = 0;
try {
  while (embedded < limit) {
    const where = [`L_Status = 'Active'`];
    const params: string[] = [];
    if (city) { where.push(`L_City = ?`); params.push(city); }
    if (lastId !== null) { where.push(`L_ListingID > ?`); params.push(lastId); }
    const rows = await db.run(
      `SELECT L_ListingID, L_Type_, L_City, L_Keyword2, LM_Dec_3, LM_Int2_3, YearBuilt, L_Remarks ` +
      `FROM rets_property WHERE ${where.join(" AND ")} ORDER BY L_ListingID LIMIT ${PAGE}`,
      params,
    );
    if (rows.length === 0) break;
    lastId = String(rows[rows.length - 1].L_ListingID);

    const ids: string[] = [];
    const texts: string[] = [];
    for (const r of rows) {
      const id = String(r.L_ListingID);
      if (writer.has(id)) continue;
      const text = buildListingText(r);
      if (!text) { skippedNoText++; continue; }
      if (embedded + ids.length >= limit) break;
      ids.push(id);
      texts.push(text);
    }
    if (ids.length > 0) {
      writer.append(ids, await embedder.embedDocuments(texts));
      embedded += ids.length;
      console.error(`embedded ${embedded} new listings (index now ${writer.count})`);
    }
  }
  console.log(`Done. Embedded ${embedded} new listings. Index holds ${writer.count}. Skipped ${skippedNoText} without a usable description.`);
} catch (err) {
  const code = (err as { code?: string }).code ?? "unknown";
  console.error(`Stopped (${code}). Progress is saved: run the same command again to resume.`);
  process.exitCode = 1;
} finally {
  await db.close();
}
