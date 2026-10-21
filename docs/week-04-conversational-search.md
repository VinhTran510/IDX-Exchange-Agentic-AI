# Week 4: Conversational Property Search

The assistant now holds a multi-turn conversation over WhatsApp. It asks follow-up questions, remembers preferences during the conversation, and refines results as the user changes their mind.

```
User:  Find homes in Irvine
Agent: What is your budget?
User:  Under $1.2M
Agent: Any preference: condo, townhome, or single family?
User:  Single family with at least 3 beds
Agent: [listing cards: address, price, beds/baths, photo count]
User:  raise the budget to 1.5M and only 4 beds
Agent: [refined results; city and property type carried over]
```

## What was built

- **Session store** (`src/sessionStore.ts`): per-user state (filters, which questions were already asked, page, step) saved as a small JSON file in a git-ignored folder, with a 24-hour idle expiry.
- **Conversation logic** (`src/conversation.ts`): parses each message, merges it into the remembered filters (new values override, everything else is kept), then either asks the next missing question or runs the search. Supports "show me more" and "start over".
- **Richer listing cards** (`src/listingCards.ts`, `src/sqlBuilder.ts`): street address with city and ZIP, price, beds/baths/sqft, and photo count, plus pool, view and HOA.
- **Skill update** (`skills/property-search/`): conversation mode is now the default way the skill runs.

## Design decisions

**State lives on disk, not in memory.** The handbook sketches an in-memory `Map` of sessions. The skill runs as a fresh process on every message, so a Map would be empty each time. Sessions are stored as one JSON file per user (owner-only permissions, sanitized file names so an id cannot escape the folder).

**Each question is asked at most once.** If the user answers vaguely ("not sure"), the agent moves on and searches instead of looping on the same question.

**Refinement overrides, never resets.** "Only 4 beds" changes one filter and keeps the city, price and type. Changing any filter resets paging to the first page.

**The skill, not the model, owns the conversation state.** In the first WhatsApp test the model answered like a conversation, but it was only reading its own chat history and ignoring the session flag, so no follow-up questions were asked and "start over" cleared nothing. I made session mode the default for the command, so correct behavior no longer depends on the model remembering a flag, and tightened the skill instructions so every search-related message goes through it.

**A real bug found by testing the handbook's own example.** The reply "single family with at least 3 beds" was read as the city "Least", because the parser's fallback treated "at" as the start of a place name. This would have silently replaced the user's city. It is fixed, with a regression test.

## Testing

- **19 offline unit tests** (no database): the handbook's example conversation end to end, questions asked only once, refinement overriding one filter, paging and reset, per-user isolation, land requests refused, session-id sanitization, and the "at least" regression.
- **Terminal run against the real database** with the handbook's example conversation.
- **WhatsApp end to end:** the full conversation above, including a refinement and a reset.

## Known limits

- **One shared session by default.** Sessions are keyed by an id the caller can pass, but the WhatsApp sender is not passed through yet, so two people using the agent at once would share state. Per-sender ids are the next fix before any multi-user use.
- Follow-up questions cover city, budget and property type. Beds, baths and features are picked up whenever the user mentions them.
- The agent still sometimes adds its own friendly suggestions after the skill output.
- Each message still sends a large prompt to the model; prompt trimming is still planned.
