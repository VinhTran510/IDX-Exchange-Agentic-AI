// CLI: answer a market-statistics question from sold data (read-only).
// Usage: node runMarket.ts "<question, e.g. median price in Pasadena>"
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../../src/readOnlyDb.ts";
import { answerMarketQuestion } from "../../src/marketReport.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const question = process.argv.slice(2).join(" ").trim();
if (!question) fail('Usage: node runMarket.ts "<market question>"');
if (question.length > 500) fail("Question too long (max 500 characters).");

try {
  process.loadEnvFile(join(here, "../../.env.agent"));
} catch {
  fail("Missing .env.agent in the project root (read-only database settings).");
}

const citiesPath = join(here, "../property-query-parser/cities.txt");
const cities = existsSync(citiesPath)
  ? readFileSync(citiesPath, "utf8").split("\n").map((c) => c.trim()).filter(Boolean)
  : [];

let db;
try {
  db = createRunner();
  console.log(await answerMarketQuestion(question, db.run, cities));
} catch (err) {
  const code = (err as { code?: string }).code ?? "unknown";
  fail(`Database error (${code}).`);
} finally {
  await db?.close();
}
