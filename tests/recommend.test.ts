import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessPrice, compWindow, describeAssessment, MIN_COMPS, parseTarget, percentileRanks, rankCandidates, recommend, structuredScore,
} from "../src/recommend.ts";
import { addressLookupQuery, candidatePoolQuery, compQuery, escapeLike, type Target } from "../src/recommendQueries.ts";
import { normalize } from "../src/embeddingClient.ts";
import { VectorIndex } from "../src/vectorIndex.ts";

const cities = ["Pasadena", "Irvine", "Palm Desert"];
const T: Target = { id: "100", city: "Pasadena", type: "SingleFamilyResidence", price: 1000000, beds: 3, baths: 2, sqft: 1500 };

// ---- who is the user pointing at ----------------------------------------------------------
test("parseTarget: positions", () => {
  assert.deepEqual(parseTarget("more like #3"), { kind: "position", n: 3 });
  assert.deepEqual(parseTarget("show me something like number 2"), { kind: "position", n: 2 });
  assert.deepEqual(parseTarget("homes similar to the second one"), { kind: "position", n: 2 });
  assert.deepEqual(parseTarget("like option 5"), { kind: "position", n: 5 });
});

test("parseTarget: addresses, with and without a city", () => {
  assert.deepEqual(parseTarget("more like 380 Dearborn Street", cities), { kind: "address", street: "380 Dearborn Street", city: null });
  assert.deepEqual(parseTarget("similar to 380 Dearborn Street, Pasadena, CA 91104", cities), { kind: "address", street: "380 Dearborn Street", city: "Pasadena" });
  assert.deepEqual(parseTarget("more like 1422 La Loma in Pasadena", cities), { kind: "address", street: "1422 La Loma", city: "Pasadena" });
  assert.deepEqual(parseTarget("380 Dearborn Street", cities), { kind: "address", street: "380 Dearborn Street", city: null });
});

test("parseTarget: a search is not an address, and nothing named gives 'none'", () => {
  assert.equal(parseTarget("3 bed homes in Irvine under 1.5M", cities).kind, "none");
  assert.equal(parseTarget("what is similar", cities).kind, "none");
});

// ---- SQL ---------------------------------------------------------------------------------------
test("address lookup: LIKE wildcards are escaped, suffix variants tried, everything bound", () => {
  assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
  const q = addressLookupQuery("380 Dearborn Street", "Pasadena");
  assert.match(q.sql, /\(L_Address LIKE \? OR L_Address LIKE \?\)/);
  assert.deepEqual(q.params, ["380 Dearborn Street%", "380 Dearborn%", "Pasadena"]);
  const evil = addressLookupQuery("1 x'; DROP TABLE rets_property;--", null);
  assert.ok(!evil.sql.includes("DROP"));
});

test("candidate pool: same type, price band, beds within one, never the target itself, capped", () => {
  const q = candidatePoolQuery(T);
  assert.match(q.sql, /L_ListingID <> \?/);
  assert.match(q.sql, /L_Type_ = \?/);
  assert.match(q.sql, /L_Keyword2 BETWEEN \? AND \?/);
  assert.match(q.sql, /LIMIT 5000$/);
  assert.deepEqual(q.params, ["100", "SingleFamilyResidence", 600000, 1400000, 2, 4, 1000000]);
  assert.ok(!/email|phone|SELECT \*/i.test(q.sql));
  assert.ok(!candidatePoolQuery({ ...T, beds: null }).sql.includes("L_Keyword2 BETWEEN"));
});

test("comp query: bounded on both ends, city and subtype, +/-20% size, bound params", () => {
  const q = compQuery({ kind: "city", city: "Pasadena" }, "SingleFamilyResidence", 1500, "2026-03-17", "2026-09-17");
  assert.match(q.sql, /CloseDate >= \? AND CloseDate <= \?/);
  assert.match(q.sql, /ROW_NUMBER\(\) OVER/);
  assert.deepEqual(q.params, ["Pasadena", "SingleFamilyResidence", 1200, 1800, "2026-03-17", "2026-09-17"]);
  const z = compQuery({ kind: "zip", zip: "91104" }, "Condominium", 1000, "2026-03-17", "2026-09-17");
  assert.match(z.sql, /LEFT\(PostalCode, 5\) = \?/);
  assert.ok(!z.sql.includes("City = ?"));
  assert.equal(z.params[0], "91104");
});

test("comp window is six months ending at the newest sale, not at today", () => {
  assert.deepEqual(compWindow("2026-09-17"), { start: "2026-03-17", end: "2026-09-17" });
});

