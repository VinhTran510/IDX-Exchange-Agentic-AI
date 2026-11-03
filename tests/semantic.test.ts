import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildListingText, cleanRemarks } from "../src/listingText.ts";
import { createEmbedder, normalize } from "../src/embeddingClient.ts";
import { IndexWriter, loadIndex, VectorIndex } from "../src/vectorIndex.ts";
import { semanticSearch } from "../src/semanticSearch.ts";
import { buildActiveByIds, buildActiveIdSearch } from "../src/sqlBuilder.ts";
import { emptyFilters } from "../src/sessionStore.ts";

const DIMS = 4;
const unit = (...v: number[]) => normalize(v);

// ---- listing text ---------------------------------------------------------------
test("contact details, links and HTML are stripped from descriptions", () => {
  const out = cleanRemarks("Call Jane at (626) 555-0199 or 626.555.0199, email jane@agent.com, see https://x.com/a and www.tour.com <b>Charming</b> craftsman.");
  assert.ok(!/555|@|http|www|<b>/.test(out), out);
  assert.match(out, /Charming craftsman/);
});

test("prices and years are not mistaken for phone numbers", () => {
  const out = cleanRemarks("Built in 1925, listed at $1,250,000 with 2,400 sq ft.");
  assert.match(out, /1925/);
  assert.match(out, /1,250,000/);
});

test("listing text has facts but no price, and is null without a real description", () => {
  const text = buildListingText({ L_Type_: "SingleFamilyResidence", L_City: "Pasadena", L_Keyword2: 3, LM_Dec_3: 2, LM_Int2_3: 1500, YearBuilt: 1925, L_SystemPrice: 999999, L_Remarks: "Charming craftsman with mountain views and lots of character." });
  assert.match(text!, /SingleFamilyResidence in Pasadena, CA\. 3 beds\. 2 baths\. 1500 sq ft\. Built 1925\./);
  assert.ok(!text!.includes("999999"));
  assert.equal(buildListingText({ L_Remarks: "Nice." }), null);
  assert.equal(buildListingText({ L_Remarks: null }), null);
});

// ---- embedding client -----------------------------------------------------------
function fakeFetch(opts: { fail?: number[]; dims?: number } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const failures = [...(opts.fail ?? [])];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const status = failures.shift();
    if (status) return new Response("{}", { status });
    const n = JSON.parse(init.body).requests.length;
    const embeddings = Array.from({ length: n }, () => ({ values: Array.from({ length: opts.dims ?? DIMS }, (_, i) => i + 1) }));
    return new Response(JSON.stringify({ embeddings }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("embedder batches by 100, sends task types, normalizes, and keeps the key out of the URL", async () => {
  const f = fakeFetch();
  const e = createEmbedder({ apiKey: "SECRET", dims: DIMS, fetchFn: f.fn, sleep: async () => {} });
  const vecs = await e.embedDocuments(Array.from({ length: 250 }, (_, i) => `t${i}`));
  assert.equal(vecs.length, 250);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].body.requests[0].taskType, "RETRIEVAL_DOCUMENT");
  assert.equal(f.calls[0].body.requests[0].outputDimensionality, DIMS);
  assert.ok(!f.calls[0].url.includes("SECRET"));
  assert.equal(f.calls[0].headers["x-goog-api-key"], "SECRET");
  const norm = Math.hypot(...vecs[0]);
  assert.ok(Math.abs(norm - 1) < 1e-5);
  await e.embedQuery("hi");
  assert.equal(f.calls[3].body.requests[0].taskType, "RETRIEVAL_QUERY");
});

test("embedder retries rate limits, then gives up with a status code and no key in the message", async () => {
  const ok = fakeFetch({ fail: [429, 503] });
  const e1 = createEmbedder({ apiKey: "SECRET", dims: DIMS, fetchFn: ok.fn, sleep: async () => {} });
  await e1.embedQuery("x");
  assert.equal(ok.calls.length, 3);

  const bad = fakeFetch({ fail: [403] });
  const e2 = createEmbedder({ apiKey: "SECRET", dims: DIMS, fetchFn: bad.fn, sleep: async () => {} });
  await assert.rejects(e2.embedQuery("x"), (err: any) => err.code === "EMBED_HTTP_403" && !String(err.message).includes("SECRET"));
});

test("embedder rejects a response with the wrong vector size", async () => {
  const f = fakeFetch({ dims: DIMS + 1 });
  const e = createEmbedder({ apiKey: "k", dims: DIMS, fetchFn: f.fn, sleep: async () => {} });
  await assert.rejects(e.embedQuery("x"), (err: any) => err.code === "EMBED_BAD_RESPONSE");
});

// ---- vector index ---------------------------------------------------------------
test("index: append, reload, rank, filter by allowed ids, and resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  const w = new IndexWriter(dir, "m", DIMS);
  w.append(["a", "b"], [unit(1, 0, 0, 0), unit(0, 1, 0, 0)]);
  w.append(["c"], [unit(1, 1, 0, 0)]);
  const index = loadIndex(dir)!;
  assert.equal(index.meta.count, 3);
  const hits = index.topK(unit(1, 0.1, 0, 0), 2);
  assert.deepEqual(hits.map((h) => h.id), ["a", "c"]);
  assert.deepEqual(index.topK(unit(1, 0, 0, 0), 5, new Set(["b", "c"])).map((h) => h.id), ["c", "b"]);

  const again = new IndexWriter(dir, "m", DIMS);
  assert.equal(again.has("b"), true);
  assert.equal(again.count, 3);
});

