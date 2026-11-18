// Embedding, storage and retrieval for the knowledge base. Vectors are L2-normalized, so cosine = dot product.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDistinctiveKey, type KChunk } from "./knowledgeChunker.ts";

export const EMBED_MODEL = "gemini-embedding-001";
export const DIMS = 768;
export const BATCH_SIZE = 50;
export const TOP_K = 5;
export const MIN_SCORE = 0.65; // the best match must reach this, or the question is treated as not covered (calibrate with --debug)
export const RELATIVE_BAND = 0.1; // other passages must be within this of the best match

export type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export interface EmbedOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export async function embedTexts(texts: string[], taskType: TaskType, apiKey: string, opts: EmbedOptions = {}): Promise<number[][]> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i) as any);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 6;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      requests: batch.map((text) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: DIMS,
      })),
    });
    for (let attempt = 0; ; attempt++) {
      // the key goes in a header, never in the URL
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body });
      if (res.ok) {
        const data = await res.json();
        const embs = data.embeddings as { values: number[] }[] | undefined;
        if (!embs || embs.length !== batch.length) throw new Error("embedding response had the wrong size");
        for (const e of embs) out.push(normalize(e.values));
        break;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) throw new Error(`embedding request failed with HTTP ${res.status}`);
      await sleep(Math.min(60000, 2 ** attempt * 1000) + Math.floor(Math.random() * 500));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface KnowledgeIndex {
  chunks: KChunk[];
  vectors: Float32Array; // chunks.length * DIMS, row-major
}

export function writeIndex(dir: string, chunks: KChunk[], vectors: number[][]): void {
  if (chunks.length !== vectors.length) throw new Error("chunks and vectors differ in length");
  mkdirSync(dir, { recursive: true });
  const flat = new Float32Array(chunks.length * DIMS);
  vectors.forEach((v, i) => {
    if (v.length !== DIMS) throw new Error(`vector ${i} has ${v.length} dimensions, expected ${DIMS}`);
    flat.set(v, i * DIMS);
  });
  writeFileSync(join(dir, "chunks.json"), JSON.stringify({ model: EMBED_MODEL, dims: DIMS, chunks }));
  writeFileSync(join(dir, "vectors.f32"), Buffer.from(flat.buffer));
}

export function loadIndex(dir: string): KnowledgeIndex {
  const meta = JSON.parse(readFileSync(join(dir, "chunks.json"), "utf8")) as { model: string; dims: number; chunks: KChunk[] };
  const buf = readFileSync(join(dir, "vectors.f32"));
  if (meta.dims !== DIMS) throw new Error("index was built with different dimensions; rebuild it");
  if (buf.byteLength !== meta.chunks.length * DIMS * 4) throw new Error("index files do not match; rebuild it");
  const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { chunks: meta.chunks, vectors };
}

export interface Hit {
  chunk: KChunk;
  score: number;
  exact: boolean; // true when the question names this column/table exactly
}

export function retrieve(
  index: KnowledgeIndex,
  queryVec: number[],
  question: string,
  k = TOP_K,
  minScore = MIN_SCORE,
  band = RELATIVE_BAND,
): Hit[] {
  const tokens = new Set((question.match(/[A-Za-z0-9_]+/g) ?? []).map((t) => t.toLowerCase()));
  const hits: Hit[] = index.chunks.map((chunk, i) => {
    let dot = 0;
    const off = i * DIMS;
    for (let d = 0; d < DIMS; d++) dot += index.vectors[off + d] * queryVec[d];
    const exact = !!chunk.key && isDistinctiveKey(chunk.key) && tokens.has(chunk.key.toLowerCase());
    return { chunk, score: dot, exact };
  });
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  const best = hits.find((h) => !h.exact)?.score ?? 0; // best purely semantic score
  return hits.filter((h) => h.exact || (h.score >= minScore && h.score >= best - band)).slice(0, k);
}
