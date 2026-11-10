// Multi-turn property search: asks follow-up questions, remembers preferences, refines results.
import { parsePropertyQuery, type PropertyFilters } from "./parsePropertyQuery.ts";
import { describeFilters, searchWithFilters, type Run } from "./searchPipeline.ts";
import { newSession, type SessionFilters, type SessionStore, type UserSession } from "./sessionStore.ts";

export interface TurnOptions {
  cities?: string[];
  more?: boolean; // "show me more": next page of the current search
}

const RESET = /^\s*(reset|start over|new search|clear)\b/i;

/** New values override remembered ones; anything the user did not mention is kept. */
export function mergeFilters(base: SessionFilters, incoming: PropertyFilters): SessionFilters {
  const out: SessionFilters = { ...base };
  const keys = ["city", "minPrice", "maxPrice", "beds", "baths", "sqft", "pool", "hasView", "maxHoa"] as const;
  for (const k of keys) {
    if (incoming[k] != null) (out as Record<string, unknown>)[k] = incoming[k];
  }
  if (incoming.types && incoming.types.length > 0) out.types = incoming.types;
  return out;
}

function asFilters(f: SessionFilters): PropertyFilters {
  return { ...f, warnings: [] };
}

const HINT = "Say 'show more' for the next page, or change anything (for example 'only 4 beds' or 'under $900k'). Say 'start over' to begin a new search.";

export async function handleTurn(
  sessionId: string,
  message: string,
  run: Run,
  store: SessionStore,
  opts: TurnOptions = {},
): Promise<string> {
  if (RESET.test(message)) {
    store.clear(sessionId);
    return "Starting a new search. Which city are you interested in?";
  }

  const session: UserSession = store.load(sessionId) ?? newSession();

  // --- next page of the current search -----------------------------------------
  if (opts.more) {
    if (!session.filters.city) return "There is no search to continue yet. Which city are you interested in?";
    session.page += 1;
    session.conversationStep += 1;
    const r = await searchWithFilters(asFilters(session.filters), run, { page: session.page });
    session.lastShown = r.shown ?? [];
    store.save(sessionId, session);
    return `Filters: ${describeFilters(r.filters)}\n${r.text}`;
  }

  // --- normal turn: parse, merge, then ask or search ------------------------------
  const parsed = parsePropertyQuery(message, { cities: opts.cities });
  if (parsed.warnings.length > 0) return parsed.warnings.join("\n");

  const before = JSON.stringify(session.filters);
  session.filters = mergeFilters(session.filters, parsed);
  if (JSON.stringify(session.filters) !== before) session.page = 1; // filters changed: restart paging
  session.conversationStep += 1;
  const f = session.filters;

  // Follow-up questions. Each is asked at most once, so the user is never stuck in a loop.
  let question: string | null = null;
  if (!f.city) {
    question = "Which city are you interested in?";
  } else if (f.maxPrice == null && !session.asked.includes("budget")) {
    session.asked.push("budget");
    question = "What is your budget?";
  } else if (f.types == null && !session.asked.includes("type")) {
    session.asked.push("type");
    question = "Any preference: condo, townhome, or single family?";
  }
  if (question) {
    store.save(sessionId, session);
    return question;
  }

  const r = await searchWithFilters(asFilters(f), run, { page: session.page });
  session.lastShown = r.shown ?? [];
  store.save(sessionId, session);
  return `Filters: ${describeFilters(r.filters)}\n${r.text}\n\n${HINT}`;
}
