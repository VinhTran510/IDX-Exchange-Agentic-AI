import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerMarketQuestion, formatMarketReport, isPartialMonth, loadMarketData, MIN_SALES, scopeFromQuestion, type MarketData,
} from "../src/marketReport.ts";
import { activeCountQuery, medianPriceQuery, monthlyMedianQuery, summaryQuery } from "../src/marketQueries.ts";

const cities = ["Irvine", "Pasadena"];
const scope = { city: "Irvine", zip: null, types: null };

test("city and zip are bound params, never part of the SQL", () => {
  const q = summaryQuery({ city: "x'; DROP TABLE california_sold;--", zip: "92618", types: ["Condominium", "Townhouse"] });
  assert.ok(!q.sql.includes("DROP"));
  assert.match(q.sql, /City = \?/);
  assert.match(q.sql, /LEFT\(PostalCode, 5\) = \?/);
  assert.match(q.sql, /PropertySubType IN \(\?, \?\)/);
  assert.equal(q.params.length, 4);
});

test("every sold query excludes future close dates and bad prices", () => {
  for (const q of [summaryQuery(scope), medianPriceQuery(scope), monthlyMedianQuery(scope)]) {
    assert.match(q.sql, /CloseDate <= DATE_FORMAT\(CURDATE\(\)/);
    assert.match(q.sql, /ClosePrice > 0/);
    assert.match(q.sql, /FROM california_sold/);
  }
  assert.match(activeCountQuery(scope).sql, /FROM rets_property WHERE L_Status = 'Active'/);
});

test("medians use window functions (MySQL has no MEDIAN)", () => {
  assert.match(medianPriceQuery(scope).sql, /ROW_NUMBER\(\) OVER/);
});

test("partial months are detected at both ends of the data", () => {
  assert.equal(isPartialMonth("2026-03", "2026-03-18", "2026-09-17"), true);
  assert.equal(isPartialMonth("2026-09", "2026-03-18", "2026-09-17"), true);
  assert.equal(isPartialMonth("2026-05", "2026-03-18", "2026-09-17"), false);
  assert.equal(isPartialMonth("2026-04", "2026-04-01", "2026-09-30"), false);
});

const data: MarketData = {
  n: 120, avgPrice: 1500000, avgDom: 31.2, medianPrice: 1400000, medianDom: 24, medianPpsf: 810, medianRatio: 0.992,
  months: [
    { month: "2026-03", medianPrice: 1300000, sales: 10, avgDom: 30 },
    { month: "2026-04", medianPrice: 1350000, sales: 30, avgDom: 28 },
    { month: "2026-05", medianPrice: 1400000, sales: 31, avgDom: 27 },
    { month: "2026-09", medianPrice: 900000, sales: 12, avgDom: 20 },
  ],
  active: 60, firstDate: "2026-03-18", lastDate: "2026-09-17",
};

test("report labels partial months, gives MoM on complete months only, and says YoY is unavailable", () => {
  const text = formatMarketReport(scope, data);
  assert.match(text, /2026-03 \(partial month\)/);
  assert.match(text, /2026-09 \(partial month\)/);
  assert.match(text, /Month over month \(2026-04 to 2026-05, complete months\): \+3\.7% median price/);
  assert.match(text, /Year over year: not available/);
  assert.match(text, /99\.2%/);
  assert.match(text, /Sold data covers 2026-03-18 to 2026-09-17/);
});

test("too few sales: refuses to give statistics", () => {
  const text = formatMarketReport(scope, { ...data, n: MIN_SALES - 1, medianPrice: null });
  assert.match(text, /not enough for reliable statistics/);
  assert.ok(!/Median price:/.test(text));
});

test("small samples get a caution", () => {
  assert.match(formatMarketReport(scope, { ...data, n: 15 }), /Caution: small sample/);
});

test("question parsing: city, zip, type, and 'at least' is not a city", () => {
  assert.equal(scopeFromQuestion("median price in Pasadena", cities).scope.city, "Pasadena");
  const z = scopeFromQuestion("how fast do homes sell in 92618", cities).scope;
  assert.equal(z.zip, "92618");
  assert.equal(z.city, null);
  assert.ok(scopeFromQuestion("condos in Irvine", cities).scope.types?.length);
  assert.equal(scopeFromQuestion("at least 3 beds", cities).scope.city, null);
});

test("no place named: asks for one without touching the database", async () => {
  let calls = 0;
  const out = await answerMarketQuestion("is now a good time to buy?", async () => (calls++, []), cities);
  assert.equal(calls, 0);
  assert.match(out, /Which California city or ZIP/);
});

test("tiny city: only the summary query runs", async () => {
  const seen: string[] = [];
  const run = async (sql: string) => {
    seen.push(sql);
    if (sql.includes("MIN(CloseDate)")) return [{ first_date: "2026-03-18", last_date: "2026-09-17" }];
    return [{ n: 3, avg_price: 500000, avg_dom: 10 }];
  };
  const d = await loadMarketData(scope, run);
  assert.equal(d.n, 3);
  assert.ok(!seen.some((s) => s.includes("ROW_NUMBER")));
});

test("full path with a fake database", async () => {
  const run = async (sql: string) => {
    if (sql.includes("MIN(CloseDate)")) return [{ first_date: "2026-03-18", last_date: "2026-09-17" }];
    if (sql.startsWith("SELECT COUNT(*) AS n")) return [{ n: 120, avg_price: "1500000", avg_dom: "31.2" }];
    if (sql.includes("PARTITION BY")) return [{ month: "2026-04", median_price: "1350000", sales: 30 }, { month: "2026-05", median_price: "1400000", sales: 31 }];
    if (sql.includes("GROUP BY LEFT(CloseDate, 7)")) return [{ month: "2026-04", avg_dom: "28" }, { month: "2026-05", avg_dom: "27" }];
    if (sql.includes("rets_property")) return [{ active: 40 }];
    if (sql.includes("ClosePrice / LivingArea")) return [{ median: "810" }];
    if (sql.includes("ClosePrice / ListPrice")) return [{ median: "0.99" }];
    if (sql.includes("DaysOnMarket AS v")) return [{ median: "24" }];
    return [{ median: "1400000" }];
  };
  const out = await answerMarketQuestion("median price in Irvine", run, cities);
  assert.match(out, /Median price: \$1,400,000/);
  assert.match(out, /months of supply/);
});
