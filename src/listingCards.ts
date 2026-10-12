// Turns DB rows into plain-text property cards. Never prints contact details.
export type Row = Record<string, unknown>;

const money = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : "n/a";
};
const num = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(n) : "?";
};
const yes = (v: unknown) => v === "1" || v === 1;

export function formatActiveCard(r: Row, i: number): string {
  const extras: string[] = [];
  if (yes(r.PoolPrivateYN)) extras.push("Pool");
  if (yes(r.ViewYN)) extras.push("View");
  const hoa = Number(r.AssociationFee);
  extras.push(Number.isFinite(hoa) && hoa > 0 ? `HOA ${money(hoa)}/mo` : "No HOA listed");
  return [
    `${i}. ${money(r.L_SystemPrice)} - ${r.L_Type_ ?? "Home"} in ${r.L_City ?? "unknown city"}`,
    `   ${num(r.L_Keyword2)} bd | ${num(r.LM_Dec_3)} ba | ${num(r.LM_Int2_3)} sqft`,
    `   ${extras.join(" | ")}`,
  ].join("\n");
}

export function formatSoldCard(r: Row, i: number): string {
  const close = Number(r.ClosePrice);
  const list = Number(r.ListPrice);
  let delta = "";
  if (close > 0 && list > 0) {
    const pct = ((close - list) / list) * 100;
    delta = Math.abs(pct) < 0.5 ? " (at list)" : ` (${Math.abs(pct).toFixed(1)}% ${pct > 0 ? "over" : "under"} list)`;
  }
  return [
    `${i}. Sold ${money(r.ClosePrice)}${delta} - ${r.PropertySubType ?? "Home"} in ${r.City ?? "unknown city"}`,
    `   ${num(r.BedroomsTotal)} bd | ${num(r.BathroomsTotalInteger)} ba | ${num(r.LivingArea)} sqft | closed ${String(r.CloseDate ?? "?").slice(0, 10)}`,
  ].join("\n");
}

export function formatResults(
  rows: Row[],
  total: number,
  source: "active" | "sold",
  page: number,
  limit: number,
): string {
  if (rows.length === 0) return "No matching listings found. Try loosening a filter (price, beds, or type).";
  const start = (page - 1) * limit;
  const cards = rows.map((r, k) => (source === "sold" ? formatSoldCard(r, start + k + 1) : formatActiveCard(r, start + k + 1)));
  const shown = Math.min(total, 50);
  const lines = [`Showing ${start + 1}-${start + rows.length} of ${total}${total > 50 ? " (first 50 available)" : ""}`, "", ...cards];
  if (start + rows.length < shown) lines.push("", `Ask for page ${page + 1} to see more.`);
  return lines.join("\n");
}
