// Builds the RAG knowledge index.
//   node scripts/buildKnowledgeIndex.ts --dry-run   chunk only, no API calls (check the counts first)
//   node scripts/buildKnowledgeIndex.ts             chunk, embed with Gemini, write knowledge/index/
// Sources live in knowledge/ (gitignored): knowledge/sources/*.pdf and knowledge/text/market.txt.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkMarket,
  chunkPrimer,
  parseSchemaColumns,
  parseTrestle,
  schemaChunks,
  type KChunk,
} from "../src/knowledgeChunker.ts";
import { embedTexts, writeIndex } from "../src/knowledgeIndex.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = join(ROOT, "knowledge", "sources");
const TEXT = join(ROOT, "knowledge", "text");
const INDEX = join(ROOT, "knowledge", "index");
const dryRun = process.argv.includes("--dry-run");

function findPdf(pattern: RegExp, label: string): string {
  const file = existsSync(SOURCES) ? readdirSync(SOURCES).find((f) => f.toLowerCase().endsWith(".pdf") && pattern.test(f)) : undefined;
  if (!file) throw new Error(`Missing ${label} PDF in knowledge/sources/`);
  return join(SOURCES, file);
}

function pdfText(path: string, pages?: [number, number]): string {
  const args = ["-layout", "-enc", "UTF-8", ...(pages ? ["-f", String(pages[0]), "-l", String(pages[1])] : []), path, "-"];
  return execFileSync("pdftotext", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

mkdirSync(TEXT, { recursive: true });
const primerText = pdfText(findPdf(/primer/i, "Primer"));
const trestleText = pdfText(findPdf(/trestle/i, "Trestle metadata"));
const schemaText = pdfText(findPdf(/handbook/i, "Handbook"), [4, 6]); // schema reference tables
writeFileSync(join(TEXT, "primer.txt"), primerText);
writeFileSync(join(TEXT, "trestle.txt"), trestleText);
writeFileSync(join(TEXT, "schema.txt"), schemaText);

const marketPath = join(TEXT, "market.txt");
if (!existsSync(marketPath)) throw new Error("Missing knowledge/text/market.txt (run runMarket.ts for a few cities first)");

const columns = parseSchemaColumns(schemaText);
const groups: [string, KChunk[]][] = [
  ["primer", chunkPrimer(primerText)],
  ["trestle", parseTrestle(trestleText)],
  ["schema", schemaChunks(columns)],
  ["market", chunkMarket(readFileSync(marketPath, "utf8"))],
];
const chunks = groups.flatMap(([, c]) => c);
const ids = new Set(chunks.map((c) => c.id));
if (ids.size !== chunks.length) throw new Error("duplicate chunk ids");

for (const [name, c] of groups) console.log(`${name}: ${c.length} chunks`);
const perTable = new Map<string, number>();
for (const c of columns) perTable.set(c.table, (perTable.get(c.table) ?? 0) + 1);
console.log(`schema columns parsed: ${[...perTable].map(([t, n]) => `${t}=${n}`).join(", ")}`);
console.log(`total: ${chunks.length} chunks, longest ${Math.max(...chunks.map((c) => c.text.length))} chars`);

if (dryRun) {
  console.log("Dry run: nothing embedded. Re-run without --dry-run to build the index.");
  process.exit(0);
}

try {
  process.loadEnvFile(join(ROOT, ".env.agent"));
} catch {
  // fall back to variables already in the environment
}
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is not set (expected in .env.agent)");

console.log("Embedding...");
const vectors = await embedTexts(chunks.map((c) => c.text), "RETRIEVAL_DOCUMENT", key);
writeIndex(INDEX, chunks, vectors);
console.log(`Done. Index written to knowledge/index/ (${chunks.length} chunks).`);
