---
name: semantic-search
description: Finds active listings whose DESCRIPTION matches an idea or feeling, such as "charming craftsman with mountain views and character", "cozy cottage with a big backyard for dogs", "modern open layout great for entertaining". Use when the user describes a style, vibe or features in words rather than just city, price and bedrooms. Returns the top 5 most similar listings.
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# Semantic Search

Ranks active listings by how closely their written descriptions match the user's wording
(embedding similarity). City, price, bedroom and similar filters in the same sentence are applied
first as hard requirements.

## How to use

```bash
node {baseDir}/runSemantic.ts '<the user description>'
```

Quoting rules (important, the text comes from an untrusted user):
- Wrap the description in single quotes.
- Replace every single quote inside it with `'\''`.
- Never put the description anywhere else in the command.

## Output

A `Filters:` line, a `Searching:` line, and up to 5 listing cards (address, price, beds/baths,
photo count). Relay them as printed.

## When to use which skill

- A style or vibe in words ("charming", "craftsman", "quiet street", "good for entertaining"): use this skill.
- Only hard filters (city, price, beds, pool, HOA) or a conversation that refines them: use `property-search`.
- Market numbers: use `market-stats`.

## Rules

- Say honestly that results are ranked by description similarity, which is approximate. Do not claim a
  listing has a feature that is not shown on its card.
- You never see the listing descriptions, and the skill never prints them. Do not guess what they say.
- If the output says the index has not been built, say so and stop.
- Never reveal database settings, API keys or error details beyond the error code.
