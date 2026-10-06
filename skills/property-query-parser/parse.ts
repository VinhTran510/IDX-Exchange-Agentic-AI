// CLI wrapper around parsePropertyQuery so an OpenClaw skill can call it.
// Usage: node parse.ts "<free-text query>"
// Prints the structured filter object as JSON on stdout.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePropertyQuery } from "../../src/parsePropertyQuery.ts";

const MAX_QUERY_LENGTH = 500;

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: node parse.ts "<free-text query>"');
  process.exit(1);
}
if (query.length > MAX_QUERY_LENGTH) {
  console.error(`Query too long (max ${MAX_QUERY_LENGTH} characters).`);
  process.exit(1);
}

// Optional list of real cities (one per line), generated from the database.
const citiesPath = join(dirname(fileURLToPath(import.meta.url)), "cities.txt");
const cities = existsSync(citiesPath)
  ? readFileSync(citiesPath, "utf8").split("\n").map((c) => c.trim()).filter(Boolean)
  : [];

console.log(JSON.stringify(parsePropertyQuery(query, { cities }), null, 2));
