// Builds parameterized, read-only SQL from the structured filters.
// User-controlled values are ONLY ever passed as bound `?` params.
// LIMIT/OFFSET are integers we clamp ourselves.
import type { PropertyFilters } from "./parsePropertyQuery.ts";

export const MAX_ROWS = 50;
export const DEFAULT_PAGE_SIZE = 5;

export interface Query {
  sql: string;
  params: (string | number)[];
  countSql: string;
  countParams: (string | number)[];
}

export interface PageOptions {
  page?: number;
  limit?: number;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(max, Math.max(min, n));
}

function paging(opts: PageOptions): { limit: number; offset: number } {
  const limit = clampInt(opts.limit, DEFAULT_PAGE_SIZE, 1, MAX_ROWS);
  const page = clampInt(opts.page, 1, 1, 1000);
  // never reach past the 50-row cap
  const offset = Math.min((page - 1) * limit, MAX_ROWS - 1);
  return { limit: Math.min(limit, MAX_ROWS - offset), offset };
}

interface Cols {
  city: string;
  price: string;
  beds: string;
  baths: string;
  sqft: string;
  type: string;
}

function commonClauses(f: PropertyFilters, c: Cols, where: string[], params: (string | number)[]) {
  if (f.city) {
    where.push(`${c.city} = ?`);
    params.push(f.city);
  }
  if (f.minPrice != null) {
    where.push(`${c.price} >= ?`);
    params.push(f.minPrice);
  }
  if (f.maxPrice != null) {
    where.push(`${c.price} <= ?`);
    params.push(f.maxPrice);
  }
  if (f.beds != null) {
    where.push(`${c.beds} >= ?`);
    params.push(f.beds);
  }
  if (f.baths != null) {
    where.push(`${c.baths} >= ?`);
    params.push(f.baths);
  }
  if (f.sqft != null) {
    where.push(`${c.sqft} >= ?`);
    params.push(f.sqft);
  }
  if (f.types && f.types.length > 0) {
    where.push(`${c.type} IN (${f.types.map(() => "?").join(", ")})`);
    params.push(...f.types);
  }
}

// Pool/view flags: '1' = yes; '' or NULL = no.
function flag(col: string, value: boolean | null, where: string[]) {
  if (value === true) where.push(`${col} = '1'`);
  else if (value === false) where.push(`(${col} IS NULL OR ${col} = '')`);
}

function finish(
  select: string,
  table: string,
  where: string[],
  params: (string | number)[],
  orderBy: string,
  opts: PageOptions,
): Query {
  const { limit, offset } = paging(opts);
  const whereSql = where.join(" AND ");
  return {
    sql: `SELECT ${select} FROM ${table} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    params: [...params],
    countSql: `SELECT COUNT(*) AS total FROM ${table} WHERE ${whereSql}`,
    countParams: [...params],
  };
}

/** Active listings from rets_property. No agent email/phone columns are selected. */
export function buildActiveSearch(f: PropertyFilters, opts: PageOptions = {}): Query {
  const where = [`L_Status = 'Active'`];
  const params: (string | number)[] = [];
  commonClauses(
    f,
    {
      city: "L_City",
      price: "L_SystemPrice",
      beds: "L_Keyword2",
      baths: "LM_Dec_3",
      sqft: "LM_Int2_3",
      type: "L_Type_",
    },
    where,
    params,
  );
  flag("PoolPrivateYN", f.pool, where);
  flag("ViewYN", f.hasView, where);
  if (f.maxHoa != null) {
    if (f.maxHoa === 0) where.push(`(AssociationFee IS NULL OR AssociationFee = 0)`);
    else {
      where.push(`(AssociationFee IS NULL OR AssociationFee <= ?)`);
      params.push(f.maxHoa);
    }
  }
  return finish(
    `L_City, L_SystemPrice, L_Keyword2, LM_Dec_3, LM_Int2_3, L_Type_, PoolPrivateYN, ViewYN, AssociationFee`,
    "rets_property",
    where,
    params,
    "L_SystemPrice ASC",
    opts,
  );
}

/** Closed sales from california_sold. CloseDate is text, so compare as YYYY-MM-DD strings. */
export function buildSoldSearch(
  f: PropertyFilters,
  opts: PageOptions & { months?: number } = {},
): Query {
  const where = [`PropertyType = 'Residential'`, `ClosePrice > 0`, `CloseDate <= DATE_FORMAT(CURDATE(), '%Y-%m-%d')`];
  const params: (string | number)[] = [];
  if (opts.months != null) {
    const months = clampInt(opts.months, 6, 1, 24);
    where.push(`CloseDate >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL ${months} MONTH), '%Y-%m-%d')`);
  }
  commonClauses(
    f,
    {
      city: "City",
      price: "ClosePrice",
      beds: "BedroomsTotal",
      baths: "BathroomsTotalInteger",
      sqft: "LivingArea",
      type: "PropertySubType",
    },
    where,
    params,
  );
  // The sold table has no reliable pool/view/HOA columns we trust, so those filters are ignored here.
  return finish(
    `City, ClosePrice, ListPrice, BedroomsTotal, BathroomsTotalInteger, LivingArea, PropertySubType, CloseDate`,
    "california_sold",
    where,
    params,
    "CloseDate DESC",
    opts,
  );
}
