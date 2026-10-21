import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTurn, mergeFilters } from "../src/conversation.ts";
import { emptyFilters, newSession, safeId, type SessionStore, type UserSession } from "../src/sessionStore.ts";
import { parsePropertyQuery } from "../src/parsePropertyQuery.ts";

const cities = ["Irvine", "Palm Desert"];

function memStore(): SessionStore & { data: Map<string, UserSession> } {
  const data = new Map<string, UserSession>();
  return {
    data,
    load: (id) => data.get(id) ?? null,
    save: (id, s) => void data.set(id, structuredClone(s)),
    clear: (id) => void data.delete(id),
  };
}

function fakeRun() {
  const calls: { sql: string; params: (string | number)[] }[] = [];
  const run = async (sql: string, params: (string | number)[]) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT COUNT")) return [{ total: 1 }];
    return [{ L_Address: "142 Hedge Bloom", L_City: "Irvine", L_Zip: "92618", L_SystemPrice: 1100000, L_Keyword2: 3, LM_Dec_3: 2, LM_Int2_3: 1500, L_Type_: "SingleFamilyResidence", PhotoCount: 13, PoolPrivateYN: "", ViewYN: "", AssociationFee: null }];
  };
  return { run, calls };
}

test("handbook example: asks budget, then type, then searches", async () => {
  const store = memStore();
  const { run, calls } = fakeRun();
  const turn = (m: string) => handleTurn("u1", m, run, store, { cities });

  assert.match(await turn("Find homes in Irvine"), /budget/i);
  assert.equal(calls.length, 0, "no database call while still asking");
  assert.match(await turn("Under $1.2M"), /condo, townhome, or single family/i);
  const final = await turn("Single family with at least 3 beds");
  assert.match(final, /142 Hedge Bloom, Irvine, CA 92618/);
  assert.match(final, /\$1,100,000/);
  assert.match(final, /3 bd \| 2 ba/);
  assert.match(final, /13 photos/);
  assert.ok(calls.length > 0);
  const f = store.data.get("u1")!.filters;
  assert.equal(f.city, "Irvine");
  assert.equal(f.maxPrice, 1200000);
  assert.equal(f.beds, 3);
});

test("a question is asked only once, even if the user answers vaguely", async () => {
  const store = memStore();
  const { run, calls } = fakeRun();
  const turn = (m: string) => handleTurn("u2", m, run, store, { cities });
  await turn("homes in Irvine");
  await turn("not sure");
  const out = await turn("anything is fine");
  assert.ok(calls.length > 0, "searches instead of looping");
  assert.match(out, /Filters:/);
});

test("refinement overrides one filter and keeps the rest", async () => {
  const store = memStore();
  const { run } = fakeRun();
  const turn = (m: string) => handleTurn("u3", m, run, store, { cities });
  await turn("3 bed single family in Irvine under 1.2M");
  await turn("only 4 beds");
  const f = store.data.get("u3")!.filters;
  assert.equal(f.beds, 4);
  assert.equal(f.city, "Irvine");
  assert.equal(f.maxPrice, 1200000);
});

test("--more advances the page; changing filters resets it", async () => {
  const store = memStore();
  const { run } = fakeRun();
  await handleTurn("u4", "3 bed single family in Irvine under 1.2M", run, store, { cities });
  await handleTurn("u4", "", run, store, { cities, more: true });
  assert.equal(store.data.get("u4")!.page, 2);
  await handleTurn("u4", "under 900k", run, store, { cities });
  assert.equal(store.data.get("u4")!.page, 1);
});

test("start over clears the session; sessions are isolated per user", async () => {
  const store = memStore();
  const { run } = fakeRun();
  await handleTurn("a", "homes in Irvine", run, store, { cities });
  await handleTurn("b", "homes in Palm Desert", run, store, { cities });
  assert.equal(store.data.get("a")!.filters.city, "Irvine");
  assert.equal(store.data.get("b")!.filters.city, "Palm Desert");
  await handleTurn("a", "start over", run, store, { cities });
  assert.equal(store.data.has("a"), false);
  assert.equal(store.data.has("b"), true);
});

test("land requests are refused without touching the session or database", async () => {
  const store = memStore();
  const { run, calls } = fakeRun();
  const out = await handleTurn("u5", "vacant land in Irvine", run, store, { cities });
  assert.equal(calls.length, 0);
  assert.ok(out.length > 0);
});

test("session ids cannot escape the sessions folder", () => {
  assert.equal(safeId("../../etc/passwd"), "______etc_passwd");
  assert.equal(safeId(""), "default");
});

test("mergeFilters keeps remembered values when the new message has none", () => {
  const base = { ...emptyFilters(), city: "Irvine", beds: 3 };
  const merged = mergeFilters(base, parsePropertyQuery("under 1M", { cities }));
  assert.equal(merged.city, "Irvine");
  assert.equal(merged.beds, 3);
  assert.equal(merged.maxPrice, 1000000);
  assert.ok(newSession().asked.length === 0);
});

test("'at least N beds' is not read as a city", () => {
  for (const q of ["Single family with at least 3 beds", "at least 2 baths", "at most 1.2M", "at least 3 beds in Irvine"]) {
    const f = parsePropertyQuery(q, { cities: ["Irvine"] });
    if (q.includes("Irvine")) assert.equal(f.city, "Irvine");
    else assert.equal(f.city, null, q);
  }
});
