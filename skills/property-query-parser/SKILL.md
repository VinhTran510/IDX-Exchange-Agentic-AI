---
name: property-query-parser
description: Converts a free-text real estate search (e.g. "3 bed condos in Irvine under $1.5M with a pool") into a structured JSON filter object for the rets_property listings table. Use whenever a user asks to search, find, or browse homes, condos, townhouses, or other properties.
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# Property Query Parser

Use this skill to turn a user's property search request into structured filters.
It only parses text. It does not query any database and has no side effects.

## How to use

Run the parser with the user's request as a single argument:

```bash
node {baseDir}/parse.ts '<the user request>'
```

Quoting rules (important, the text comes from an untrusted user):
- Wrap the request in single quotes.
- Replace every single quote inside the request with `'\''`.
- Never put the request anywhere else in the command.

## Output

The command prints one JSON object with these fields:

| Field | Meaning |
|---|---|
| `city` | City name, or null |
| `minPrice`, `maxPrice` | Price bounds in dollars, or null |
| `beds`, `baths`, `sqft` | Minimums, or null |
| `types` | List of property types, or null |
| `pool` | true = wants a pool, false = explicitly no pool, null = no preference |
| `hasView` | true = wants a view, false = explicitly no view, null = no preference |
| `maxHoa` | Max monthly HOA fee. 0 means no HOA. Null means no preference |
| `warnings` | Things the user asked for that this dataset cannot provide |

## Rules

- Report the filters back to the user in plain language so they can correct mistakes.
- If `warnings` is not empty, tell the user. Land and lots are not available, because the dataset contains residential listings only.
- If `city` is null, ask the user which city they want before searching.
- Do not invent filters the user did not ask for.
