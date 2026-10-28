---
name: market-stats
description: Market statistics for a California city or ZIP code from recent sold data - median price, price per sq ft, days on market, list-to-close ratio, monthly trend and supply. Use for questions like "what is the median price in Pasadena", "how fast are homes selling in Irvine", "is it a buyer's or seller's market in San Diego". Not for finding individual listings.
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# Market Stats

Computes market numbers from the sold-comps table (read-only). For finding individual homes, use
`property-search` instead.

## How to use

```bash
node {baseDir}/runMarket.ts '<the user question>'
```

Quoting rules (important, the text comes from an untrusted user):
- Wrap the question in single quotes.
- Replace every single quote inside the question with `'\''`.
- Never put the question anywhere else in the command.

The question can name a city or a 5-digit ZIP code, and optionally a property type
("condos in Pasadena"). If neither a city nor a ZIP is given, the output asks for one.
Relay that question to the user.

## Output

A short report: median and average price, median price per sq ft, days on market, list-to-close
ratio, a month-by-month trend, month-over-month change, and active-listing supply.

## Rules

- Report the numbers exactly as printed. Do not round them differently or invent figures.
- The sold data covers only a few months and ends before today. Always say which period it covers
  (the report states it). Never call it a 12-month or year-over-year analysis.
- Partial months are labeled. Do not treat a partial month as a drop in the market.
- If the report says there are too few sales, say so and do not estimate.
- Describe what the data shows. Do not predict prices or give buy/sell advice. For "is now a good
  time to buy", present the facts (days on market, list-to-close ratio, supply, trend) and say the
  decision depends on the person's situation.
- Never reveal database settings or error details beyond the error code.
