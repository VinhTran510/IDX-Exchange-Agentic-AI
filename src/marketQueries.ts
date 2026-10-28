// Parameterized SQL for market statistics on california_sold (read-only).
// Only values from the user (city, zip, types) are bound `?` params; every SQL fragment below is a constant.
export interface MarketScope {
  city: string | null;
  zip: string | null; // 5 digits
  types: string[] | null; // PropertySubType values
}

export interface Built {
  sql: string;
  params: (string | number)[];
}

// Data-quality rules, from checking the real table before writing any statistics.
const VALID_DOM = "DaysOnMarket BETWEEN 0 AND 730";
const VALID_RATIO = "ListPrice > 0 AND ClosePrice / ListPrice BETWEEN 0.5 AND 2";
const VALID_AREA = "LivingArea > 0";

function soldWhere(scope: MarketScope, extra?: string): { where: string; params: (string | number)[] } {
  const where = [
    `PropertyType = 'Residential'`,
    `ClosePrice > 0`,
    `CloseDate >= '2000-01-01'`, // CloseDate is text; some rows are in the far future, so bound both ends
    `CloseDate <= DATE_FORMAT(CURDATE(), '%Y-%m-%d')`,
  ];
  const params: (string | number)[] = [];
  if (scope.city) {
    where.push(`City = ?`);
    params.push(scope.city);
  }
  if (scope.zip) {
    where.push(`LEFT(PostalCode, 5) = ?`);
    params.push(scope.zip);
  }
  if (scope.types && scope.types.length > 0) {
    where.push(`PropertySubType IN (${scope.types.map(() => "?").join(", ")})`);
    params.push(...scope.types);
  }
  if (extra) where.push(extra);
  return { where: where.join(" AND "), params };
}

/** Overall counts and averages. */
export function summaryQuery(scope: MarketScope): Built {
  const { where, params } = soldWhere(scope);
  return {
    sql:
      `SELECT COUNT(*) AS n, ROUND(AVG(ClosePrice)) AS avg_price, ` +
      `ROUND(AVG(CASE WHEN ${VALID_DOM} THEN DaysOnMarket END), 1) AS avg_dom ` +
      `FROM california_sold WHERE ${where}`,
    params,
  };
}

function medianQuery(scope: MarketScope, expr: string, cond?: string): Built {
  const { where, params } = soldWhere(scope, cond);
  return {
    sql:
      `SELECT AVG(v) AS median FROM (` +
      `SELECT ${expr} AS v, ROW_NUMBER() OVER (ORDER BY ${expr}) AS rn, COUNT(*) OVER () AS cnt ` +
      `FROM california_sold WHERE ${where}) t ` +
      `WHERE rn IN (FLOOR((cnt + 1) / 2), FLOOR((cnt + 2) / 2))`,
    params,
  };
}

export const medianPriceQuery = (s: MarketScope) => medianQuery(s, "ClosePrice");
export const medianDomQuery = (s: MarketScope) => medianQuery(s, "DaysOnMarket", VALID_DOM);
export const medianPpsfQuery = (s: MarketScope) => medianQuery(s, "ClosePrice / LivingArea", VALID_AREA);
export const medianRatioQuery = (s: MarketScope) => medianQuery(s, "ClosePrice / ListPrice", VALID_RATIO);

/** Monthly median close price and sales count. */
export function monthlyMedianQuery(scope: MarketScope): Built {
  const { where, params } = soldWhere(scope);
  return {
    sql:
      `SELECT month, AVG(ClosePrice) AS median_price, MAX(cnt) AS sales FROM (` +
      `SELECT LEFT(CloseDate, 7) AS month, ClosePrice, ` +
      `ROW_NUMBER() OVER (PARTITION BY LEFT(CloseDate, 7) ORDER BY ClosePrice) AS rn, ` +
      `COUNT(*) OVER (PARTITION BY LEFT(CloseDate, 7)) AS cnt ` +
      `FROM california_sold WHERE ${where}) t ` +
      `WHERE rn IN (FLOOR((cnt + 1) / 2), FLOOR((cnt + 2) / 2)) GROUP BY month ORDER BY month`,
    params,
  };
}

/** Monthly average days on market. */
export function monthlyDomQuery(scope: MarketScope): Built {
  const { where, params } = soldWhere(scope, VALID_DOM);
  return {
    sql:
      `SELECT LEFT(CloseDate, 7) AS month, ROUND(AVG(DaysOnMarket), 1) AS avg_dom ` +
      `FROM california_sold WHERE ${where} GROUP BY LEFT(CloseDate, 7) ORDER BY month`,
    params,
  };
}

/** Active listings for the same area, for the supply comparison. */
export function activeCountQuery(scope: MarketScope): Built {
  const where = [`L_Status = 'Active'`];
  const params: (string | number)[] = [];
  if (scope.city) {
    where.push(`L_City = ?`);
    params.push(scope.city);
  }
  if (scope.zip) {
    where.push(`LEFT(L_Zip, 5) = ?`);
    params.push(scope.zip);
  }
  if (scope.types && scope.types.length > 0) {
    where.push(`L_Type_ IN (${scope.types.map(() => "?").join(", ")})`);
    params.push(...scope.types);
  }
  return { sql: `SELECT COUNT(*) AS active FROM rets_property WHERE ${where.join(" AND ")}`, params };
}

/** First and last valid close date in the whole table: what period does the data cover? */
export function dataRangeQuery(): Built {
  return {
    sql:
      `SELECT MIN(CloseDate) AS first_date, MAX(CloseDate) AS last_date FROM california_sold ` +
      `WHERE PropertyType = 'Residential' AND CloseDate >= '2000-01-01' ` +
      `AND CloseDate <= DATE_FORMAT(CURDATE(), '%Y-%m-%d')`,
    params: [],
  };
}