// ---- scoring -----------------------------------------------------------------------------------
test("structured score: handbook weights with relative price", () => {
  const exact = structuredScore(T, { id: "1", city: "pasadena", price: 1020000, beds: 3, sqft: 1600 });
  assert.equal(exact.points, 60);
  const far = structuredScore(T, { id: "2", city: "Irvine", price: 1250000, beds: 2, sqft: 2400 });
  assert.equal(far.points, 5); // price within 30% only
  assert.equal(structuredScore({ ...T, price: 4000000 }, { id: "3", city: "Pasadena", price: 4050000, beds: 3, sqft: 1500 }).points, 60);
});

test("structured score: missing values earn nothing and never throw", () => {
  const s = structuredScore({ ...T, beds: null, sqft: null }, { id: "4", city: "Pasadena", price: 1000000, beds: null, sqft: null });
  assert.equal(s.points, 35);
});

test("percentile ranks spread a narrow band over 0..1 and share tied ranks", () => {
  assert.deepEqual(percentileRanks([0.71, 0.73, 0.75]), [0, 0.5, 1]);
  assert.deepEqual(percentileRanks([0.7, 0.7, 0.9]), [0.25, 0.25, 1]);
  assert.deepEqual(percentileRanks([0.5]), [1]);
});

test("the semantic half decides between otherwise equal listings", () => {
  const tv = normalize([1, 0, 0]);
  const vecs: Record<string, Float32Array> = { a: normalize([0.99, 0.14, 0]), b: normalize([0.98, 0.2, 0]), c: normalize([0.97, 0.24, 0]) };
  const mk = (id: string) => ({ id, city: "Pasadena", price: 1000000, beds: 3, sqft: 1500 });
  const ranked = rankCandidates(T, [mk("c"), mk("a"), mk("b")], tv, (id) => vecs[id] ?? null);
  assert.deepEqual(ranked.map((r) => r.candidate.id), ["a", "b", "c"]);
  assert.equal(ranked[0].total, 100); // 60 structured + 40 semantic
  assert.equal(ranked[2].total, 60);
});

test("without a target vector, ranking still works on structured score", () => {
  const ranked = rankCandidates(T, [{ id: "x", city: "Pasadena", price: 1000000, beds: 3, sqft: 1500 }], null, () => null);
  assert.equal(ranked[0].total, 60);
  assert.equal(ranked[0].similar, false);
});

// ---- comp validation --------------------------------------------------------------------------
test("price assessment: below, above, in line, too few comps, no division by zero", () => {
  const below = assessPrice(900000, 1500, { median_ppsf: "700", comp_count: 12 });
  assert.equal(Math.round(below.estimate!), 1050000);
  assert.ok(below.deltaPct! < -14 && below.deltaPct! > -14.5);
  assert.match(describeAssessment(below, 1500), /14\.3% below recent comparable sales/);
  assert.match(describeAssessment(assessPrice(1060000, 1500, { median_ppsf: 700, comp_count: 12 }), 1500), /in line with/);
  assert.match(describeAssessment(assessPrice(1200000, 1500, { median_ppsf: 700, comp_count: 6 }), 1500), /few comps/);
  assert.match(describeAssessment(assessPrice(900000, 1500, { median_ppsf: 700, comp_count: MIN_COMPS - 1 }), 1500), /not enough recent comparable sales/);
  assert.equal(assessPrice(900000, 1500, { median_ppsf: 0, comp_count: 20 }).deltaPct, null);
  assert.equal(assessPrice(900000, 1500, undefined).deltaPct, null);
  assert.match(describeAssessment(assessPrice(900000, null, undefined), null), /no square footage/);
});

// ---- full path with fake database ---------------------------------------------------------
const DIMS = 3;
const index = new VectorIndex(
  { model: "m", dims: DIMS, count: 4, createdAt: "" },
  ["100", "101", "102", "103"],
  Float32Array.from([...normalize([1, 0, 0]), ...normalize([0.99, 0.14, 0]), ...normalize([0.9, 0.44, 0]), ...normalize([0.2, 0.98, 0])]),
);
const cardRow = (id: string, price: number, extra: Record<string, unknown> = {}) => ({
  L_ListingID: id, L_Address: `${id} Oak St`, L_City: "Pasadena", L_Zip: "91101", L_SystemPrice: price, L_Keyword2: 3, LM_Dec_3: 2, LM_Int2_3: 1500,
  L_Type_: "SingleFamilyResidence", PhotoCount: 12, ...extra,
});

