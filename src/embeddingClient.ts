// Gemini embeddings over plain HTTPS (batchEmbedContents). The API key travels in a header, never in a URL,
// and never appears in error messages.
export interface Embedder {
  model: string;
  dims: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface EmbedderOptions {
  apiKey: string;
  model?: string;
  dims?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export const DEFAULT_MODEL = "gemini-embedding-001";
export const DEFAULT_DIMS = 768;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const BATCH_SIZE = 100; // API limit per batch request
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function normalize(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function createEmbedder(opts: EmbedderOptions): Embedder {
  if (!opts.apiKey) throw Object.assign(new Error("GEMINI_API_KEY is not set"), { code: "ENV_MISSING" });
  const model = opts.model ?? DEFAULT_MODEL;
  const dims = opts.dims ?? DEFAULT_DIMS;
  const doFetch = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 6;

  async function batch(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<Float32Array[]> {
    const body = JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: dims,
      })),
    });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${BASE_URL}/models/${model}:batchEmbedContents`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body,
        });
      } catch {
        if (attempt >= maxRetries) throw Object.assign(new Error("embedding request failed"), { code: "EMBED_NETWORK" });
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
        const rows = json.embeddings ?? [];
        if (rows.length !== texts.length || rows.some((r) => !r.values || r.values.length !== dims)) {
          throw Object.assign(new Error("unexpected embedding response"), { code: "EMBED_BAD_RESPONSE" });
        }
        return rows.map((r) => normalize(r.values as number[]));
      }
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      throw Object.assign(new Error(`embedding request failed (HTTP ${res.status})`), { code: `EMBED_HTTP_${res.status}` });
    }
  }

  return {
    model,
    dims,
    async embedDocuments(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        out.push(...(await batch(texts.slice(i, i + BATCH_SIZE), "RETRIEVAL_DOCUMENT")));
      }
      return out;
    },
    async embedQuery(text) {
      return (await batch([text], "RETRIEVAL_QUERY"))[0];
    },
  };
}
