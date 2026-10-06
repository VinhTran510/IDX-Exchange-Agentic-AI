import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePropertyQuery, type PropertyFilters } from "../src/parsePropertyQuery.ts";

// Real cities from rets_property (top of the SELECT L_City ... GROUP BY query)
const CITIES = [
  "Los Angeles", "San Diego", "San Jose", "Irvine", "Palm Desert", "Long Beach",
  "Palm Springs", "Riverside", "Oakland", "Indio", "Temecula", "Victorville",
  "Lake Arrowhead", "Lancaster", "Hemet", "Corona", "Murrieta", "Menifee",
  "Palmdale", "La Quinta",
];

const EMPTY: PropertyFilters = {
  city: null, minPrice: null, maxPrice: null, beds: null, baths: null,
  sqft: null, types: null, pool: null, hasView: null, maxHoa: null, warnings: [],
};

function check(query: string, expected: Partial<PropertyFilters>) {
  test(query, () => {
    const actual = parsePropertyQuery(query, { cities: CITIES });
    assert.deepEqual(actual, { ...EMPTY, ...expected });
  });
}

// 1. The handbook's own example
check("Show me 3-bedroom condos in Irvine under $1.5M with a pool", {
  city: "Irvine", maxPrice: 1_500_000, beds: 3, types: ["Condominium"], pool: true,
});

// 2. City at the start, no "in"
check("Irvine condos under 1M", { city: "Irvine", maxPrice: 1_000_000, types: ["Condominium"] });

// 3. Multi-word city
check("homes in Palm Desert", { city: "Palm Desert" });

// 4. Shorthand beds/baths with k price
check("2 bed 2 bath under 800k in San Diego", {
  city: "San Diego", beds: 2, baths: 2, maxPrice: 800_000,
});

// 5. Half bath
check("townhouse in Temecula with 2.5 baths", { city: "Temecula", types: ["Townhouse"], baths: 2.5 });

// 6. Number words
check("three bedroom house in Corona", { city: "Corona", beds: 3, types: ["SingleFamilyResidence"] });

// 7. "3br" and "2ba" shorthand
check("3br 2ba in Riverside", { city: "Riverside", beds: 3, baths: 2 });

// 8. Square footage with commas, and it must not leak into price
check("at least 1,800 sq ft in Murrieta", { city: "Murrieta", sqft: 1800 });

// 9. Price range
check("homes in Oakland between $600k and $900k", { city: "Oakland", minPrice: 600_000, maxPrice: 900_000 });

// 10. Minimum price
check("luxury homes in Los Angeles over 3 million", { city: "Los Angeles", minPrice: 3_000_000 });

// 11. "at least 3 beds" must NOT be treated as a price
check("at least 3 beds in Hemet", { city: "Hemet", beds: 3 });

// 12. Explicit "no HOA"
check("condos in Long Beach with no HOA", { city: "Long Beach", types: ["Condominium"], maxHoa: 0 });

// 13. HOA cap, and its number must not become a price
check("condos in Palm Springs with HOA under $500", {
  city: "Palm Springs", types: ["Condominium"], maxHoa: 500,
});

// 14. HOA phrased the other way round
check("townhomes in Menifee under 450 a month HOA", { city: "Menifee", types: ["Townhouse"], maxHoa: 450 });

// 15. Negated pool
check("houses in Indio with no pool", { city: "Indio", types: ["SingleFamilyResidence"], pool: false });

// 16. View
check("condo with a view in La Quinta", { city: "La Quinta", types: ["Condominium"], hasView: true });

// 17. Multi-family expands to several real L_Type_ values
check("multi-family in Lancaster under $700k", {
  city: "Lancaster", maxPrice: 700_000, types: ["Duplex", "Triplex", "Quadruplex"],
});

// 18. Mobile homes expand to several real L_Type_ values
check("mobile home in Victorville", {
  city: "Victorville", types: ["ManufacturedHome", "ManufacturedOnLand", "MobileHome"],
});

// 19. Land does not exist in this dataset: warn instead of silently returning nothing
check("land in Palmdale", {
  city: "Palmdale",
  warnings: ["Land and lots are not available in this dataset (residential listings only)."],
});

// 20. Messy casing and extra whitespace
check("   3   BED   CONDO   in   irvine   UNDER   $750,000  ", {
  city: "Irvine", beds: 3, types: ["Condominium"], maxPrice: 750_000,
});

// 21. No city at all
check("2 bed condo under 500k", { beds: 2, types: ["Condominium"], maxPrice: 500_000 });

// 22. Empty / meaningless input returns the empty filter, not a crash
check("hello there", {});

// 23. City not in the known list falls back to the "in X" pattern
test("unknown city falls back to regex", () => {
  const r = parsePropertyQuery("3 bed house in Mission Viejo under 1.2M", { cities: CITIES });
  assert.equal(r.city, "Mission Viejo");
  assert.equal(r.maxPrice, 1_200_000);
});

// 24. Works with no city list supplied at all
test("works without a city list", () => {
  const r = parsePropertyQuery("2 bed in Irvine under 900k");
  assert.equal(r.city, "Irvine");
  assert.equal(r.beds, 2);
  assert.equal(r.maxPrice, 900_000);
});
