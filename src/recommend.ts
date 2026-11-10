// Recommendation engine: structured similarity + description similarity, then a price check against sold comps.
import type { Run } from "./searchPipeline.ts";
import type { VectorIndex } from "./vectorIndex.ts";
import { buildActiveByIds } from "./sqlBuilder.ts";
import { dataRangeQuery } from "./marketQueries.ts";
import { addressLookupQuery, candidatePoolQuery, compQuery, type Target } from "./recommendQueries.ts";
import { formatActiveCard, type Row } from "./listingCards.ts";

export const TOP_N = 5;
export const MIN_COMPS = 5; // below this, no price assessment
export const FEW_COMPS = 10; // below this, a caution
export const COMP_WINDOW_MONTHS = 6;

// ---- who is the user pointing at? ------------------------------------------------------
export type TargetRef =
  | { kind: "position"; n: number }
  | { kind: "address"; street: string; city: string | null }
  | { kind: "none" };

const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5,
  sixth: 6, "6th": 6, seventh: 7, "7th": 7, eighth: 8, "8th": 8, ninth: 9, "9th": 9, tenth: 10, "10th": 10,
};

export function parseTarget(text: string, cities: string[] = []): TargetRef {
  const pos = /(?:#|\bnumber\s+|\bno\.?\s*|\boption\s+|\bresult\s+|\blisting\s+|\bhome\s+|\bone\s+)(\d{1,2})\b/i.exec(text);
  if (pos) return { kind: "position", n: Number(pos[1]) };
  const ord = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\b/i.exec(text);
  if (ord) return { kind: "position", n: ORDINALS[ord[1].toLowerCase()] };

  const like = /\b(?:like|similar to|similar|resembling)\s+(.+)$/i.exec(text);
  let candidate = (like ? like[1] : text).trim();
  if (!like && /\b(bed|beds|bedroom|bedrooms|bath|baths|bd|ba|sqft|under|over|below|above)\b/i.test(candidate)) return { kind: "none" };

  // "380 Dearborn Street, Pasadena, CA 91104" or "380 Dearborn Street in Pasadena"
  candidate = candidate.replace(/[.?!]+$/, "");
  const m = /^(\d{1,6}\s+[A-Za-z0-9][^,]*?)(?:\s+in\s+([^,]+)|,\s*(.*))?$/i.exec(candidate);
  if (!m) return { kind: "none" };
  const street = m[1].replace(/\s+(?:CA|California)\b.*$/i, "").replace(/\s+\d{5}(?:-\d{4})?$/, "").trim();
  const rest = `${m[2] ?? ""} ${m[3] ?? ""}`.trim();
  let city: string | null = null;
  if (rest) {
    const sorted = [...cities].sort((a, b) => b.length - a.length);
    city = sorted.find((c) => new RegExp(String.raw`\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "i").test(rest)) ?? null;
  }
  return street.length > 0 ? { kind: "address", street, city } : { kind: "none" };
}

// ---- scoring ------------------------------------------------------------------------------
export interface Candidate {
  id: string;
  city: string;
  price: number;
  beds: number | null;
  sqft: number | null;
}

const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Structured similarity, max 60 points (the handbook's weights). One deliberate change: price is compared
 * as a percentage, not in absolute dollars, so a $50,000 gap means something different on a $400K condo
 * than on a $4M house. A missing value earns no points for that factor.
 */
export function structuredScore(t: Target, c: Candidate): { points: number; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];
  const pct = Math.abs(t.price - c.price) / t.price;
  if (pct < 0.05) { points += 20; reasons.push("price within 5%"); }
  else if (pct < 0.15) { points += 12; reasons.push("price within 15%"); }
  else if (pct < 0.3) { points += 5; reasons.push("price within 30%"); }
  if (t.beds != null && c.beds != null && t.beds === c.beds) { points += 15; reasons.push(`${c.beds} bd`); }
  if (t.city.toLowerCase() === c.city.toLowerCase()) { points += 15; reasons.push("same city"); }
  if (t.sqft != null && c.sqft != null) {
    const diff = Math.abs(t.sqft - c.sqft);
    if (diff < 300) { points += 10; reasons.push("similar size"); }
    else if (diff < 700) { points += 5; }
  }
  return { points, reasons };
}

/**
 * Percentile rank (0..1) of each value among all values; ties share the average rank.
 * Raw cosine similarities between listings sit in a narrow band, so used directly they would add almost
 * the same number of points to everyone. Ranking them spreads the semantic half of the score across 0..40.
 */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 1);
  const sorted = [...values].sort((a, b) => a - b);
  const first = new Map<number, number>();
  const count = new Map<number, number>();
  sorted.forEach((v, i) => {
    if (!first.has(v)) first.set(v, i);
    count.set(v, (count.get(v) ?? 0) + 1);
  });
  return values.map((v) => (first.get(v)! + (count.get(v)! - 1) / 2) / (n - 1));
}

export interface Scored {
  candidate: Candidate;
  total: number;
  reasons: string[];
  similar: boolean; // description similarity available
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function rankCandidates(t: Target, pool: Candidate[], targetVec: Float32Array | null, vectorFor: (id: string) => Float32Array | null): Scored[] {
  const sims: (number | null)[] = pool.map((c) => {
    const v = targetVec ? vectorFor(c.id) : null;
    return v && targetVec ? dot(targetVec, v) : null;
  });
  const present = sims.filter((s): s is number => s !== null);
  const ranks = percentileRanks(present);
  let k = 0;
  const scored = pool.map((c, i) => {
    const s = structuredScore(t, c);
    const semantic = sims[i] === null ? 0 : 40 * ranks[k++];
    const reasons = sims[i] !== null && semantic >= 28 ? [...s.reasons, "similar description"] : s.reasons;
    return { candidate: c, total: Math.round((s.points + semantic) * 10) / 10, reasons, similar: sims[i] !== null };
  });
  return scored.sort(
    (a, b) =>
      b.total - a.total ||
      Math.abs(a.candidate.price - t.price) - Math.abs(b.candidate.price - t.price) ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
}

// ---- comp validation ---------------------------------------------------------------------------
export interface CompAssessment {
  compCount: number;
  medianPpsf: number | null;
  estimate: number | null;
  deltaPct: number | null;
  area?: string; // where the comps came from: "ZIP 91104" or a city name
}

export function assessPrice(listPrice: number, sqft: number | null, row: Row | undefined): CompAssessment {
  const compCount = Number(row?.comp_count ?? 0) || 0;
  const median = row?.median_ppsf == null ? null : Number(row.median_ppsf);
  if (!sqft || !median || !Number.isFinite(median) || compCount < MIN_COMPS) {
    return { compCount, medianPpsf: null, estimate: null, deltaPct: null };
  }
  const estimate = median * sqft;
  if (!(estimate > 0)) return { compCount, medianPpsf: null, estimate: null, deltaPct: null }; // never divide by zero
  return { compCount, medianPpsf: median, estimate, deltaPct: ((listPrice - estimate) / estimate) * 100 };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function describeAssessment(a: CompAssessment, sqft: number | null): string {
  if (a.deltaPct === null || a.estimate === null || a.medianPpsf === null) {
    return !sqft
      ? "Price check: not available (no square footage listed)."
      : `Price check: not enough recent comparable sales (${a.compCount}, need ${MIN_COMPS}).`;
  }
  const d = a.deltaPct;
  const verdict = Math.abs(d) <= 3 ? "in line with" : `${Math.abs(d).toFixed(1)}% ${d < 0 ? "below" : "above"}`;
  const few = a.compCount < FEW_COMPS ? ", few comps" : "";
  return `Price check: ${verdict} recent comparable sales${a.area ? ` in ${a.area}` : ""} (comps imply about ${money(a.estimate)} at ${money(a.medianPpsf)}/sq ft, ${a.compCount} sales${few}).`;
}

/** Six months ending at the newest sale date in the data, not at today, so the window does not quietly shrink. */
export function compWindow(lastDate: string): { start: string; end: string } {
  const [y, m, d] = lastDate.slice(0, 10).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1 - COMP_WINDOW_MONTHS, d)).toISOString().slice(0, 10);
  return { start, end: lastDate.slice(0, 10) };
}

// ---- orchestration -----------------------------------------------------------------------------
export interface RecommendOptions {
  cities?: string[];
  lastShown?: { n: number; id: string }[];
}

export interface RecommendResult {
  text: string;
  shown: { n: number; id: string }[];
}

const spread = (q: { sql: string; params: (string | number)[] }): [string, (string | number)[]] => [q.sql, q.params];

const toTarget = (r: Row): Target | null => {
  const price = pos(r.L_SystemPrice);
  if (price === null) return null;
  return {
    id: String(r.L_ListingID),
    city: String(r.L_City ?? ""),
    type: String(r.L_Type_ ?? ""),
    price,
    beds: pos(r.L_Keyword2),
    baths: pos(r.LM_Dec_3),
    sqft: pos(r.LM_Int2_3),
  };
};

const ask = "Tell me which listing you like: a number from the last results (for example \"more like #2\") or an address.";

export async function recommend(request: string, run: Run, index: VectorIndex, opts: RecommendOptions = {}): Promise<RecommendResult> {
  const none = (text: string): RecommendResult => ({ text, shown: [] });
  const ref = parseTarget(request, opts.cities);

  // 1. Which listing?
  let targetId: string;
  if (ref.kind === "position") {
    const hit = opts.lastShown?.find((e) => e.n === ref.n);
    if (!hit) return none(`I do not have a result #${ref.n} to work from. Run a search first, or give me an address.`);
    targetId = hit.id;
  } else if (ref.kind === "address") {
    const q = addressLookupQuery(ref.street, ref.city);
    const rows = await run(q.sql, q.params);
    if (rows.length === 0) return none(`I could not find an active listing at "${ref.street}". Check the address, or pick one by number from a search.`);
    if (rows.length > 1) {
      const options = rows.slice(0, 5).map((r) => `- ${r.L_Address}, ${r.L_City} ${r.L_Zip ?? ""}`.trim()).join("\n");
      return none(`That matches more than one listing. Which do you mean? Include the city or full address.\n${options}`);
    }
    targetId = String(rows[0].L_ListingID);
  } else {
    return none(ask);
  }

  // 2. The target listing itself.
  const byId = buildActiveByIds([targetId]);
  const targetRows = await run(byId.sql, byId.params);
  const target = targetRows[0] ? toTarget(targetRows[0]) : null;
  if (!targetRows[0]) return none("That listing is no longer active.");
  if (!target) return none("That listing has no price on record, so I cannot compare it.");

  // 3. Candidates and scores.
  const pq = candidatePoolQuery(target);
  const poolRows = await run(pq.sql, pq.params);
  const pool: Candidate[] = poolRows
    .map((r) => ({ id: String(r.L_ListingID), city: String(r.L_City ?? ""), price: pos(r.L_SystemPrice) ?? 0, beds: pos(r.L_Keyword2), sqft: pos(r.LM_Int2_3) }))
    .filter((c) => c.price > 0);
  if (pool.length === 0) return none("I could not find comparable active listings (same type, similar price and bedrooms).");
  const targetVec = index.vectorFor(target.id);
  const ranked = rankCandidates(target, pool, targetVec, (id) => index.vectorFor(id)).slice(0, TOP_N);

  // 4. Cards, and comp validation for the target and each recommendation.
  const cq = buildActiveByIds(ranked.map((s) => s.candidate.id));
  const cardRows = await run(cq.sql, cq.params);
  const cardById = new Map(cardRows.map((r) => [String(r.L_ListingID), r]));
  const kept = ranked.filter((s) => cardById.has(s.candidate.id));

  const range = (await run(dataRangeQuery().sql, []))[0];
  const lastDate = range?.last_date ? String(range.last_date) : null;
  const window = lastDate ? compWindow(lastDate) : null;
  // Prefer comps from the same ZIP code (neighborhoods differ a lot inside one city); fall back to the whole city.
  const assess = async (t: { city: string; zip: string; type: string; sqft: number | null; price: number }): Promise<CompAssessment> => {
    if (!window || !t.sqft) return assessPrice(t.price, t.sqft, undefined);
    const zip = /^\d{5}/.test(t.zip) ? t.zip.slice(0, 5) : null;
    const [zipRows, cityRows] = await Promise.all([
      zip ? run(...spread(compQuery({ kind: "zip", zip }, t.type, t.sqft, window.start, window.end))) : Promise.resolve([] as Row[]),
      run(...spread(compQuery({ kind: "city", city: t.city }, t.type, t.sqft, window.start, window.end))),
    ]);
    const byZip = zip ? assessPrice(t.price, t.sqft, zipRows[0]) : null;
    if (zip && byZip && byZip.deltaPct !== null && byZip.compCount >= FEW_COMPS) return { ...byZip, area: `ZIP ${zip}` };
    return { ...assessPrice(t.price, t.sqft, cityRows[0]), area: t.city };
  };
  const targetAssessment = assess({ city: target.city, zip: String(targetRows[0].L_Zip ?? ""), type: target.type, sqft: target.sqft, price: target.price });
  const rowAssessments = kept.map((s) => {
    const r = cardById.get(s.candidate.id)!;
    return assess({ city: String(r.L_City ?? ""), zip: String(r.L_Zip ?? ""), type: String(r.L_Type_ ?? ""), sqft: pos(r.LM_Int2_3), price: s.candidate.price });
  });
  const [tA, ...cA] = await Promise.all([targetAssessment, ...rowAssessments]);

  // 5. Text.
  const addr = String(targetRows[0].L_Address ?? "").trim() || "the listing you picked";
  const lines: string[] = [];
  lines.push(`Because you liked: ${addr}, ${target.city} - ${money(target.price)}, ${target.beds ?? "?"} bd | ${target.baths ?? "?"} ba | ${target.sqft ?? "?"} sqft`);
  lines.push(describeAssessment(tA, target.sqft));
  if (!targetVec) lines.push("Note: this listing has no description to compare, so matches use price, bedrooms, city and size only.");
  lines.push("");
  const shown: { n: number; id: string }[] = [];
  kept.forEach((s, i) => {
    const card = formatActiveCard(cardById.get(s.candidate.id)!, i + 1);
    lines.push(card);
    if (s.reasons.length) lines.push(`   Similar because: ${s.reasons.join(", ")}`);
    lines.push(`   ${describeAssessment(cA[i], pos(cardById.get(s.candidate.id)!.LM_Int2_3))}`);
    lines.push("");
    shown.push({ n: i + 1, id: s.candidate.id });
  });
  if (kept.length < TOP_N) lines.push(`Only ${kept.length} comparable listing${kept.length === 1 ? "" : "s"} found.`);
  lines.push(
    `Price checks compare asking prices with recent sold homes of similar size in the same ZIP code (or the same city when the ZIP has few sales)${lastDate ? ` (sales through ${lastDate})` : ""}. They are rough estimates, not appraisals.`,
  );
  return { text: lines.join("\n"), shown };
}
