// Glue: free text -> filters -> SQL -> formatted cards. `run` is injected so tests need no database.
import { parsePropertyQuery, type PropertyFilters } from "./parsePropertyQuery.ts";
import { buildActiveSearch, buildSoldSearch, DEFAULT_PAGE_SIZE } from "./sqlBuilder.ts";
import { formatResults, type Row } from "./listingCards.ts";

export type Run = (sql: string, params: (string | number)[]) => Promise<Row[]>;

export interface SearchOptions {
  source?: "active" | "sold";
  page?: number;
  limit?: number;
  cities?: string[];
}

export interface SearchResult {
  filters: PropertyFilters;
  ran: boolean;
  total: number;
  text: string;
}

export function hasAnyFilter(f: PropertyFilters): boolean {
  return (
    f.city != null || f.minPrice != null || f.maxPrice != null || f.beds != null || f.baths != null ||
    f.sqft != null || (f.types != null && f.types.length > 0) || f.pool != null || f.hasView != null || f.maxHoa != null
  );
}

export function describeFilters(f: PropertyFilters): string {
  const parts: string[] = [];
  if (f.city) parts.push(f.city);
  if (f.types?.length) parts.push(f.types.join("/"));
  if (f.beds != null) parts.push(`${f.beds}+ bed`);
  if (f.baths != null) parts.push(`${f.baths}+ bath`);
  if (f.sqft != null) parts.push(`${f.sqft}+ sqft`);
  if (f.minPrice != null) parts.push(`min $${f.minPrice.toLocaleString("en-US")}`);
  if (f.maxPrice != null) parts.push(`max $${f.maxPrice.toLocaleString("en-US")}`);
  if (f.pool != null) parts.push(f.pool ? "pool" : "no pool");
  if (f.hasView != null) parts.push(f.hasView ? "view" : "no view");
  if (f.maxHoa != null) parts.push(f.maxHoa === 0 ? "no HOA" : `HOA <= $${f.maxHoa}`);
  return parts.length ? parts.join(", ") : "(none)";
}

export async function runSearch(query: string, run: Run, opts: SearchOptions = {}): Promise<SearchResult> {
  const filters = parsePropertyQuery(query, { cities: opts.cities });
  const source = opts.source ?? "active";

  if (filters.warnings.length > 0) {
    return { filters, ran: false, total: 0, text: filters.warnings.join("\n") };
  }
  if (!hasAnyFilter(filters)) {
    return { filters, ran: false, total: 0, text: "I couldn't find any search criteria. Tell me a city, price range, or number of bedrooms." };
  }

  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const page = opts.page ?? 1;
  const q = source === "sold" ? buildSoldSearch(filters, { page, limit }) : buildActiveSearch(filters, { page, limit });

  const [countRows, rows] = await Promise.all([run(q.countSql, q.countParams), run(q.sql, q.params)]);
  const total = Number(countRows[0]?.total ?? 0);
  return { filters, ran: true, total, text: formatResults(rows, total, source, page, limit) };
}
