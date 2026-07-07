import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('completeJson does not amplify retries: persistently bad JSON = 3 calls, not 9', async () => {
    let calls = 0;
    const client = new LlmClient({
      model: 'test',
      transport: async () => {
        calls++;
        return 'still not json';
      },
    });
    await expect(client.completeJson({ system: 's', user: 'u' }, z.object({ n: z.number() }))).rejects.toBeDefined();
    expect(calls).toBe(3); // one transport call per attempt, no nested complete() retry loop
  });

  it('completeJson retries transport failures (not just parse failures)', async () => {
    let calls = 0;
    const client = new LlmClient({
      model: 'test',
      transport: async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return '{"n": 7}';
      },
    });
    const out = await client.completeJson({ system: 's', user: 'u' }, z.object({ n: z.number() }));
    expect(out.n).toBe(7);
    expect(calls).toBe(2);
  }, 15_000);

  it('throws LlmUnavailableError without api key and without retrying', async () => {
    const client = new LlmClient({ model: 'test' });
    await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe('LlmClient — OpenAI provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts chat/completions with system+user messages and parses the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi from openai' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LlmClient({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' });
    const out = await client.complete({ system: 'sys', user: 'usr' });
    expect(out).toBe('hi from openai');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('surfaces OpenAI HTTP errors (retryable via complete())', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    vi.stubGlobal('fetch', fetchMock);
    const client = new LlmClient({ provider: 'openai', apiKey: 'sk-bad', model: 'gpt-4o' });
    await expect(client.complete({ system: 's', user: 'u' })).rejects.toThrow(/OpenAI 401/);
  }, 15_000);
});
