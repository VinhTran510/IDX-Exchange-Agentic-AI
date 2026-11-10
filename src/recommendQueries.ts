// Parameterized, read-only SQL for the recommendation engine.
// Everything that comes from the user or from listing data is a bound `?` param. LIMITs are constants.
import type { Built } from "./marketQueries.ts";

export const POOL_LIMIT = 5000;
export const PRICE_BAND = 0.4; // candidates within +/-40% of the target's price

export interface Target {
  id: string;
  city: string;
  type: string;
  price: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
}

const SUFFIXES = /\s+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway)\.?$/i;

/** Escape LIKE wildcards so user text cannot act as a pattern. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Find active listings by street address. L_Address stores "380 Dearborn Street" or sometimes just "3945 Blanche",
 * so we try the text as typed and with a trailing street suffix removed. Prefix match, at most 6 rows.
 */
export function addressLookupQuery(street: string, city: string | null): Built {
  const typed = street.trim();
  const bare = typed.replace(SUFFIXES, "").trim();
  const patterns = [...new Set([typed, bare])].filter((p) => p.length > 0);
  const where = [`L_Status = 'Active'`, `(${patterns.map(() => "L_Address LIKE ?").join(" OR ")})`];
  const params: (string | number)[] = patterns.map((p) => `${escapeLike(p)}%`);
  if (city) {
    where.push(`L_City = ?`);
    params.push(city);
  }
  return {
    sql: `SELECT L_ListingID, L_Address, L_City, L_Zip, L_SystemPrice, L_Keyword2 FROM rets_property WHERE ${where.join(" AND ")} LIMIT 6`,
    params,
  };
}

/** Comparable candidates: same property type, price within the band, bedrooms within one. Closest price first. */
export function candidatePoolQuery(t: Target): Built {
  const where = [`L_Status = 'Active'`, `L_ListingID <> ?`, `L_Type_ = ?`, `L_SystemPrice BETWEEN ? AND ?`];
  const params: (string | number)[] = [t.id, t.type, Math.floor(t.price * (1 - PRICE_BAND)), Math.ceil(t.price * (1 + PRICE_BAND))];
  if (t.beds != null && t.beds > 0) {
    where.push(`L_Keyword2 BETWEEN ? AND ?`);
    params.push(t.beds - 1, t.beds + 1);
  }
  params.push(t.price);
  return {
    sql:
      `SELECT L_ListingID, L_City, L_SystemPrice, L_Keyword2, LM_Int2_3 FROM rets_property ` +
      `WHERE ${where.join(" AND ")} ORDER BY ABS(L_SystemPrice - ?) LIMIT ${POOL_LIMIT}`,
    params,
  };
}

export type CompArea = { kind: "zip"; zip: string } | { kind: "city"; city: string };

/**
 * Recent comparable sales: same area (ZIP code or city) and property subtype, living area within +/-20%,
 * close date inside the window. Returns the MEDIAN price per sq ft (MySQL has no MEDIAN, so window functions)
 * and how many comps it rests on.
 */
export function compQuery(area: CompArea, subtype: string, sqft: number, windowStart: string, windowEnd: string): Built {
  const areaClause = area.kind === "zip" ? `LEFT(PostalCode, 5) = ?` : `City = ?`;
  return {
    sql:
      `SELECT AVG(v) AS median_ppsf, MAX(cnt) AS comp_count FROM (` +
      `SELECT ClosePrice / LivingArea AS v, ROW_NUMBER() OVER (ORDER BY ClosePrice / LivingArea) AS rn, COUNT(*) OVER () AS cnt ` +
      `FROM california_sold WHERE PropertyType = 'Residential' AND ${areaClause} AND PropertySubType = ? ` +
      `AND ClosePrice > 0 AND LivingArea BETWEEN ? AND ? AND CloseDate >= ? AND CloseDate <= ?) t ` +
      `WHERE rn IN (FLOOR((cnt + 1) / 2), FLOOR((cnt + 2) / 2))`,
    params: [area.kind === "zip" ? area.zip : area.city, subtype, Math.floor(sqft * 0.8), Math.ceil(sqft * 1.2), windowStart, windowEnd],
  };
}
