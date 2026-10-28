// Runs the market queries and turns the numbers into a short, honest text report.
import type { Run } from "./searchPipeline.ts";
import {
  activeCountQuery, dataRangeQuery, medianDomQuery, medianPpsfQuery, medianPriceQuery, medianRatioQuery,
  monthlyDomQuery, monthlyMedianQuery, summaryQuery, type Built, type MarketScope,
} from "./marketQueries.ts";

export const MIN_SALES = 10; // below this we refuse to report statistics
export const SMALL_SAMPLE = 30; // below this we add a caution

export interface MonthRow {
  month: string; // YYYY-MM
  medianPrice: number;
  sales: number;
  avgDom: number | null;
}

export interface MarketData {
  n: number;
  avgPrice: number | null;
  avgDom: number | null;
  medianPrice: number | null;
  medianDom: number | null;
  medianPpsf: number | null;
  medianRatio: number | null;
  months: MonthRow[];
  active: number | null;
  firstDate: string | null; // whole-table coverage
  lastDate: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function loadMarketData(scope: MarketScope, run: Run): Promise<MarketData> {
  const go = (q: Built) => run(q.sql, q.params);
  const [summary] = await go(summaryQuery(scope));
  const n = num(summary?.n) ?? 0;
  const base = { n, avgPrice: num(summary?.avg_price), avgDom: num(summary?.avg_dom) };
  const range = (await go(dataRangeQuery()))[0];
  const firstDate = range?.first_date ? String(range.first_date) : null;
  const lastDate = range?.last_date ? String(range.last_date) : null;

  if (n < MIN_SALES) {
    return { ...base, medianPrice: null, medianDom: null, medianPpsf: null, medianRatio: null, months: [], active: null, firstDate, lastDate };
  }

  const [price, dom, ppsf, ratio, monthly, monthlyDom, active] = await Promise.all([
    go(medianPriceQuery(scope)), go(medianDomQuery(scope)), go(medianPpsfQuery(scope)), go(medianRatioQuery(scope)),
    go(monthlyMedianQuery(scope)), go(monthlyDomQuery(scope)), go(activeCountQuery(scope)),
  ]);
  const domByMonth = new Map(monthlyDom.map((r) => [String(r.month), num(r.avg_dom)]));
  const months: MonthRow[] = monthly.map((r) => ({
    month: String(r.month),
    medianPrice: Number(r.median_price),
    sales: Number(r.sales),
    avgDom: domByMonth.get(String(r.month)) ?? null,
  }));
  return {
    ...base,
    medianPrice: num(price[0]?.median), medianDom: num(dom[0]?.median), medianPpsf: num(ppsf[0]?.median), medianRatio: num(ratio[0]?.median),
    months, active: num(active[0]?.active), firstDate, lastDate,
  };
}

// ---- formatting ------------------------------------------------------------------
const money = (n: number | null) => (n == null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`);

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** A month is partial if the data starts or stops inside it. */
export function isPartialMonth(month: string, firstDate: string | null, lastDate: string | null): boolean {
  if (firstDate && firstDate.slice(0, 7) === month && Number(firstDate.slice(8, 10)) > 1) return true;
  if (lastDate && lastDate.slice(0, 7) === month && lastDate < lastDayOfMonth(month)) return true;
  return false;
}

export function describeScope(scope: MarketScope): string {
  const place = scope.zip ? `ZIP ${scope.zip}` : (scope.city ?? "California");
  const types = scope.types && scope.types.length > 0 ? ` (${scope.types.join("/")})` : " (all residential types)";
  return `${place}${types}`;
}

export function formatMarketReport(scope: MarketScope, d: MarketData): string {
  const lines: string[] = [];
  lines.push(`Market summary: ${describeScope(scope)}`);
  const covers = d.firstDate && d.lastDate ? `Sold data covers ${d.firstDate} to ${d.lastDate}.` : "";

  if (d.n < MIN_SALES) {
    lines.push(`Only ${d.n} recorded sales, which is not enough for reliable statistics (need at least ${MIN_SALES}).`);
    if (covers) lines.push(covers);
    return lines.join("\n");
  }

  lines.push(`Based on ${d.n.toLocaleString("en-US")} sales. ${covers}`.trim());
  if (d.n < SMALL_SAMPLE) lines.push(`Caution: small sample (${d.n} sales), so treat these numbers as rough.`);
  lines.push("");
  lines.push(`Median price: ${money(d.medianPrice)} (average ${money(d.avgPrice)})`);
  lines.push(`Median price per sq ft: ${money(d.medianPpsf)}`);
  lines.push(`Days on market: median ${d.medianDom != null ? Math.round(d.medianDom) : "n/a"} (average ${d.avgDom ?? "n/a"})`);
  if (d.medianRatio != null) {
    lines.push(`List-to-close: median ${(d.medianRatio * 100).toFixed(1)}% (100% means homes close at list price)`);
  }

  const complete = d.months.filter((m) => !isPartialMonth(m.month, d.firstDate, d.lastDate));
  if (d.months.length > 0) {
    lines.push("", "Monthly trend (median price | sales | avg days on market):");
    for (const m of d.months) {
      const partial = isPartialMonth(m.month, d.firstDate, d.lastDate) ? " (partial month)" : "";
      lines.push(`${m.month}${partial}: ${money(m.medianPrice)} | ${m.sales} sales | ${m.avgDom ?? "n/a"} days`);
    }
  }
  if (complete.length >= 2) {
    const [prev, last] = complete.slice(-2);
    const pct = ((last.medianPrice - prev.medianPrice) / prev.medianPrice) * 100;
    lines.push(`Month over month (${prev.month} to ${last.month}, complete months): ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% median price`);
    lines.push("Note: median price moves month to month partly because of which homes happened to sell, so small or large swings are not necessarily price changes.");
  }
  lines.push(`Year over year: not available, since the data covers only ${d.months.length} month${d.months.length === 1 ? "" : "s"}.`);

  if (d.active != null) {
    const avgSales = complete.length > 0 ? complete.reduce((s, m) => s + m.sales, 0) / complete.length : 0;
    let supply = "";
    if (avgSales > 0) supply = `, roughly ${(d.active / avgSales).toFixed(1)} months of supply at the recent sales pace`;
    lines.push("", `Active listings now: ${d.active}${supply}. (Rough: active listings are current, sold data ends ${d.lastDate ?? "earlier"}.)`);
  }
  return lines.join("\n");
}

// ---- question -> scope -> report ---------------------------------------------------
import { parsePropertyQuery } from "./parsePropertyQuery.ts";

export function scopeFromQuestion(question: string, cities: string[] = []): { scope: MarketScope; warnings: string[] } {
  const f = parsePropertyQuery(question, { cities });
  const zip = /\b(9\d{4})\b/.exec(question)?.[1] ?? null;
  return { scope: { city: zip ? null : f.city, zip, types: f.types }, warnings: f.warnings };
}

export async function answerMarketQuestion(question: string, run: Run, cities: string[] = []): Promise<string> {
  const { scope, warnings } = scopeFromQuestion(question, cities);
  if (warnings.length > 0) return warnings.join("\n");
  if (!scope.city && !scope.zip) return "Which California city or ZIP code do you want market statistics for?";
  return formatMarketReport(scope, await loadMarketData(scope, run));
}
