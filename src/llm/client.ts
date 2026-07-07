import Anthropic from '@anthropic-ai/sdk';
import type { ZodSchema } from 'zod';
import { logger } from '../util/logger.js';

export class LlmUnavailableError extends Error {}

export interface CompleteOpts {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

/** Minimal transport seam so tests can fake the Anthropic API. */
export type LlmTransport = (opts: CompleteOpts & { model: string }) => Promise<string>;

function anthropicTransport(apiKey: string): LlmTransport {
  const client = new Anthropic({ apiKey });
  return async ({ model, system, user, temperature, maxTokens }) => {
    const res = await client.messages.create({
      model,
      system,
      max_tokens: maxTokens ?? 2048,
      temperature: temperature ?? 0.2,
      messages: [{ role: 'user', content: user }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return text;
  };
}

/** OpenAI Chat Completions transport (via fetch — no extra dependency). */
function openaiTransport(apiKey: string, baseUrl = 'https://api.openai.com/v1'): LlmTransport {
  return async ({ model, system, user, temperature, maxTokens }) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: temperature ?? 0.2,
        max_tokens: maxTokens ?? 2048,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  };
}

/** Strip ```json ... ``` fences the model sometimes adds despite instructions. */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

export class LlmClient {
  private transport: LlmTransport;
  private model: string;

  constructor(opts: {
    apiKey?: string;
    model: string;
    provider?: 'anthropic' | 'openai';
    baseUrl?: string;
    transport?: LlmTransport;
  }) {
    this.model = opts.model;
    if (opts.transport) {
      this.transport = opts.transport;
    } else if (opts.apiKey && opts.provider === 'openai') {
      this.transport = openaiTransport(opts.apiKey, opts.baseUrl);
    } else if (opts.apiKey) {
      this.transport = anthropicTransport(opts.apiKey);
    } else {
      this.transport = async () => {
        throw new LlmUnavailableError('no LLM API key set');
      };
    }
  }

  /** A single transport call — the one place the network is actually hit. */
  private once(opts: CompleteOpts): Promise<string> {
    return this.transport({ ...opts, model: this.model });
  }

  /** 2 retries with exponential backoff. */
  async complete(opts: CompleteOpts): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        return await this.once(opts);
      } catch (err) {
        if (err instanceof LlmUnavailableError) throw err;
        lastErr = err;
        const delay = 500 * 2 ** attempt;
        logger.warn({ err, attempt, delay }, 'LLM call failed; retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /**
   * once() + fence stripping + zod validation, with a single retry layer.
   * Transport failures and schema/parse failures both count as retryable, but
   * we call the transport directly (not `complete()`) so the two retry loops
   * don't compound into up to 9 API calls on a persistently bad response.
   */
  async completeJson<T>(opts: CompleteOpts, schema: ZodSchema<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      let raw: string;
      try {
        raw = await this.once(opts);
      } catch (err) {
        if (err instanceof LlmUnavailableError) throw err;
        lastErr = err;
        const delay = 500 * 2 ** attempt;
        logger.warn({ err, attempt, delay }, 'LLM call failed; retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(stripJsonFences(raw));
        return schema.parse(parsed);
      } catch (err) {
        lastErr = err;
        logger.warn({ err, attempt, raw: raw.slice(0, 300) }, 'LLM JSON parse/validate failed; retrying');
      }
    }
    throw lastErr;
  }
}
