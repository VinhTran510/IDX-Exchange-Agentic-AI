// Semantic search: optional structured filters (SQL) narrow the candidates, embeddings rank them.
import { parsePropertyQuery, type PropertyFilters } from "./parsePropertyQuery.ts";
import { buildActiveByIds, buildActiveIdSearch, MAX_CANDIDATE_IDS } from "./sqlBuilder.ts";
import { formatActiveCard } from "./listingCards.ts";
import { describeFilters, hasAnyFilter, type Run } from "./searchPipeline.ts";
import type { Embedder } from "./embeddingClient.ts";
import type { VectorIndex } from "./vectorIndex.ts";

export const TOP_K = 5;

export interface SemanticOptions {
  cities?: string[];
  k?: number;
}

export interface SemanticResult {
  filters: PropertyFilters;
  ran: boolean;
  text: string;
}

export async function semanticSearch(
  query: string,
  run: Run,
  embedder: Embedder,
  index: VectorIndex,
  opts: SemanticOptions = {},
): Promise<SemanticResult> {
  const filters = parsePropertyQuery(query, { cities: opts.cities });
  if (filters.warnings.length > 0) return { filters, ran: false, text: filters.warnings.join("\n") };
  if (index.meta.model !== embedder.model || index.meta.dims !== embedder.dims) {
    throw Object.assign(new Error("index and embedder differ"), { code: "INDEX_MISMATCH" });
  }

  // 1. Structured filters first (city, price, beds, ...) so results respect hard requirements.
  let allowed: Set<string> | undefined;
  if (hasAnyFilter(filters)) {
    const q = buildActiveIdSearch(filters);
    const rows = await run(q.sql, q.params);
    if (rows.length === 0) {
      return { filters, ran: true, text: "No active listings match those filters. Try loosening the price, size or area." };
    }
    allowed = new Set(rows.map((r) => String(r.L_ListingID)));
  }

  // 2. Rank by meaning.
  const queryVec = await embedder.embedQuery(query);
  const hits = index.topK(queryVec, opts.k ?? TOP_K, allowed);
  if (hits.length === 0) {
    return { filters, ran: true, text: "I could not find listings with descriptions matching that. The semantic index may not cover this area yet." };
  }

  // 3. Fetch the cards for the winners and keep the similarity order.
  const q = buildActiveByIds(hits.map((h) => h.id));
  const rows = await run(q.sql, q.params);
  const byId = new Map(rows.map((r) => [String(r.L_ListingID), r]));
  const cards = hits
    .map((h) => byId.get(h.id))
    .filter((r): r is Record<string, unknown> => r !== undefined)
    .map((r, i) => formatActiveCard(r, i + 1));
  if (cards.length === 0) return { filters, ran: true, text: "Those listings are no longer active. Please try again." };

  const note = allowed && allowed.size >= MAX_CANDIDATE_IDS ? " (searched the first 20,000 matching listings)" : "";
  const scope = hasAnyFilter(filters) ? describeFilters(filters) : "all active listings";
  return {
    filters,
    ran: true,
    text: `Searching: ${scope}${note}\nTop ${cards.length} listings by description similarity:\n\n${cards.join("\n\n")}`,
  };
}
