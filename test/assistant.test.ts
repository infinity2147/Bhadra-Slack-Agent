import { beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index.js';
import { answerIncidentQuestion } from '../src/engine/assistant.js';
import { MemoryEngine } from '../src/engine/memory.js';
import { LlmClient } from '../src/llm/client.js';
import type { RtsClient } from '../src/rts/client.js';

// Force the deterministic embedder — no model download in tests (matches memory.test.ts).
beforeAll(() => {
  process.env.SENTINEL_EMBEDDER = 'hash';
});

describe('answerIncidentQuestion — Real-Time Search integration', () => {
  it('queries RTS for live workspace echoes and folds them into the grounding context', async () => {
    const db = openDb();
    const memory = new MemoryEngine(db, null, undefined);
    // Echo transport back so we can assert what context the LLM was grounded on.
    const llm = new LlmClient({ model: 'test', transport: async ({ user }) => user });

    const searchMessages = vi.fn().mockResolvedValue([
      { channelId: 'C9', ts: '1.0', userId: 'U5', text: 'checkout returning 500s right now' },
    ]);
    const rts = { searchMessages } as unknown as RtsClient;

    const answer = await answerIncidentQuestion(
      { db, llm, memory, rts, channels: ['C9'] },
      'is checkout broken?',
    );

    expect(searchMessages).toHaveBeenCalledOnce();
    expect(searchMessages).toHaveBeenCalledWith({ query: 'is checkout broken?', channels: ['C9'] });
    expect(answer).toContain('Real-Time Search');
    expect(answer).toContain('checkout returning 500s right now');
  });

  it('degrades gracefully to memory-only when RTS throws', async () => {
    const db = openDb();
    const memory = new MemoryEngine(db, null, undefined);
    const rts = { searchMessages: vi.fn().mockRejectedValue(new Error('no user token')) } as unknown as RtsClient;
    // No LLM → deterministic grounded fallback; empty memory → the honest "no record".
    const answer = await answerIncidentQuestion({ db, llm: null, memory, rts }, 'what broke?');
    expect(answer).toBe("I don't have record of that.");
  });
});
