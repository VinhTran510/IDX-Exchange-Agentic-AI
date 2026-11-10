// Per-user conversation state for the multi-turn search.
// The skill runs as a fresh process on every call, so state is kept in a small JSON file
// per user (git-ignored folder), not in an in-memory Map.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PropertyFilters } from "./parsePropertyQuery.ts";

export type SessionFilters = Omit<PropertyFilters, "warnings">;

export interface UserSession {
  filters: SessionFilters;
  asked: string[]; // follow-up questions already asked ("budget", "type"), so we never ask twice
  page: number;
  conversationStep: number;
  updatedAt: number;
  /** Listings shown most recently, so "more like #3" can find the listing. n = the number on the card. */
  lastShown?: { n: number; id: string }[];
}

export interface SessionStore {
  load(id: string): UserSession | null;
  save(id: string, session: UserSession): void;
  clear(id: string): void;
}

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function emptyFilters(): SessionFilters {
  return { city: null, minPrice: null, maxPrice: null, beds: null, baths: null, sqft: null, types: null, pool: null, hasView: null, maxHoa: null };
}

export function newSession(): UserSession {
  return { filters: emptyFilters(), asked: [], page: 1, conversationStep: 0, updatedAt: Date.now() };
}

/** Session ids become file names, so allow only a safe character set. */
export function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "default";
}

export function fileStore(dir: string): SessionStore {
  const path = (id: string) => join(dir, `${safeId(id)}.json`);
  return {
    load(id) {
      try {
        const s = JSON.parse(readFileSync(path(id), "utf8")) as UserSession;
        if (Date.now() - s.updatedAt > SESSION_TTL_MS) return null;
        return s;
      } catch {
        return null;
      }
    },
    save(id, session) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path(id), JSON.stringify({ ...session, updatedAt: Date.now() }), { mode: 0o600 });
    },
    clear(id) {
      rmSync(path(id), { force: true });
    },
  };
}
