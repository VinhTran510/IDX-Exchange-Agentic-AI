# Week 7: Recommendation Engine

Given a listing the user likes, return the top 5 comparable active listings and sanity-check each
asking price against recent sold comps. Works over WhatsApp as the `similar-listings` skill.

## How users ask

- By position from the last results: "more like #2"
- By address: "more like 380 Dearborn Street" (optionally with a city)

The skill, not the LLM, keeps the last shown results in the session store, so "#2" always maps to
the listing that was actually displayed.

## Pipeline

1. **Resolve the target** from a position (session) or an address (parameterized `LIKE`, wildcards escaped).
2. **Candidate pool** (SQL): same property type, price within +/-40%, bedrooms within one, target excluded.
3. **Score** each candidate (hybrid):
   - Structured, max 60: price proximity (within 5% / 15% / 30%), same bedrooms, same city, similar square footage. Missing values earn nothing.
   - Semantic, max 40: cosine similarity of description embeddings, converted to a percentile rank among the candidates.
4. **Top 5** by total score, with a plain-language "Similar because" line.
5. **Price check** per listing: median price per sq ft of recent sold homes of the same subtype and similar size, applied to the listing's square footage.

## Design decisions and deviations from the handbook

- **Relative price bands** (percent of the target price) instead of fixed dollar amounts, so the rule works at any price level.
- **Percentile-ranked semantics.** Raw cosine scores sit in a narrow band, so they barely separate listings. Ranking within the candidate set uses the full 0-40 range.
- **No numeric match score is shown.** Percentile ranks make the top results all look like "100/100", which oversells them. The ordering carries the ranking; the reasons explain it.
- **Median, not average**, price per sq ft, computed with window functions because MySQL has no MEDIAN.
- **Comp window anchored to the newest sale in the data**, not today's date, and bounded so bad future-dated rows are ignored.
- **ZIP first, city fallback.** Neighborhoods differ a lot inside a city. Comps come from the same ZIP when it has at least 10 sales, otherwise the city. The output says which was used.
- **Minimum sample sizes.** Fewer than 5 comps: no estimate is given. Fewer than 10: flagged as "few comps". Never a division by zero.
- **Descriptions are untrusted.** Listing remarks are only embedded, never displayed or passed to the model.

## Known limits

- Sold data covers only a few months, so price checks are rough estimates, not appraisals.
- Only listings with a usable description have an embedding; others are ranked on structured signals alone, and the output says so.
- The session is shared across WhatsApp senders (single "default" session); per-sender sessions are future work.

## Testing

Unit tests cover target parsing, SQL builders, scoring, percentile ranks, price assessment, ZIP preference and city fallback, and the full recommend path with a fake database. Verified end to end in the terminal and over WhatsApp.