import { beforeAll, describe, expect, it } from 'vitest';
import { insertIncident, openDb, type Incident } from '../src/db/index.js';
import { hashEmbed, incidentEmbeddingText, MemoryEngine } from '../src/engine/memory.js';
import { cosineSimilarity, storeEmbedding } from '../src/db/embeddings.js';

// Force the deterministic fallback embedder — no model download in tests.
beforeAll(() => {
  process.env.SENTINEL_EMBEDDER = 'hash';
});

function seedIncident(id: string, title: string, extra: Partial<Incident> = {}): Incident {
  return {
    id,
    title,
    status: 'postmortem_done',
    severity: 'SEV2',
    service: 'checkout',
    channel_id: null,
    triage_thread_ts: null,
    commander_user_id: 'USAM',
    comms_user_id: null,
    scribe_user_id: null,
    started_at: 1741788180,
    detected_at: 1741788180,
    resolved_at: 1741788180 + 22 * 60,
    cost_estimate_usd: 3960,
    is_drill: 0,
    summary: null,
    root_cause: null,
    resolution: null,
    postmortem_doc: null,
    ...extra,
  };
}

describe('hashEmbed fallback', () => {
  it('is deterministic and normalized', () => {
    const a = hashEmbed('redis pool exhaustion checkout');
    const b = hashEmbed('redis pool exhaustion checkout');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('scores related text above unrelated text', () => {
    const q = hashEmbed('checkout redis connection pool timeouts');
    const related = hashEmbed('redis connection pool exhaustion during checkout deploy');
    const unrelated = hashEmbed('elasticsearch shard relocation slow search cluster');
    expect(cosineSimilarity(q, related)).toBeGreaterThan(cosineSimilarity(q, unrelated));
  });
});

describe('MemoryEngine.recall', () => {
  it('returns INC-042 as top match for a redis/checkout query', async () => {
    const db = openDb();
    const memory = new MemoryEngine(db, null);

    const inc42 = seedIncident('INC-042', 'Redis connection pool exhaustion during checkout deploy', {
      summary: 'Checkout latency spiked; redis connection pool exhausted after deploy.',
      resolution: 'Restarted pool, raised max_connections 128 to 512.',
    });
    const inc41 = seedIncident('INC-041', 'Search cluster ES shard relocation storm', {
      service: 'search',
      summary: 'Search slow while elasticsearch relocated shards.',
    });
    for (const inc of [inc42, inc41]) {
      insertIncident(db, inc);
      await memory.indexIncident(inc);
    }

    const hits = await memory.recall('checkout is slow, seeing redis pool timeouts', 3, 0.1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].incident.id).toBe('INC-042');
  });

  it('similarLine formats the flagship one-liner', async () => {
    const db = openDb();
    const memory = new MemoryEngine(db, null);
    const inc = seedIncident('INC-042', 'Redis connection pool exhaustion during checkout deploy', {
      summary: 'redis pool exhausted, checkout timeouts',
    });
    insertIncident(db, inc);
    storeEmbedding(db, inc.id, hashEmbed(incidentEmbeddingText(inc)));

    const line = await memory.similarLine('checkout redis pool exhausted timeouts deploy');
    expect(line).toContain('INC-042');
    expect(line).toContain('% match');
    expect(line).toContain('22 min');
  });

  it('returns no matches when history is empty', async () => {
    const db = openDb();
    const memory = new MemoryEngine(db, null);
    expect(await memory.recall('anything', 3, 0.3)).toEqual([]);
    expect(await memory.similarLine('anything')).toBeUndefined();
  });
});
