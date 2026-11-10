// CLI: "more like #3" or "more like 380 Dearborn Street" -> top 5 similar active listings with a price check against sold comps.
// Usage: node runSimilar.ts [--session ID] "<request>"
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../../src/readOnlyDb.ts";
import { loadIndex } from "../../src/vectorIndex.ts";
import { recommend } from "../../src/recommend.ts";
import { fileStore, newSession } from "../../src/sessionStore.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
let sessionId = "default";
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session") sessionId = args[++i] ?? "default";
  else words.push(args[i]);
}
const request = words.join(" ").trim();
if (!request) fail('Usage: node runSimilar.ts [--session ID] "<request>"');
if (request.length > 500) fail("Request too long (max 500 characters).");

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

const store = fileStore(join(root, ".sessions"));
let db;
try {
  db = createRunner();
  const session = store.load(sessionId);
  const result = await recommend(request, db.run, index, { cities, lastShown: session?.lastShown });
  console.log(result.text);
  if (result.shown.length > 0) {
    const s = session ?? newSession();
    s.lastShown = result.shown; // so "more like #2" works on these results too
    store.save(sessionId, s);
  }
} catch (err) {
  const code = (err as { code?: string }).code ?? "unknown";
  fail(`Recommendation error (${code}).`);
} finally {
  await db?.close();
}
