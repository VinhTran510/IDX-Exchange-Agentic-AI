// Builds the text that gets embedded for each listing.
// Descriptions are free text written by agents: strip contact details first, and never show them to users.
export type ListingRow = Record<string, unknown>;

const MAX_REMARK_CHARS = 6000;
export const MIN_REMARK_CHARS = 20;

export function cleanRemarks(raw: string): string {
  let t = raw.replace(/<[^>]*>/g, " "); // stray HTML
  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, " "); // links
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " "); // emails
  t = t.replace(/(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/g, " "); // US phone numbers
  t = t.replace(/\s+/g, " ").trim();
  return t.slice(0, MAX_REMARK_CHARS);
}

const clean = (v: unknown): string => String(v ?? "").trim();
const positive = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
};

/**
 * Text to embed, or null when there is no usable description.
 * Price is left out on purpose: price is handled by SQL filters and goes stale.
 */
export function buildListingText(row: ListingRow): string | null {
  const remarks = cleanRemarks(clean(row.L_Remarks));
  if (remarks.length < MIN_REMARK_CHARS) return null;
  const facts: string[] = [`${clean(row.L_Type_) || "Home"} in ${clean(row.L_City) || "California"}, CA.`];
  const beds = positive(row.L_Keyword2);
  const baths = positive(row.LM_Dec_3);
  const sqft = positive(row.LM_Int2_3);
  const year = positive(row.YearBuilt);
  if (beds) facts.push(`${beds} beds.`);
  if (baths) facts.push(`${baths} baths.`);
  if (sqft) facts.push(`${sqft} sq ft.`);
  if (year) facts.push(`Built ${year}.`);
  return `${facts.join(" ")} ${remarks}`;
}
