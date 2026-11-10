// A small on-disk vector index: ids.txt, vectors.f32 (raw float32, unit length) and meta.json.
// Brute-force dot product is plenty fast at this size and needs no vector database.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface IndexMeta {
  model: string;
  dims: number;
  count: number;
  createdAt: string;
}

export interface Hit {
  id: string;
  score: number;
}

export class VectorIndex {
  meta: IndexMeta;
  ids: string[];
  vectors: Float32Array;

  constructor(meta: IndexMeta, ids: string[], vectors: Float32Array) {
    this.meta = meta;
    this.ids = ids;
    this.vectors = vectors;
  }

  rowById: Map<string, number> | null = null;

  /** The stored (unit-length) vector for a listing id, or null when that listing was not embedded. */
  vectorFor(id: string): Float32Array | null {
    if (!this.rowById) this.rowById = new Map(this.ids.map((v, i) => [v, i]));
    const row = this.rowById.get(id);
    if (row === undefined) return null;
    return this.vectors.subarray(row * this.meta.dims, (row + 1) * this.meta.dims);
  }

  /** Top k by cosine similarity (vectors are unit length, so a dot product). Optionally limited to `allowed` ids. */
  topK(query: Float32Array, k: number, allowed?: Set<string>): Hit[] {
    const dims = this.meta.dims;
    if (query.length !== dims) throw new Error("query vector size does not match the index");
    const best: Hit[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      if (allowed && !allowed.has(this.ids[i])) continue;
      let dot = 0;
      const off = i * dims;
      for (let j = 0; j < dims; j++) dot += query[j] * this.vectors[off + j];
      if (best.length < k || dot > best[best.length - 1].score) {
        best.push({ id: this.ids[i], score: dot });
        best.sort((a, b) => b.score - a.score);
        if (best.length > k) best.pop();
      }
    }
    return best;
  }
}

const paths = (dir: string) => ({
  ids: join(dir, "ids.txt"),
  vec: join(dir, "vectors.f32"),
  meta: join(dir, "meta.json"),
});

function readIds(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
}

/** Load the index, or null when none has been built. Tolerates a half-written last batch. */
export function loadIndex(dir: string): VectorIndex | null {
  const p = paths(dir);
  if (!existsSync(p.meta) || !existsSync(p.ids) || !existsSync(p.vec)) return null;
  const meta = JSON.parse(readFileSync(p.meta, "utf8")) as IndexMeta;
  const ids = readIds(p.ids);
  const buf = readFileSync(p.vec);
  const rows = Math.floor(buf.byteLength / (meta.dims * 4));
  const n = Math.min(ids.length, rows);
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * meta.dims * 4);
  return new VectorIndex({ ...meta, count: n }, ids.slice(0, n), new Float32Array(copy));
}

/** Appends vectors in batches so a long build can be stopped and resumed. */
export class IndexWriter {
  dir: string;
  model: string;
  dims: number;
  known: Set<string>;

  constructor(dir: string, model: string, dims: number) {
    this.dir = dir;
    this.model = model;
    this.dims = dims;
    mkdirSync(dir, { recursive: true });
    const p = paths(dir);
    if (existsSync(p.meta)) {
      const meta = JSON.parse(readFileSync(p.meta, "utf8")) as IndexMeta;
      if (meta.model !== model || meta.dims !== dims) {
        throw new Error("existing index was built with a different model or size; use a new folder or delete it");
      }
    }
    // Repair: keep only rows that have both an id and a full vector.
    const ids = readIds(p.ids);
    const rows = existsSync(p.vec) ? Math.floor(statSync(p.vec).size / (dims * 4)) : 0;
    const n = Math.min(ids.length, rows);
    writeFileSync(p.ids, ids.slice(0, n).map((i) => `${i}\n`).join(""));
    if (existsSync(p.vec)) truncateSync(p.vec, n * dims * 4);
    else writeFileSync(p.vec, "");
    this.known = new Set(ids.slice(0, n));
    this.writeMeta(n);
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  get count(): number {
    return this.known.size;
  }

  append(ids: string[], vectors: Float32Array[]): void {
    if (ids.length !== vectors.length) throw new Error("ids and vectors must be the same length");
    if (ids.length === 0) return;
    const p = paths(this.dir);
    const flat = new Float32Array(ids.length * this.dims);
    vectors.forEach((v, i) => {
      if (v.length !== this.dims) throw new Error("vector size does not match the index");
      flat.set(v, i * this.dims);
    });
    appendFileSync(p.vec, Buffer.from(flat.buffer));
    appendFileSync(p.ids, ids.map((i) => `${i}\n`).join(""));
    ids.forEach((i) => this.known.add(i));
    this.writeMeta(this.known.size);
  }

  private writeMeta(count: number): void {
    const meta: IndexMeta = { model: this.model, dims: this.dims, count, createdAt: new Date().toISOString() };
    writeFileSync(paths(this.dir).meta, JSON.stringify(meta));
  }
}
