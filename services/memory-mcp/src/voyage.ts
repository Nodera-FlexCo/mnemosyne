import { config } from './config.js';

const BASE = 'https://api.voyageai.com/v1';
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST to Voyage with retry on 429 / 5xx (honors Retry-After, else exp backoff + jitter). */
async function voyageFetch(path: string, body: unknown): Promise<Response> {
  let lastText = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.voyageApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs =
        retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(waitMs);
      continue;
    }
    lastText = await res.text();
    throw new Error(`voyage ${path} ${res.status}: ${lastText}`);
  }
  throw new Error(`voyage ${path} failed after ${MAX_ATTEMPTS} attempts: ${lastText}`);
}

/** Embed texts with the memory model (voyage-3.5, 1024-dim default). */
export async function embed(
  texts: string[],
  inputType: 'document' | 'query',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await voyageFetch('/embeddings', {
    input: texts,
    model: config.embedModel,
    input_type: inputType,
  });
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}

/** Rerank documents against a query; returns {index, score} for the top_k. */
export async function rerank(
  query: string,
  documents: string[],
  topK: number,
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];
  const res = await voyageFetch('/rerank', {
    query,
    documents,
    model: config.rerankModel,
    top_k: Math.min(topK, documents.length),
  });
  const json = (await res.json()) as {
    data?: Array<{ index: number; relevance_score: number }>;
    results?: Array<{ index: number; relevance_score: number }>;
  };
  const arr = json.data ?? json.results ?? [];
  return arr.map((d) => ({ index: d.index, score: d.relevance_score }));
}

/** Serialize an embedding to a pgvector/halfvec literal. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
