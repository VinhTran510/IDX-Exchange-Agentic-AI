import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePropertyQuery } from "../src/parsePropertyQuery.ts";
import { buildActiveSearch, buildSoldSearch, MAX_ROWS } from "../src/sqlBuilder.ts";
import { runSearch } from "../src/searchPipeline.ts";

const f = (q: string) => parsePropertyQuery(q, { cities: ["Palm Desert", "Irvine"] });

test("pool + city + price uses bound params only", () => {
  const q = buildActiveSearch(f("3 bed condos in Palm Desert under 1.5M with a pool"));
  assert.match(q.sql, /L_City = \?/);
  assert.match(q.sql, /PoolPrivateYN = '1'/);
  assert.ok(q.params.includes("Palm Desert"));
  assert.ok(q.params.includes(1500000));
  assert.ok(!q.sql.includes("Palm Desert"), "user text must not appear in SQL");
});

test("no pool matches NULL or empty", () => {
  const q = buildActiveSearch(f("homes in Irvine with no pool"));
  assert.match(q.sql, /\(PoolPrivateYN IS NULL OR PoolPrivateYN = ''\)/);
});

test("no HOA treats NULL and 0 as no HOA", () => {
  const q = buildActiveSearch(f("homes in Irvine with no HOA"));
  assert.match(q.sql, /AssociationFee IS NULL OR AssociationFee = 0/);
});

test("multiple types use IN with one placeholder each", () => {
  const filters = { ...f("homes in Irvine"), types: ["A", "B", "C"] };
  const q = buildActiveSearch(filters);
  assert.match(q.sql, /L_Type_ IN \(\?, \?, \?\)/);
});

test("limit and page are clamped to the 50-row cap", () => {
  const q = buildActiveSearch(f("homes in Irvine"), { limit: 9999, page: 9999 });
  const lim = Number(/LIMIT (\d+)/.exec(q.sql)![1]);
  const off = Number(/OFFSET (\d+)/.exec(q.sql)![1]);
  assert.ok(lim >= 1 && off + lim <= MAX_ROWS);
});

test("injection text stays out of SQL", () => {
  const filters = { ...f("homes in Irvine"), city: "x'; DROP TABLE rets_property;--" };
  const q = buildActiveSearch(filters);
  assert.ok(!q.sql.includes("DROP"));
  assert.ok(q.params.includes(filters.city));
});

test("sold query excludes future close dates and bad prices", () => {
  const q = buildSoldSearch(f("homes in Irvine"));
  assert.match(q.sql, /CloseDate <= DATE_FORMAT\(CURDATE\(\)/);
  assert.match(q.sql, /ClosePrice > 0/);
  assert.match(q.sql, /FROM california_sold/);
});

test("no contact columns are selected", () => {
  for (const q of [buildActiveSearch(f("homes in Irvine")), buildSoldSearch(f("homes in Irvine"))]) {
    assert.ok(!/email|phone|SELECT \*/i.test(q.sql));
  }
});

test("runSearch skips the database when there is nothing to search or a warning", async () => {
  let calls = 0;
  const run = async () => (calls++, []);
  const a = await runSearch("hello there", run);
  const b = await runSearch("vacant land in Irvine", run, { cities: ["Irvine"] });
  assert.equal(calls, 0);
  assert.equal(a.ran, false);
  assert.equal(b.ran, false);
});

test("runSearch formats cards without contact info", async () => {
  const run = async (sql: string) =>
    sql.startsWith("SELECT COUNT")
      ? [{ total: 1 }]
      : [{ L_City: "Irvine", L_SystemPrice: 900000, L_Keyword2: 3, LM_Dec_3: 2, LM_Int2_3: 1500, L_Type_: "Condominium", PoolPrivateYN: "1", ViewYN: "", AssociationFee: null }];
  const r = await runSearch("3 bed in Irvine", run, { cities: ["Irvine"] });
  assert.match(r.text, /\$900,000/);
  assert.match(r.text, /Pool/);
  assert.match(r.text, /Showing 1-1 of 1/);
});
