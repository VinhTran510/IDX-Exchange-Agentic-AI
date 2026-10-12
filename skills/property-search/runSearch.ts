// CLI: parse a free-text request, query the database (read-only), print listing cards.
// Usage: node runSearch.ts [--sold] [--page N] [--limit N] "<free-text request>"
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../../src/readOnlyDb.ts";
import { describeFilters, runSearch } from "../../src/searchPipeline.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---- arguments ---------------------------------------------------------------
const args = process.argv.slice(2);
let source: "active" | "sold" = "active";
let page: number | undefined;
let limit: number | undefined;
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sold") source = "sold";
  else if (args[i] === "--page") page = Number(args[++i]);
  else if (args[i] === "--limit") limit = Number(args[++i]);
  else words.push(args[i]);
}
const query = words.join(" ").trim();
if (!query) fail('Usage: node runSearch.ts [--sold] [--page N] [--limit N] "<request>"');
if (query.length > 500) fail("Request too long (max 500 characters).");

// ---- credentials: read-only account from .env.agent --------------------------
try {
  process.loadEnvFile(join(here, "../../.env.agent"));
} catch {
  fail("Missing .env.agent in the project root (read-only database settings).");
}

// ---- optional real city list --------------------------------------------------
const citiesPath = join(here, "../property-query-parser/cities.txt");
const cities = existsSync(citiesPath)
  ? readFileSync(citiesPath, "utf8").split("\n").map((c) => c.trim()).filter(Boolean)
  : [];

// ---- run ---------------------------------------------------------------------
let db;
try {
  db = createRunner();
  const result = await runSearch(query, db.run, { source, page, limit, cities });
  console.log(`Filters: ${describeFilters(result.filters)}`);
  console.log(result.text);
} catch (err) {
  // Print only the error code, never connection details.
  const code = (err as { code?: string }).code ?? "unknown";
  fail(`Database error (${code}).`);
} finally {
  await db?.close();
}
