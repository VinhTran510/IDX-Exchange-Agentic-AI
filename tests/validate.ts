// Validates the property query parser against tests/validation-cases.json,
// using the real city list exported from the database.
//
//   node tests/validate.ts               -> PASS/FAIL per query
//   node tests/validate.ts --markdown    -> a results table in markdown
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parsePropertyQuery, type PropertyFilters } from "../src/parsePropertyQuery.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ query: string; expected: Partial<PropertyFilters> }> = JSON.parse(
  readFileSync(join(here, "validation-cases.json"), "utf8"),
);

const citiesPath = join(here, "../skills/property-query-parser/cities.txt");
const cities = existsSync(citiesPath)
  ? readFileSync(citiesPath, "utf8").split("\n").map((c) => c.trim()).filter(Boolean)
  : [];

const EMPTY: PropertyFilters = {
  city: null, minPrice: null, maxPrice: null, beds: null, baths: null,
  sqft: null, types: null, pool: null, hasView: null, maxHoa: null, warnings: [],
};

/** Compact "field=value" summary of the non-empty fields. */
function summarize(f: PropertyFilters): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(f)) {
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    parts.push(`${key}=${Array.isArray(value) ? value.join("/") : value}`);
  }
  return parts.join(", ") || "(no filters)";
}

const markdown = process.argv.includes("--markdown");
let failed = 0;
const rows: string[] = [];

cases.forEach((c, i) => {
  const expected: PropertyFilters = { ...EMPTY, ...c.expected };
  const actual = parsePropertyQuery(c.query, { cities });
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failed++;
  const query = c.query.trim().replace(/\s+/g, " ");
  if (markdown) {
    rows.push(`| ${i + 1} | ${query} | ${summarize(expected)} | ${ok ? "Pass" : "**Fail**: " + summarize(actual)} |`);
  } else {
    console.log(`${ok ? "PASS" : "FAIL"}  #${i + 1}  ${query}`);
    if (!ok) {
      console.log(`      expected: ${summarize(expected)}`);
      console.log(`      actual:   ${summarize(actual)}`);
    }
  }
});

if (markdown) {
  console.log("# Property Query Parser: Validation Results\n");
  console.log(
    `Free-text queries run through the parser with the real city list (${cities.length} cities from \`rets_property\`).\n`,
  );
  console.log("| # | Query | Expected filters | Result |");
  console.log("|---|---|---|---|");
  rows.forEach((r) => console.log(r));
  console.log(`\n**${cases.length - failed} of ${cases.length} passed.**`);
} else {
  console.log(`\n${cases.length - failed} of ${cases.length} passed (${cities.length} cities loaded)`);
}
process.exit(failed ? 1 : 0);
