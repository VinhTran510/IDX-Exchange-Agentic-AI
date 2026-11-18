import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkMarket,
  chunkPrimer,
  cleanText,
  isDistinctiveKey,
  MAX_CHUNK_CHARS,
  parseSchemaColumns,
  parseTrestle,
  schemaChunks,
} from "../src/knowledgeChunker.ts";
import { DIMS, embedTexts, loadIndex, normalize, retrieve, writeIndex, type KnowledgeIndex } from "../src/knowledgeIndex.ts";

// ---- cleanText ------------------------------------------------------------------------------

test("cleanText strips terminal escape sequences and control characters", () => {
  const dirty = "\u001b]633;E;for c in x;abc\u0007\u001b]633;C\u0007Market summary: Irvine\u001b[0m\r\nline\u0000two";
  assert.equal(cleanText(dirty), "Market summary: Irvine\nlinetwo");
});

test("isDistinctiveKey: camel case, underscores and digits only", () => {
  assert.ok(isDistinctiveKey("YearBuilt"));
  assert.ok(isDistinctiveKey("L_Keyword2"));
  assert.ok(isDistinctiveKey("california_sold"));
  assert.ok(!isDistinctiveKey("City"));
  assert.ok(!isDistinctiveKey("View"));
});

// ---- schema table (fixed-width columns, wrapped names and descriptions) ------------------------

const hdr = " Column".padEnd(30) + "Type".padEnd(23) + "Description";
const row = (n: string, t: string, d: string) => " " + n.padEnd(29) + t.padEnd(23) + d;
const cont = (n: string, d: string) => " " + n.padEnd(29) + "".padEnd(23) + d;
const SCHEMA = [
  "Data Schema Reference",
  "",
  "rets_property — Active Listings",
  "",
  hdr,
  row("id", "INT PK", "Auto-increment primary key"),
  row("L_ListingID", "VARCHAR", "MLS system listing ID — joins to"),
  cont("", "california_sold.ListingKey"),
  row("ListAgentDirectPho", "VARCHAR", "Listing agent direct phone"),
  cont("ne", ""),
  "",
  "Confidential — IDX Exchange Internship Program      Page 4 of 29",
  "IDX Exchange | AI Agentic Engineer Intern Handbook",
  "",
  "california_sold — Sold Transactions",
  "",
  hdr,
  row("ClosePrice", "DOUBLE", "Final sale/close price"),
  row("BathroomsTotalInte", "DOUBLE", "Number of bathrooms"),
  cont("ger", ""),
  "  Key Join Pattern",
  row("ShouldNotBeParsed", "INT", "after the stop marker"),
].join("\n");

test("parseSchemaColumns: wrapped names and descriptions are rejoined, parsing stops at the join note", () => {
  const cols = parseSchemaColumns(SCHEMA);
  assert.deepEqual(
    cols.map((c) => `${c.table}.${c.name}`),
    ["rets_property.id", "rets_property.L_ListingID", "rets_property.ListAgentDirectPhone", "california_sold.ClosePrice", "california_sold.BathroomsTotalInteger"],
  );
  assert.equal(cols[0].type, "INT PK");
  assert.equal(cols[1].desc, "MLS system listing ID — joins to california_sold.ListingKey");
});

test("schemaChunks: one list chunk per table (for 'what columns' questions) plus one chunk per column", () => {
  const chunks = schemaChunks(parseSchemaColumns(SCHEMA));
  const list = chunks.find((c) => c.key === "california_sold")!;
  assert.match(list.text, /2 documented columns: ClosePrice, BathroomsTotalInteger\./);
  assert.equal(chunks.filter((c) => c.id.startsWith("schema-list-")).length, 2);
  assert.equal(chunks.length, 2 + 5);
  assert.ok(chunks.find((c) => c.key === "L_ListingID")!.text.includes("joins to california_sold.ListingKey"));
});

// ---- Trestle (description centered around the name line, page-break straddling) --------------

const DESC = 62;
const dl = (d: string) => " ".repeat(DESC) + d;
const nl = (name: string, type: string, size: string, inline = "") =>
  ("      " + name.padEnd(28) + type.padEnd(18) + size).padEnd(DESC) + inline;
const TRESTLE = [
  "https://api-trestle.example/Documentation",
  "      Field".padEnd(40) + "Type    Size    Description",
  "",
  dl("The total number of whole bathrooms in the"),
  nl("BathroomsFull", "Int32", "4", "property, counting full baths"),
  dl("only."),
  "",
  nl("SubdivisionName", "String", "50", "The name of the subdivision."),
  "",
  dl("The last piece of this description lives on"),
  dl("the previous page. It started here"),
  "",
  "https://api-trestle.example/Documentation        Page 2 of 3",
  "Property                                              5/13/24, 11:12 AM",
  "",
  dl("and finished after the page break."),
  nl("StandardStatus", "InKey", "").replace("InKey", "InKey             ") + "",
  "",
  dl("Pointer to related rows."),
  nl("Media", "Collection", ""),
  "",
].join("\n");

