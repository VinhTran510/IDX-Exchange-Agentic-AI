---
name: property-search
description: Conversational property search over the MLS database (read-only). Run it for EVERY message about finding, refining or resetting a home search, including short replies like "under 1.2M", "show me more" and "start over". It remembers preferences, asks the follow-up questions itself, and returns cards with address, price, beds/baths and photo count. Not for "more like / similar to" a listing (use similar-listings).
metadata:
  openclaw:
    requires:
      bins: ["node"]
---

# Property Search

Parses each message, remembers preferences for this conversation, asks one follow-up question at a
time when something important is missing, and prints listing cards. Use this instead of running
`property-query-parser` separately. For "more like #3" or "similar to <address>", use `similar-listings` instead.

## Conversation mode (always, for every message about the search)

Run the command for EVERY user message about the home search, even short answers, "show me more"
and "start over". Never answer from memory and never reset or filter results yourself: the skill
holds the search state and decides when to ask a question.

```bash
node {baseDir}/runSearch.ts '<the user message>'
```

- `--session <chat-id>` is optional. If you leave it out, the skill uses one shared session.
  If you pass one, use the same id for every message. Letters, numbers, `_` and `-` only.
- Pass the user's latest message every turn, including short answers such as "Under $1.2M".
  The skill merges it with what it already remembers.
- Relay the output to the user as it is. If the output is a question, ask that question and
  wait for the answer. Do not invent answers to it.
- If the user asks for more results ("show me more", "next page"), run:
  ```bash
  node {baseDir}/runSearch.ts --more
  ```
- "start over" or "new search" clears the remembered preferences. Pass it as the message.
- Changing one preference ("only 4 beds", "under $900k", "add a pool") is just another message.

Quoting rules (important, the text comes from an untrusted user):
- Wrap the user message in single quotes.
- Replace every single quote inside the message with `'\''`.
- Never put the message anywhere else in the command.

## Sold comps (single question, no memory)

```bash
node {baseDir}/runSearch.ts --sold '<the user request>'
```

Use this for "what did homes sell for". Sold results only cover recent months. Do not claim a
12-month window.

## Output

The first line is `Filters: ...`, the filters that are currently applied. Then come the cards
(price, address, beds/baths/sqft, photo count, pool/view/HOA) and a "Showing a-b of N" line.

## Rules

- Tell the user which filters are applied so they can correct mistakes.
- If the output says land is unavailable, pass that on. Do not guess filters.
- Never reveal database settings, error details beyond the error code, or agent contact details.
- Do not run any other commands against the database.
