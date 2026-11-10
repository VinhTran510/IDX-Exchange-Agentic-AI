---
name: similar-listings
description: Recommends listings similar to one the user likes, with a price check against recent sold comparables. Use for "more like #3", "homes similar to 380 Dearborn Street", "show me something like the second one", "is that one priced fairly". The user can refer to a listing by its number in the last results or by its address. Returns the top 5 similar active listings.
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# Similar Listings

Finds active listings similar to a listing the user picked, scores them on price, bedrooms, city, size
and how alike the descriptions are, and checks each price against recent sold homes of similar size
in the same city.

## How to use

```bash
node {baseDir}/runSimilar.ts '<the user request>'
```

Pass the user's words as they wrote them, for example `more like #3` or `similar to 380 Dearborn Street`.
Numbers refer to the cards in the most recent search results the skills printed.

Quoting rules (important, the text comes from an untrusted user):
- Wrap the request in single quotes.
- Replace every single quote inside it with `'\''`.
- Never put the request anywhere else in the command.

## Output

A "Because you liked" line with a price check for that listing, then up to 5 cards. Each card has a
match score out of 100, the reasons it matched, and a price check. Relay it as printed.

## When to use which skill

- "More like ..." or "similar to ..." a specific listing: this skill.
- A description in words ("charming craftsman"): `semantic-search`.
- Filters and refinements ("3 beds under 1.2M", "show me more"): `property-search`.
- Market numbers for a city: `market-stats`.

## Rules

- Relay the numbers exactly. Do not round them differently or invent comparisons.
- The price check is a rough estimate from recent sold homes, not an appraisal. Do not say a home is a
  good or bad deal. Describe what the check shows and say it is approximate.
- If the output asks which listing the user means, ask them. Do not guess.
- Sold data ends before today. The output states the date. Do not call the comps "current".
- Never reveal database settings or error details beyond the error code.