test("parseTrestle: description above, inline and below the name line are stitched in order", () => {
  const chunks = parseTrestle(TRESTLE);
  const bf = chunks.find((c) => c.key === "BathroomsFull")!;
  assert.match(bf.text, /Field BathroomsFull \(type: Int32, size 4\): The total number of whole bathrooms in the property, counting full baths only\./);
  assert.equal(chunks.find((c) => c.key === "SubdivisionName")!.text.endsWith("The name of the subdivision."), true);
});

test("parseTrestle: an orphan description at the bottom of a page joins the first field of the next page", () => {
  const chunks = parseTrestle(TRESTLE);
  const s = chunks.find((c) => c.key === "StandardStatus")!;
  assert.match(s.text, /The last piece of this description lives on the previous page\. It started here and finished after the page break\./);
});

test("parseTrestle: entries with no definition text are skipped, no page noise leaks into text", () => {
  const chunks = parseTrestle(TRESTLE);
  assert.ok(chunks.every((c) => !/https?:\/\//.test(c.text) && !/5\/13\/24/.test(c.text)));
  assert.ok(!chunks.some((c) => c.key === "Media" && !/Pointer/.test(c.text)));
});

// ---- Primer ---------------------------------------------------------------------------------

const PRIMER = [
  "Real Estate Data Analyst Primer",
  "",
  "1. Where the Data Comes From",
  "An MLS is a shared database of listings run by brokers.",
  "",
  "8. Days on Market (DOM)",
  "Days on Market measures how long a property was listed before going under contract.",
  "",
  "How It Is Calculated",
  "DOM is the number of days between listing and contract.",
  "",
  "Page 3 of 8",
  "",
  "3. List Price vs. Close Price",
  "The list-to-close ratio compares the close price with the list price.",
  "",
  "A very long paragraph. " + "It keeps going with more sentences about pricing. ".repeat(60),
].join("\n");

test("chunkPrimer: headings that sit directly above their text label the chunk", () => {
  const chunks = chunkPrimer(PRIMER);
  const dom = chunks.find((c) => c.heading === "8. Days on Market (DOM)")!;
  assert.match(dom.text, /^\[Real Estate Data Analyst Primer: 8\. Days on Market \(DOM\)\]/);
  assert.match(dom.text, /Days on Market measures/);
  assert.ok(chunks.some((c) => c.heading === "8. Days on Market (DOM) > How It Is Calculated"));
  assert.ok(chunks.some((c) => c.heading.startsWith("3. List Price vs. Close Price") && /list-to-close ratio/.test(c.text)));
});

test("chunkPrimer: page numbers are dropped and no chunk blows past the size limit", () => {
  const chunks = chunkPrimer(PRIMER);
  assert.ok(chunks.every((c) => !/Page 3 of 8/.test(c.text)));
  assert.ok(chunks.every((c) => c.text.length <= MAX_CHUNK_CHARS * 1.4), `longest ${Math.max(...chunks.map((c) => c.text.length))}`);
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
});

// ---- Market ---------------------------------------------------------------------------------

test("chunkMarket: one chunk per report, leading terminal junk ignored", () => {
  const raw = "\u001b]633;E;for c in x\u0007Market summary: Irvine (all residential types)\nBased on 10 sales.\n\nMedian price: $1\n\nMarket summary: Pasadena (all residential types)\nBased on 5 sales.\n";
  const chunks = chunkMarket(raw);
  assert.deepEqual(chunks.map((c) => c.heading), ["Irvine", "Pasadena"]);
  assert.match(chunks[0].text, /Median price/);
  assert.ok(!chunks[0].text.includes("633"));
});

// ---- embedTexts -----------------------------------------------------------------------------

function fakeEmbedFetch(statuses: number[] = []) {
  const calls: { url: string; headers: Record<string, string>; n: number }[] = [];
  const queue = [...statuses];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, n: body.requests.length });
    const status = queue.shift() ?? 200;
    if (status !== 200) return { ok: false, status, json: async () => ({}), text: async () => "" };
    const embeddings = body.requests.map(() => ({ values: Array.from({ length: DIMS }, (_, i) => (i === 0 ? 3 : 4 * (i === 1 ? 1 : 0))) }));
    return { ok: true, status, json: async () => ({ embeddings }), text: async () => "" };
  };
  return { fetchImpl, calls };
}

