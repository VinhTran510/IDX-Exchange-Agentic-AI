/**
 * Natural-language property query parser.
 *
 * Turns free text such as
 *   "3 bed condos in Irvine under $1.5M with a pool"
 * into a structured filter object for the rets_property query layer.
 *
 * Design notes (based on the real data in rets_property):
 *  - PoolPrivateYN / ViewYN store '1' for yes; '' or NULL otherwise.
 *  - AssociationFee is NULL for ~20% of rows, which means "no HOA".
 *  - L_Class is always 'Residential', so land listings do not exist here.
 *  - One keyword can map to several L_Type_ values, so `types` is a list.
 */

export interface PropertyFilters {
  city: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  beds: number | null; // minimum
  baths: number | null; // minimum
  sqft: number | null; // minimum
  types: string[] | null; // L_Type_ values, match with IN (...)
  pool: boolean | null; // true = has pool, false = explicitly no pool
  hasView: boolean | null; // true = has view, false = explicitly no view
  maxHoa: number | null; // monthly; 0 means "no HOA"
  warnings: string[]; // things the user asked for that we cannot satisfy
}

export interface ParseOptions {
  /** Known city names (e.g. SELECT DISTINCT L_City). Improves city detection. */
  cities?: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const NUM = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)`;
const MONEY = String.raw`\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|mil|million|thousand)?`;

/** keyword -> L_Type_ values that exist in rets_property */
const TYPE_RULES: Array<{ pattern: RegExp; types: string[] }> = [
  { pattern: /\b(?:multi[\s-]?family|multi[\s-]?unit)\b/i, types: ["Duplex", "Triplex", "Quadruplex"] },
  { pattern: /\bduplex(?:es)?\b/i, types: ["Duplex"] },
  { pattern: /\btriplex(?:es)?\b/i, types: ["Triplex"] },
  { pattern: /\b(?:quadruplex(?:es)?|fourplex(?:es)?|4[\s-]?plex)\b/i, types: ["Quadruplex"] },
  { pattern: /\b(?:mobile|manufactured)\s+homes?\b/i, types: ["ManufacturedHome", "ManufacturedOnLand", "MobileHome"] },
  { pattern: /\b(?:condo|condos|condominium|condominiums)\b/i, types: ["Condominium"] },
  { pattern: /\b(?:townhome|townhomes|townhouse|townhouses)\b/i, types: ["Townhouse"] },
  { pattern: /\b(?:single[\s-]?family|sfr|houses?)\b/i, types: ["SingleFamilyResidence"] },
  { pattern: /\bcabins?\b/i, types: ["Cabin"] },
  { pattern: /\blofts?\b/i, types: ["Loft"] },
  { pattern: /\bstudios?\b/i, types: ["Studio"] },
  { pattern: /\bfarms?\b/i, types: ["Farm"] },
  { pattern: /\b(?:co-?op|stock cooperative)\b/i, types: ["StockCooperative"] },
];

function toNumber(raw: string): number {
  const lower = raw.toLowerCase();
  if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower];
  return Number(lower);
}

function scaleMoney(raw: string, suffix?: string): number {
  let value = Number(raw.replace(/,/g, ""));
  const s = (suffix ?? "").toLowerCase();
  if (s === "k" || s === "thousand") value *= 1_000;
  else if (s === "m" || s === "mm" || s === "mil" || s === "million") value *= 1_000_000;
  return value;
}

/** Remove the matched part of the text so later extractors cannot re-use it. */
function strip(text: string, match: RegExpMatchArray): string {
  return text.slice(0, match.index) + " " + text.slice((match.index ?? 0) + match[0].length);
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parsePropertyQuery(query: string, opts: ParseOptions = {}): PropertyFilters {
  const result: PropertyFilters = {
    city: null, minPrice: null, maxPrice: null, beds: null, baths: null,
    sqft: null, types: null, pool: null, hasView: null, maxHoa: null, warnings: [],
  };

  let text = " " + query.replace(/\s+/g, " ").trim() + " ";
  let m: RegExpMatchArray | null;

  // ---- HOA (first, so its numbers are not mistaken for prices) -------------
  if ((m = text.match(/\b(?:no|without|zero)\s+(?:hoa|association(?:\s+fees?)?|hoa\s+fees?)\b/i))) {
    result.maxHoa = 0;
    text = strip(text, m);
  } else if (
    (m = text.match(new RegExp(String.raw`\b(?:hoa|association(?:\s+fees?)?)\s*(?:fees?\s*)?(?:of\s*)?(?:under|below|less than|up to|max(?:imum)?|at most|<=?)\s*${MONEY}`, "i")))
  ) {
    result.maxHoa = scaleMoney(m[1], m[2]);
    text = strip(text, m);
  } else if (
    (m = text.match(new RegExp(String.raw`\b(?:under|below|less than|up to|max(?:imum)?|at most)\s*${MONEY}\s*(?:/\s*mo(?:nth)?|a month|per month|monthly)?\s*(?:in\s+)?(?:hoa|association)(?:\s+fees?)?\b`, "i")))
  ) {
    result.maxHoa = scaleMoney(m[1], m[2]);
    text = strip(text, m);
  }

  // ---- Square footage --------------------------------------------------------
  if (
    (m = text.match(/(?:(?:at least|over|more than|above|min(?:imum)?)\s*)?\b(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*\+?\s*(?:sq\.?\s*ft\.?|sqft|square\s*(?:feet|foot|ft)|sf)\b/i))
  ) {
    result.sqft = scaleMoney(m[1], m[2]);
    text = strip(text, m);
  }

  // ---- Bedrooms ----------------------------------------------------------------
  if ((m = text.match(new RegExp(String.raw`\b${NUM}\s*\+?\s*[\s-]?\s*(?:bed(?:room)?s?|br|bd|bdrm)s?\b`, "i")))) {
    result.beds = toNumber(m[1]);
    text = strip(text, m);
  }

  // ---- Bathrooms ---------------------------------------------------------------
  if ((m = text.match(new RegExp(String.raw`\b${NUM}\s*\+?\s*[\s-]?\s*(?:bath(?:room)?s?|ba)\b`, "i")))) {
    result.baths = toNumber(m[1]);
    text = strip(text, m);
  }

  // ---- Price ------------------------------------------------------------------
  const isPrice = (v: number) => v >= 10_000; // guards against "at least 3 beds"

  if (
    (m = text.match(new RegExp(String.raw`\bbetween\s*${MONEY}\s*(?:and|to|-)\s*${MONEY}`, "i")))
  ) {
    const a = scaleMoney(m[1], m[2] ?? m[4]); // "500 to 800k" -> inherit the suffix
    const b = scaleMoney(m[3], m[4]);
    if (isPrice(a) && isPrice(b)) {
      result.minPrice = Math.min(a, b);
      result.maxPrice = Math.max(a, b);
      text = strip(text, m);
    }
  }
  if (result.maxPrice === null) {
    const maxRe = new RegExp(String.raw`\b(?:under|below|less than|up to|max(?:imum)?|no more than|at most|cheaper than|<=?)\s*${MONEY}`, "i");
    if ((m = text.match(maxRe))) {
      const v = scaleMoney(m[1], m[2]);
      if (isPrice(v)) {
        result.maxPrice = v;
        text = strip(text, m);
      }
    }
  }
  if (result.minPrice === null) {
    const minRe = new RegExp(String.raw`\b(?:over|above|more than|at least|min(?:imum)?|starting at|>=?)\s*${MONEY}`, "i");
    if ((m = text.match(minRe))) {
      const v = scaleMoney(m[1], m[2]);
      if (isPrice(v)) {
        result.minPrice = v;
        text = strip(text, m);
      }
    }
  }

  // ---- Pool / view (handle negation) ------------------------------------------
  if ((m = text.match(/\b(?:no|without|w\/o)\s+(?:a\s+|an\s+)?(?:private\s+)?pool\b/i))) {
    result.pool = false;
    text = strip(text, m);
  } else if ((m = text.match(/\bpool\b/i))) {
    result.pool = true;
    text = strip(text, m);
  }

  if ((m = text.match(/\b(?:no|without|w\/o)\s+(?:a\s+|an\s+)?views?\b/i))) {
    result.hasView = false;
    text = strip(text, m);
  } else if ((m = text.match(/\bviews?\b/i))) {
    result.hasView = true;
    text = strip(text, m);
  }

  // ---- Property type ----------------------------------------------------------
  if (/\b(?:land|lots?|vacant)\b/i.test(text) && !/\bparking lot\b/i.test(text)) {
    result.warnings.push("Land and lots are not available in this dataset (residential listings only).");
  }
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(text)) {
      result.types = rule.types;
      break; // rules are ordered from most to least specific
    }
  }

  // ---- City -------------------------------------------------------------------
  if (opts.cities?.length) {
    const sorted = [...opts.cities].sort((a, b) => b.length - a.length); // "Palm Desert" before "Palm"
    for (const city of sorted) {
      if (new RegExp(String.raw`\b${escapeRegex(city)}\b`, "i").test(text)) {
        result.city = city;
        break;
      }
    }
  }
  if (result.city === null) {
    const fallback = text.match(
      /\b(?:in|near|around|at)\s+([A-Za-z][A-Za-z.' -]*?)(?=\s+(?:under|below|over|above|with|without|for|that|and|at|near|,)\b|\s*[,.]|\s*$)/i
    );
    if (fallback) result.city = titleCase(fallback[1].trim());
  }

  return result;
}
