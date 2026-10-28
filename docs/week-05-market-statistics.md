# Week 5: Market Statistics Agent

The assistant now answers market questions from the sold-comps table: "What is the median price in Pasadena?", "How fast are condos selling in Irvine?", "Is now a good time to buy in San Diego?". Answers are computed from data, and the agent states what period the data covers.

## What was built

- **Market queries** (`src/marketQueries.ts`): parameterized SQL for a city or ZIP code, optionally narrowed by property type. Covers median and average price, median price per sq ft, days on market, list-to-close ratio, a monthly trend, and the number of active listings for a supply comparison.
- **Report builder** (`src/marketReport.ts`): runs the queries, applies the sample-size and partial-month rules, and formats a short text report.
- **`market-stats` skill** (`skills/market-stats/`): a CLI plus a `SKILL.md`. It takes a free-text question, finds the city or ZIP in it, and prints the report.

## Design decisions

**Medians, computed in SQL.** MySQL has no `MEDIAN()` function, and the handbook's example only uses averages, which a few luxury sales can pull far off. Medians use window functions (`ROW_NUMBER() OVER` and `COUNT(*) OVER`), and the monthly trend uses a median per month for the same reason.

**Check the data before trusting it.** Before writing statistics I measured the quality of the columns I would depend on. A small number of rows had negative or implausible days on market, a sale price far from list price, or no living area. Each metric excludes only the rows that are invalid for that metric: days on market between 0 and 730, a sale-to-list ratio between 0.5 and 2, and living area above 0 for price per sq ft. Rows with close dates in the future are excluded everywhere.

**Say how much data there is.** Every report states the period the sold data covers. A minimum sample size keeps the agent from reporting a "market statistic" computed from a handful of sales: under 10 sales it refuses, and under 30 it adds a caution. Many cities fall below these thresholds, and the agent says so instead of guessing.

**Partial months are labeled, and never used for trend.** The data starts and ends partway through a month, so the first and last months look like a collapse in sales volume if included naively. They are labeled "partial month", and month-over-month change uses only complete months. The report also notes that month-to-month median changes partly reflect which homes happened to sell.

**Describe, don't advise.** For "is now a good time to buy", the skill instructions tell the agent to present the facts (days on market, list-to-close ratio, supply, trend) and to avoid predictions or buy/sell advice.

**Same safety model as before:** read-only database account, bound parameters for everything that comes from the user, and fixed SQL for everything else.

## The handbook versus the data

The handbook asks for a 12-month trend and year-over-year comparisons. The sold data covers only about seven months and ends before the present, so neither is possible. The skill reports the trend over the months that exist and says year-over-year is not available, rather than stretching the claim.

## Testing

- **Offline unit tests** (11 for this week, 30 total): city and ZIP only ever appear as bound parameters, future dates and bad prices are excluded, window-function medians, partial-month detection at both ends of the data, month-over-month using only complete months, the minimum-sample refusal and small-sample caution, question parsing (city, ZIP, property type, "at least" not read as a city), and a full run with a fake database.
- **Real database** from the terminal, for a city and for a city plus property type, plus a question with no place named (the skill asks for one).
- **WhatsApp end to end:** the same numbers as the terminal, and a "good time to buy" question answered with facts instead of a prediction.

## Known limits

- The data covers a few months and ends before today, so trends are short and the supply comparison is rough: active listings are current, while sold data stops earlier.
- Small cities can't be analyzed (minimum sample sizes).
- Neighborhood and school-district breakdowns are not supported, only city, ZIP and property type.
- Price per sq ft depends on living-area data, which is missing for a small share of sales.