function fakeRun(opts: { addressRows?: any[]; comps?: any; zipComps?: any } = {}) {
  const log: string[] = [];
  const run = async (sql: string, params: (string | number)[]) => {
    log.push(sql);
    if (sql.includes("L_Address LIKE")) return opts.addressRows ?? [{ L_ListingID: 100, L_Address: "100 Oak St", L_City: "Pasadena", L_Zip: "91101" }];
    if (sql.includes("MIN(CloseDate)")) return [{ first_date: "2026-03-18", last_date: "2026-09-17" }];
    if (sql.includes("california_sold")) {
      if (/^\d{5}$/.test(String(params[0]))) return [opts.zipComps ?? { median_ppsf: "800", comp_count: 12 }];
      return [opts.comps ?? { median_ppsf: "700", comp_count: 14 }];
    }
    if (sql.includes("ORDER BY ABS")) return [
      { L_ListingID: 102, L_City: "Pasadena", L_SystemPrice: 1100000, L_Keyword2: 3, LM_Int2_3: 1550 },
      { L_ListingID: 101, L_City: "Pasadena", L_SystemPrice: 1010000, L_Keyword2: 3, LM_Int2_3: 1480 },
      { L_ListingID: 103, L_City: "Pasadena", L_SystemPrice: 1300000, L_Keyword2: 4, LM_Int2_3: 2400 },
    ];
    if (sql.includes("L_ListingID IN")) return params.map((p) => cardRow(String(p), p === "100" ? 1000000 : p === "101" ? 1010000 : p === "102" ? 1100000 : 1300000));
    return [];
  };
  return { run, log };
}

test("recommend by position: best match first, cards numbered, price checks, shown ids returned", async () => {
  const { run } = fakeRun();
  const r = await recommend("more like #2", run, index, { cities, lastShown: [{ n: 1, id: "555" }, { n: 2, id: "100" }] });
  assert.match(r.text, /Because you liked: 100 Oak St, Pasadena - \$1,000,000/);
  assert.ok(r.text.indexOf("101 Oak St") < r.text.indexOf("102 Oak St"), "closest first");
  assert.ok(r.text.indexOf("102 Oak St") < r.text.indexOf("103 Oak St"));
  assert.match(r.text, /Similar because: .*same city/);
  assert.ok(!/Match \d+/.test(r.text), "no misleading numeric match score");
  assert.match(r.text, /Price check: .*recent comparable sales/);
  assert.match(r.text, /sales through 2026-09-17/);
  assert.match(r.text, /not appraisals/);
  assert.ok(!r.text.includes("100 Oak St\n   3 bd") , "the target is not recommended to itself");
  assert.deepEqual(r.shown.map((s) => s.id), ["101", "102", "103"]);
});

test("recommend by address: one match proceeds, several ask which, none says not found", async () => {
  const ok = await recommend("more like 100 Oak Street", fakeRun().run, index, { cities });
  assert.match(ok.text, /Because you liked/);
  const many = await recommend("more like 100 Oak Street", fakeRun({ addressRows: [
    { L_ListingID: 1, L_Address: "100 Oak Street", L_City: "Pasadena", L_Zip: "91101" },
    { L_ListingID: 2, L_Address: "100 Oak Street", L_City: "Irvine", L_Zip: "92618" },
  ] }).run, index, { cities });
  assert.match(many.text, /Which do you mean/);
  assert.equal(many.shown.length, 0);
  const none = await recommend("more like 100 Oak Street", fakeRun({ addressRows: [] }).run, index, { cities });
  assert.match(none.text, /could not find an active listing/);
});

test("recommend: no recent list, unknown number, or nothing named", async () => {
  const { run, log } = fakeRun();
  assert.match((await recommend("more like #3", run, index, { cities })).text, /do not have a result #3/);
  assert.match((await recommend("hello", run, index, { cities })).text, /Tell me which listing you like/);
  assert.equal(log.length, 0, "no database calls without a target");
});

test("recommend: too few comps is reported, not guessed", async () => {
  const { run } = fakeRun({ comps: { median_ppsf: null, comp_count: null }, zipComps: { median_ppsf: null, comp_count: null } });
  const r = await recommend("more like #1", run, index, { cities, lastShown: [{ n: 1, id: "100" }] });
  assert.match(r.text, /not enough recent comparable sales/);
});

test("recommend: a listing with no embedding still gets structured matches and a note", async () => {
  const { run } = fakeRun();
  const r = await recommend("more like #1", run, index, { cities, lastShown: [{ n: 1, id: "999" }] });
  // 999 is not in the index (the fake DB returns it as a card) so semantic points are unavailable
  assert.match(r.text, /has no description to compare/);
});

test("price check prefers the ZIP code when it has enough sales, and says so", async () => {
  const r = await recommend("more like #1", fakeRun().run, index, { cities, lastShown: [{ n: 1, id: "100" }] });
  assert.match(r.text, /recent comparable sales in ZIP 91101 \(comps imply about \$1,200,000 at \$800\/sq ft, 12 sales\)/);
});

test("price check falls back to the city when the ZIP has few sales", async () => {
  const r = await recommend("more like #1", fakeRun({ zipComps: { median_ppsf: "800", comp_count: 6 } }).run, index, { cities, lastShown: [{ n: 1, id: "100" }] });
  assert.match(r.text, /recent comparable sales in Pasadena \(comps imply about \$1,050,000 at \$700\/sq ft, 14 sales\)/);
});
