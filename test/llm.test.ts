import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient, LlmUnavailableError, stripJsonFences } from '../src/llm/client.js';

describe('stripJsonFences', () => {
  it('strips ```json fences', () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips bare ``` fences', () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves clean JSON alone', () => {
    expect(stripJsonFences(' {"a":1} ')).toBe('{"a":1}');
  });
});

describe('LlmClient', () => {
  it('retries transport failures then succeeds', async () => {
    let calls = 0;
    const client = new LlmClient({
      model: 'test',
      transport: async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
    });
    await expect(client.complete({ system: 's', user: 'u' })).resolves.toBe('ok');
    expect(calls).toBe(3);
  }, 15_000);

  it('completeJson strips fences and validates schema, retrying bad JSON', async () => {
    let calls = 0;
    const client = new LlmClient({
      model: 'test',
      transport: async () => {
        calls++;
        if (calls === 1) return 'not json at all';
        return '```json\n{"n": 5}\n```';
      },
    });
    const result = await client.completeJson({ system: 's', user: 'u' }, z.object({ n: z.number() }));
    expect(result.n).toBe(5);
    expect(calls).toBe(2);
  });

  it('throws LlmUnavailableError without api key and without retrying', async () => {
    const client = new LlmClient({ model: 'test' });
    await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