test("index: a half-written batch is repaired on resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  const w = new IndexWriter(dir, "m", DIMS);
  w.append(["a"], [unit(1, 0, 0, 0)]);
  appendFileSync(join(dir, "ids.txt"), "ghost\n"); // id written, vector never was
  const resumed = new IndexWriter(dir, "m", DIMS);
  assert.equal(resumed.count, 1);
  assert.equal(readFileSync(join(dir, "ids.txt"), "utf8"), "a\n");
});

test("index: refuses a different model or size", () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  new IndexWriter(dir, "m", DIMS).append(["a"], [unit(1, 0, 0, 0)]);
  assert.throws(() => new IndexWriter(dir, "other", DIMS));
  assert.throws(() => new IndexWriter(dir, "m", DIMS + 1));
});

// ---- SQL builders ---------------------------------------------------------------
test("candidate and by-id queries are bound params only", () => {
  const f = { ...emptyFilters(), warnings: [], city: "Pasadena", maxPrice: 2000000, hasView: true };
  const q = buildActiveIdSearch(f);
  assert.match(q.sql, /SELECT L_ListingID FROM rets_property WHERE L_Status = 'Active'/);
  assert.match(q.sql, /ViewYN = '1'/);
  assert.ok(!q.sql.includes("Pasadena"));
  const byId = buildActiveByIds(["1", "2", "3"]);
  assert.match(byId.sql, /L_ListingID IN \(\?, \?, \?\)/);
  assert.ok(!/email|phone|SELECT \*/i.test(byId.sql));
});

// ---- semantic search ------------------------------------------------------------
const embedderFor = (v: Float32Array) => ({ model: "m", dims: DIMS, embedDocuments: async () => [], embedQuery: async () => v });
const index = new VectorIndex(
  { model: "m", dims: DIMS, count: 3, createdAt: "" },
  ["1", "2", "3"],
  Float32Array.from([...unit(1, 0, 0, 0), ...unit(0.8, 0.6, 0, 0), ...unit(0, 1, 0, 0)]),
);
const cardRow = (id: string, price: number) => ({ L_ListingID: id, L_Address: `${id} Oak St`, L_City: "Pasadena", L_Zip: "91101", L_SystemPrice: price, L_Keyword2: 3, LM_Dec_3: 2, LM_Int2_3: 1500, L_Type_: "SingleFamilyResidence", PhotoCount: 10 });

test("semantic search: filters narrow candidates, similarity orders the cards", async () => {
  const seen: string[] = [];
  const run = async (sql: string, params: (string | number)[]) => {
    seen.push(sql);
    if (sql.startsWith("SELECT L_ListingID FROM")) return [{ L_ListingID: 1 }, { L_ListingID: 2 }]; // listing 3 filtered out
    return params.map((p) => cardRow(String(p), 1000000 + Number(p)));
  };
  const r = await semanticSearch("craftsman in Pasadena", run, embedderFor(unit(1, 0, 0, 0)), index, { cities: ["Pasadena"] });
  assert.match(r.text, /Top 2 listings/);
  assert.ok(r.text.indexOf("1 Oak St") < r.text.indexOf("2 Oak St"), "closest listing first");
  assert.ok(!r.text.includes("3 Oak St"), "filtered-out listing never appears");
});

test("semantic search: no structured filters ranks the whole index", async () => {
  const run = async (sql: string, params: (string | number)[]) => {
    assert.ok(!sql.startsWith("SELECT L_ListingID FROM"), "no candidate query needed");
    return params.map((p) => cardRow(String(p), 900000));
  };
  const r = await semanticSearch("charming and full of character", run, embedderFor(unit(0, 1, 0, 0)), index, { cities: [] });
  assert.match(r.text, /all active listings/);
  assert.ok(r.text.indexOf("3 Oak St") < r.text.indexOf("2 Oak St"));
});

test("semantic search: empty filter result, land requests, and index mismatch", async () => {
  const none = await semanticSearch("home in Pasadena", async () => [], embedderFor(unit(1, 0, 0, 0)), index, { cities: ["Pasadena"] });
  assert.match(none.text, /No active listings match/);
  let calls = 0;
  const land = await semanticSearch("vacant land in Pasadena", async () => (calls++, []), embedderFor(unit(1, 0, 0, 0)), index, { cities: ["Pasadena"] });
  assert.equal(calls, 0);
  assert.ok(land.text.length > 0);
  await assert.rejects(
    semanticSearch("x in Pasadena", async () => [], { ...embedderFor(unit(1, 0, 0, 0)), model: "other" }, index, { cities: ["Pasadena"] }),
    (e: any) => e.code === "INDEX_MISMATCH",
  );
});
