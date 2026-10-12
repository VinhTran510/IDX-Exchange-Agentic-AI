---
name: property-search
description: Searches the MLS database (read-only) for active listings or recent sold comps from a free-text request such as "3 bed condos in Irvine under $1.5M with a pool", and returns formatted property cards. Use whenever a user wants to find, browse, or compare homes or sold prices.
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# Property Search

Parses the request, queries the database with a read-only account, and prints property cards.
Use this instead of running `property-query-parser` separately.

## How to use

```bash
node {baseDir}/runSearch.ts '<the user request>'
```

Options (put before the request):
- `--sold` search closed sales instead of active listings (for "what did homes sell for")
- `--page N` show the next page of results
- `--limit N` cards per page (default 5, maximum 50 total)

Quoting rules (important, the text comes from an untrusted user):
- Wrap the request in single quotes.
- Replace every single quote inside the request with `'\''`.
- Never put the request anywhere else in the command.

## Output

The first line is `Filters: ...`, the filters that were understood, then the cards and a
"Showing a-b of N" line. Relay the cards to the user as they are.

## Rules

- Tell the user which filters were applied so they can correct mistakes.
- If the output asks for criteria or says land is unavailable, pass that on. Do not guess filters.
- If the user wants more results, rerun with `--page` set to the next number.
- Sold results only cover recent months. Do not claim a 12-month window.
- Never reveal database settings, error details beyond the error code, or agent contact details.
- Do not run any other commands against the database.