test("embedTexts: batches of 50, normalizes vectors, key only in the header", async () => {
  const { fetchImpl, calls } = fakeEmbedFetch();
  const vecs = await embedTexts(Array.from({ length: 120 }, (_, i) => `t${i}`), "RETRIEVAL_DOCUMENT", "SECRET", { fetchImpl });
  assert.deepEqual(calls.map((c) => c.n), [50, 50, 20]);
  assert.equal(vecs.length, 120);
  assert.ok(Math.abs(Math.hypot(...vecs[0]) - 1) < 1e-9);
  assert.ok(calls.every((c) => c.headers["x-goog-api-key"] === "SECRET" && !c.url.includes("SECRET")));
});

test("embedTexts: retries rate limits, gives up on other errors without leaking details", async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  const ok = fakeEmbedFetch([429, 503]);
  const v = await embedTexts(["a"], "RETRIEVAL_QUERY", "k", { fetchImpl: ok.fetchImpl, sleep });
  assert.equal(v.length, 1);
  assert.equal(ok.calls.length, 3);
  assert.equal(slept.length, 2);
  const bad = fakeEmbedFetch([400]);
  await assert.rejects(() => embedTexts(["a"], "RETRIEVAL_QUERY", "k", { fetchImpl: bad.fetchImpl, sleep }), /HTTP 400/);
  const always = fakeEmbedFetch(Array(10).fill(429));
  await assert.rejects(() => embedTexts(["a"], "RETRIEVAL_QUERY", "k", { fetchImpl: always.fetchImpl, sleep, maxRetries: 2 }), /HTTP 429/);
});

// ---- retrieval ------------------------------------------------------------------------------

const unit = (i: number) => {
  const v = new Array(DIMS).fill(0);
  v[i] = 1;
  return v;
};
function makeIndex(): KnowledgeIndex {
  const chunks = [
    { id: "a", source: "S", heading: "DOM", text: "DOM text" },
    { id: "b", source: "S", heading: "ratio", text: "ratio text" },
    { id: "c", source: "S", heading: "california_sold column list", key: "california_sold", text: "columns" },
    { id: "d", source: "S", heading: "City", key: "City", text: "City field" },
  ];
  const vectors = new Float32Array(chunks.length * DIMS);
  chunks.forEach((_, i) => vectors.set(unit(i), i * DIMS));
  return { chunks, vectors };
}

test("retrieve: ranks by cosine, drops passages under the threshold", () => {
  const hits = retrieve(makeIndex(), unit(1), "what is the ratio", 5, 0.5);
  assert.deepEqual(hits.map((h) => h.chunk.id), ["b"]);
  assert.equal(retrieve(makeIndex(), unit(10), "something unrelated", 5, 0.5).length, 0);
});

test("retrieve: passages far below the best match are dropped, and a weak best match returns nothing", () => {
  const q = normalize(Array.from({ length: DIMS }, (_, i) => (i === 0 ? 0.9 : i === 1 ? 0.6 : 0)));
  const hits = retrieve(makeIndex(), q, "something", 5, 0.5, 0.1);
  assert.deepEqual(hits.map((h) => h.chunk.id), ["a"]); // 0.83 kept, 0.55 is more than 0.1 below it
  assert.equal(retrieve(makeIndex(), q, "something", 5, 0.9, 0.1).length, 0); // best 0.83 < 0.9: not covered
});

test("retrieve: an exact table or column name in the question wins even with a low similarity", () => {
  const hits = retrieve(makeIndex(), unit(0), "What columns are in california_sold?", 5, 0.5);
  assert.equal(hits[0].chunk.id, "c");
  assert.ok(hits[0].exact);
  assert.ok(hits.some((h) => h.chunk.id === "a"));
});

test("retrieve: plain words like 'city' do not trigger exact-match boosting", () => {
  const hits = retrieve(makeIndex(), unit(1), "which city is best", 5, 0.5);
  assert.ok(!hits.some((h) => h.exact));
});

test("index files round-trip, and a mismatched index is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "kidx-"));
  try {
    const idx = makeIndex();
    writeIndex(dir, idx.chunks, idx.chunks.map((_, i) => unit(i)));
    const back = loadIndex(dir);
    assert.deepEqual(back.chunks, idx.chunks);
    assert.equal(back.vectors.length, idx.vectors.length);
    assert.equal(back.vectors[DIMS + 1], 1);
    assert.throws(() => writeIndex(dir, idx.chunks, [unit(0)]), /differ in length/);
    assert.throws(() => writeIndex(dir, idx.chunks.slice(0, 1), [[1, 2, 3]]), /dimensions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalize returns unit vectors and tolerates zero vectors", () => {
  assert.ok(Math.abs(Math.hypot(...normalize([3, 4])) - 1) < 1e-12);
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});
