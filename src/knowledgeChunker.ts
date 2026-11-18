// Turns the knowledge documents into retrievable chunks (pure functions, no I/O, no network).
// Each source gets a chunker that respects its structure: field tables are chunked one field per chunk
// instead of cutting every N characters, which would split rows in half.

export interface KChunk {
  id: string;
  source: string; // human-readable source name, shown as the citation
  heading: string; // section or field the chunk came from
  key?: string; // exact identifier (column or table name) used for exact-match boosting
  text: string; // what gets embedded and returned
}

export const SRC_PRIMER = "Real Estate Data Analyst Primer";
export const SRC_TRESTLE = "Trestle Property metadata (RESO field definitions)";
export const SRC_SCHEMA = "IDX schema reference (rets_property and california_sold)";
export const SRC_MARKET = "Market summaries (Week 5 analytics)";

export const MAX_CHUNK_CHARS = 1100;
export const OVERLAP_MAX_CHARS = 300;

/** Remove terminal escape sequences and control characters (the text may have been captured from a terminal). */
export function cleanText(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Camel-case, underscore or digit names are distinctive enough to match exactly ("YearBuilt", "L_City"). */
export function isDistinctiveKey(key: string): boolean {
  return /[_0-9]/.test(key) || /[a-z][A-Z]/.test(key);
}

// ---------------------------------------------------------------------------------------------
// Primer: prose with headings. Pack paragraphs under their heading, carry one paragraph of overlap.
// ---------------------------------------------------------------------------------------------

const PAGE_NOISE = /^\s*(?:page\s+\d+(?:\s+of\s+\d+)?)\s*$/i;

function splitSentences(p: string): string[] {
  return p.match(/[^.!?]+(?:[.!?]+|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [p];
}

export function chunkPrimer(raw: string): KChunk[] {
  const lines = cleanText(raw)
    .split("\n")
    .filter((l) => !PAGE_NOISE.test(l));
  const paras = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .map((l) => l.replace(/^\s*\u2022\s*/, "- ").replace(/\s{2,}/g, " | ").trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);

  const chunks: KChunk[] = [];
  let major = "";
  let minor = "";
  let buf: string[] = [];
  let bufHeading = "";
  let carry = "";

  const flush = () => {
    if (buf.length === 0) return;
    const body = [carry, ...buf].filter(Boolean).join("\n\n");
    chunks.push({
      id: `primer-${chunks.length + 1}`,
      source: SRC_PRIMER,
      heading: bufHeading,
      text: `[${SRC_PRIMER}: ${bufHeading}]\n${body}`,
    });
    const last = buf[buf.length - 1];
    carry = last.length <= OVERLAP_MAX_CHARS ? last : "";
    buf = [];
  };

  const headingOf = () => (minor ? `${major} > ${minor}` : major || "Introduction");

  for (const para of paras) {
    let p = para;
    // A heading is usually the first line of a paragraph (no blank line between it and its text).
    const first = p.split("\n")[0];
    const rest = p.split("\n").slice(1).join("\n");
    const isMajor = /^\d+\.\s+\S/.test(first) && first.length <= 90 && !first.includes(" | ");
    const isMinor =
      !isMajor &&
      first.length <= 60 &&
      /^[A-Z]/.test(first) &&
      !/[.:;,]$/.test(first) &&
      !first.includes(" | ") &&
      first.split(" ").length <= 8;
    if (isMajor || isMinor) {
      flush();
      carry = "";
      if (isMajor) {
        major = first;
        minor = "";
      } else minor = first;
      bufHeading = headingOf();
      if (!rest) continue;
      p = rest;
    }
    if (buf.length === 0) bufHeading = headingOf();
    const pieces = p.length > MAX_CHUNK_CHARS * 1.5 ? packSentences(p) : [p];
    for (const piece of pieces) {
      const size = buf.reduce((n, x) => n + x.length + 2, 0) + carry.length;
      if (buf.length > 0 && size + piece.length > MAX_CHUNK_CHARS) {
        flush();
        bufHeading = headingOf();
      }
      buf.push(piece);
    }
  }
  flush();
  return chunks;
}

function packSentences(p: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of splitSentences(p)) {
    if (cur && cur.length + s.length + 1 > MAX_CHUNK_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Trestle metadata: a 4-column layout table (Field, Type, Size, Description). pdftotext centers each
// description vertically around its field line, so descriptions can sit above and below the name.
// Blocks are separated by blank lines; every description line belongs to the nearest name line.
// ---------------------------------------------------------------------------------------------

const TRESTLE_NOISE = [/^https?:\/\//, /^\s*Property\s+\d{1,2}\/\d{1,2}\/\d{2,4}/, /Page \d+ of \d+\s*$/];

const startCol = (l: string) => l.length - l.trimStart().length;

export function parseTrestle(raw: string): KChunk[] {
  const text = cleanText(raw);
  const startAt = text.search(/^\s*Field\s+Type\s+Size\s+Description/m);
  const body = startAt >= 0 ? text.slice(startAt).split("\n").slice(1).join("\n") : text;
  const out: KChunk[] = [];
  const seen = new Set<string>();

  // pdftotext marks pages with \f, which cleanText turned into newlines; re-split on the page header line.
  const pages = body.split(/\n(?=\s*Property\s+\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const hasName = (b: string[]) => b.some((l) => startCol(l) < 20 && /^\s*[A-Za-z][A-Za-z0-9_]*(\s|$)/.test(l));
  let pending: string[] | null = null; // description lines left at the bottom of the previous page
  for (const page of pages) {
    const lines = page
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => !TRESTLE_NOISE.some((r) => r.test(l)));

    // Description column on this page = most common start column among deeply indented lines.
    const counts = new Map<number, number>();
    for (const l of lines) if (l.trim() && startCol(l) >= 40) counts.set(startCol(l), (counts.get(startCol(l)) ?? 0) + 1);
    let descCol = 0;
    let best = 0;
    for (const [c, n] of counts) if (n > best) ((descCol = c), (best = n));
    if (!descCol) descCol = 90;

    const blocks: string[][] = [];
    let cur: string[] = [];
    for (const l of lines) {
      if (!l.trim()) {
        if (cur.length) blocks.push(cur);
        cur = [];
      } else cur.push(l);
    }
    if (cur.length) blocks.push(cur);

    // A field's description can continue across a page break. Lines with no field name at the bottom of a page
    // belong to the first field of the next page; lines with no name at the top belong to the previous field.
    if (pending && blocks.length > 0 && hasName(blocks[0])) {
      blocks[0] = [...pending, ...blocks[0]];
      pending = null;
    }
    if (blocks.length > 0 && !hasName(blocks[0]) && out.length > 0) {
      const tail = squash(blocks.shift()!.join(" "));
      out[out.length - 1].text += ` ${tail}`;
    }
    pending = blocks.length > 0 && !hasName(blocks[blocks.length - 1]) ? blocks.pop()! : pending;

    for (const block of blocks) {
      const nameIdx: number[] = [];
      block.forEach((l, i) => {
        if (startCol(l) < 20 && /^\s*[A-Za-z][A-Za-z0-9_]*(\s|$)/.test(l)) nameIdx.push(i);
      });
      if (nameIdx.length === 0) continue;
      const parts = nameIdx.map((i) => ({ i, desc: [] as string[], line: block[i] }));
      block.forEach((l, i) => {
        if (nameIdx.includes(i)) return;
        let nearest = parts[0];
        for (const p of parts) if (Math.abs(p.i - i) < Math.abs(nearest.i - i)) nearest = p;
        // lines above the name line come first, lines below come after
        if (i < nearest.i) nearest.desc.unshift(l.trim());
        else nearest.desc.push(l.trim());
      });
      for (const p of parts) {
        const line = p.line;
        const name = line.trim().split(/\s+/)[0];
        const afterName = line.slice(line.indexOf(name) + name.length);
        const head = afterName.slice(0, Math.max(0, descCol - (line.indexOf(name) + name.length)));
        const inline = line.length > descCol ? line.slice(descCol).trim() : "";
        const meta = head.trim().split(/\s{2,}/).filter(Boolean);
        if (meta[0] === "InKey") meta.shift(); // flag column, not a type
        const type = meta[0] ?? "";
        const size = meta[1] && /^[\d.]+$/.test(meta[1]) ? meta[1] : "";
        // description pieces: lines above, the inline part, lines below (keeping vertical order)
        const above: string[] = [];
        const below: string[] = [];
        block.forEach((l, i) => {
          if (nameIdx.includes(i)) return;
          let nearest = parts[0];
          for (const q of parts) if (Math.abs(q.i - i) < Math.abs(nearest.i - i)) nearest = q;
          if (nearest !== p) return;
          (i < p.i ? above : below).push(l.trim());
        });
        const desc = squash([...above, inline, ...below].join(" "));
        const key = name;
        if (!desc) continue; // structural entries (Media, Rooms, ...) have no definition to retrieve
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `trestle-${out.length + 1}`,
          source: SRC_TRESTLE,
          heading: `Field ${name}`,
          key,
          text: `[${SRC_TRESTLE}] Field ${name}${type ? ` (type: ${type}${size ? `, size ${size}` : ""})` : ""}: ${desc}`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Handbook schema tables: fixed-width columns (Column, Type, Description). Long names wrap onto the
// next line ("ListAgentDirectPho" + "ne"), long descriptions wrap too.
// ---------------------------------------------------------------------------------------------

export interface SchemaColumn {
  table: string;
  name: string;
  type: string;
  desc: string;
}

const TABLE_BLURB: Record<string, string> = {
  rets_property: "Active MLS listings (current listings for sale). Uses a mix of IDX legacy column names (L_...) and RESO names.",
  california_sold: "Sold transactions (closed sales, used for comps and market statistics). Uses RESO-standard column names.",
};

export function parseSchemaColumns(raw: string): SchemaColumn[] {
  const lines = cleanText(raw).split("\n");
  const cols: SchemaColumn[] = [];
  let table = "";
  let colType = 30;
  let colDesc = 53;
  let prev: SchemaColumn | null = null;
  for (const l of lines) {
    if (/Key Join Pattern/.test(l)) break;
    const t = l.match(/^\s*(rets_property|california_sold)\s+[—–-]/);
    if (t) {
      table = t[1];
      prev = null;
      continue;
    }
    if (!table) continue;
    if (/^\s*Column\s+Type\s+Description/.test(l)) {
      colType = l.indexOf("Type");
      colDesc = l.indexOf("Description");
      continue;
    }
    if (/Confidential|IDX Exchange \|/.test(l) || !l.trim()) continue;
    const name = l.slice(0, colType).trim();
    const type = l.slice(colType, colDesc).trim();
    const desc = l.slice(colDesc).trim();
    const nameStartsAtMargin = l.length > 1 && l[0] === " " && l[1] !== " ";
    if (name && nameStartsAtMargin && (type || desc)) {
      prev = { table, name, type, desc };
      cols.push(prev);
    } else if (name && nameStartsAtMargin && prev) {
      prev.name += name; // wrapped column name
    } else if (!name && prev) {
      if (type) prev.type += ` ${type}`;
      if (desc) prev.desc += ` ${desc}`;
    }
  }
  return cols.map((c) => ({ ...c, desc: squash(c.desc), type: squash(c.type) }));
}

export function schemaChunks(columns: SchemaColumn[]): KChunk[] {
  const out: KChunk[] = [];
  const tables = [...new Set(columns.map((c) => c.table))];
  for (const table of tables) {
    const mine = columns.filter((c) => c.table === table);
    out.push({
      id: `schema-list-${table}`,
      source: SRC_SCHEMA,
      heading: `${table} column list`,
      key: table,
      text:
        `[${SRC_SCHEMA}] Table ${table}: ${TABLE_BLURB[table] ?? ""} ` +
        `It has ${mine.length} documented columns: ${mine.map((c) => c.name).join(", ")}.`,
    });
  }
  for (const c of columns) {
    out.push({
      id: `schema-${c.table}-${c.name}`,
      source: SRC_SCHEMA,
      heading: `${c.table}.${c.name}`,
      key: c.name,
      text: `[${SRC_SCHEMA}] Column ${c.name} in table ${c.table} (type ${c.type}): ${c.desc}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Market summaries: one chunk per "Market summary:" report.
// ---------------------------------------------------------------------------------------------

export function chunkMarket(raw: string): KChunk[] {
  const text = cleanText(raw).replace(/^[^\n]*?(?=Market summary:)/, "");
  const reports = text.split(/^(?=Market summary:)/m).map((r) => r.trim()).filter((r) => r.startsWith("Market summary:"));
  const out: KChunk[] = [];
  for (const r of reports) {
    const place = r.match(/^Market summary:\s*([^(\n]+)/)?.[1]?.trim() ?? "unknown";
    const paras = r.split(/\n\s*\n/);
    let cur = "";
    let part = 0;
    const emit = () => {
      if (!cur.trim()) return;
      part += 1;
      out.push({
        id: `market-${out.length + 1}`,
        source: SRC_MARKET,
        heading: `${place}${part > 1 ? ` (part ${part})` : ""}`,
        text: `[${SRC_MARKET}: ${place}]\n${cur.trim()}`,
      });
      cur = "";
    };
    for (const p of paras) {
      if (cur && cur.length + p.length > 2500) emit();
      cur += (cur ? "\n\n" : "") + p;
    }
    emit();
  }
  return out;
}
