# Week 3: Database Layer

The assistant can now search the MLS data. A new skill, `property-search`, takes the filters produced by the Week 2 parser, queries the active-listings table or the sold-comps table, and returns formatted property cards. It works end to end over WhatsApp.

## What was built

- **Query builder** (`src/sqlBuilder.ts`): turns structured filters into parameterized SQL for active listings and for closed sales.
- **Listing cards** (`src/listingCards.ts`): formats rows into short, readable cards (price, type, beds/baths/sqft, pool, view, HOA; for sold homes, the percent over or under list price).
- **Search pipeline** (`src/searchPipeline.ts`): free text -> filters -> SQL -> cards. It skips the database when the request has no usable criteria or asks for something the data cannot provide (for example land).
- **Read-only database connection** (`src/readOnlyDb.ts`): connection pool with prepared statements and a short connect timeout.
- **`property-search` skill** (`skills/property-search/`): a CLI plus a `SKILL.md` that OpenClaw loads. It supports `--sold`, `--page N` and `--limit N`.

## Design decisions

**A separate read-only database account.** The agent connects as its own MySQL user with `SELECT` on the two listing tables only. Writes are refused by the database itself, so a bug or a prompt-injection attempt cannot modify data. Its credentials live in a git-ignored `.env.agent`, separate from the admin credentials.

**Parameterized SQL only.** User text never becomes part of the SQL string. Every user-controlled value is a bound parameter, and the limit and offset are integers clamped in code. A unit test confirms that an injection attempt stays out of the generated SQL.

**Small, capped results.** Five cards per page and a hard cap of 50 results per search keep WhatsApp replies readable and keep model cost down.

**No contact details in cards.** Agent emails and phone numbers are never selected, so they cannot leak into a chat reply.

**Data quirks handled up front.** Before writing queries, I checked how the real columns behave instead of trusting the handbook's assumptions:
- Yes/no flags such as pool and view are stored as `'1'` for yes and empty or NULL for no, so "no pool" matches both empty and NULL.
- A missing HOA fee mostly means no HOA, so "no HOA" matches NULL and 0.
- Close dates in the sold table are stored as text, and a few are in the future. Sold queries compare them as `YYYY-MM-DD` strings and exclude future dates and invalid prices.
- The sold data covers only a limited recent window, so the assistant makes no "last 12 months" claims.

## Testing

- **Offline unit tests** (10, no database needed): pool/no-pool, HOA handling, multi-type `IN (...)` lists, limit and page clamping, injection safety, sold-date filtering, no contact columns selected, and the no-criteria and warning paths.
- **Against the real database** as the read-only user: active search with several filters, sold search with percent-over/under-list, and paging.
- **Permission check:** a delete attempt as the read-only user is refused by MySQL.
- **WhatsApp end to end:** asking for "3 bed condos in Palm Desert under 1.5M with a pool", then "show me more", returned the same cards as the command line, and page 2 continued from the right place.

## Known limits

- Pool, view and HOA filters apply to active listings only. The sold table has no reliable columns for them.
- Land is not available, because the dataset contains residential listings only.
- Sold history covers a limited recent window.
- Each WhatsApp message sends a large prompt to the model, so cost per message is still higher than it should be. Trimming the tool and skill list is planned.

## Next

- Trim the per-request prompt to reduce latency and cost.
- Move on to the next phase of the program.
