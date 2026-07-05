import type { Database } from './index.js';

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function storeEmbedding(db: Database, incidentId: string, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  db.prepare(
    `INSERT INTO embeddings (incident_id, vector) VALUES (?, ?)
     ON CONFLICT(incident_id) DO UPDATE SET vector = excluded.vector`,
  ).run(incidentId, buf);
}

export function getEmbedding(db: Database, incidentId: string): Float32Array | undefined {
  const row = db.prepare(`SELECT vector FROM embeddings WHERE incident_id = ?`).get(incidentId) as
    | { vector: Buffer }
    | undefined;
  if (!row) return undefined;
  return new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
}

/** Brute-force cosine scan — incident counts are small. */
export function topKSimilar(
  db: Database,
  vec: Float32Array,
  k: number,
  threshold: number,
  excludeIncidentId?: string,
): { incidentId: string; score: number }[] {
  const rows = db.prepare(`SELECT incident_id, vector FROM embeddings`).all() as {
    incident_id: string;
    vector: Buffer;
  }[];
  const scored: { incidentId: string; score: number }[] = [];
  for (const row of rows) {
    if (row.incident_id === excludeIncidentId) continue;
    const other = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    if (other.length !== vec.length) continue;
    const score = cosineSimilarity(vec, other);
    if (score >= threshold) scored.push({ incidentId: row.incident_id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
