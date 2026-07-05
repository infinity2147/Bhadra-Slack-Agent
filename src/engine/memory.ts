/**
 * Institutional memory (spec §6.4): local embeddings + cosine recall over past
 * incidents, fused with RTS keyword echoes into the 🧠 card.
 *
 * Embeddings: @xenova/transformers all-MiniLM-L6-v2 in-process. If the model
 * can't load (offline sandbox), degrade to a deterministic hashed bag-of-words
 * vector so recall still works. Force with SENTINEL_EMBEDDER=hash|model.
 */
import { signalsForIncident, type Database, type Incident } from '../db/index.js';
import { storeEmbedding, topKSimilar } from '../db/embeddings.js';
import type { LlmClient } from '../llm/client.js';
import { memoryFuse } from '../llm/prompts.js';
import type { RtsClient } from '../rts/client.js';
import { logger } from '../util/logger.js';
import { minutesAgo } from '../util/time.js';
import type { Block } from '../slack/blocks/warroom.js';

export const EMBED_DIM = 384;

/** Deterministic fallback embedder: hashed bag of words + bigrams, L2-normalized. */
export function hashEmbed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const grams = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % EMBED_DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

type Embedder = (text: string) => Promise<Float32Array>;

let embedderPromise: Promise<Embedder> | null = null;

async function loadEmbedder(): Promise<Embedder> {
  if (process.env.SENTINEL_EMBEDDER === 'hash') return async (t) => hashEmbed(t);
  try {
    const { pipeline } = await import('@xenova/transformers');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    logger.info('embeddings: all-MiniLM-L6-v2 loaded');
    return async (text: string) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data as Float32Array);
    };
  } catch (err) {
    logger.warn({ err }, 'embeddings model unavailable — falling back to hashed vectors');
    return async (t) => hashEmbed(t);
  }
}

export async function embedText(text: string): Promise<Float32Array> {
  embedderPromise ??= loadEmbedder();
  return (await embedderPromise)(text);
}

export interface SimilarIncident {
  incident: Incident;
  score: number;
}

export function incidentEmbeddingText(inc: Incident): string {
  return [inc.title, inc.service, inc.summary, inc.root_cause, inc.resolution].filter(Boolean).join('. ');
}

export class MemoryEngine {
  constructor(
    private db: Database,
    private llm: LlmClient | null,
    private rts?: RtsClient,
  ) {}

  /** Embed + store an incident (on resolve, and from the seed script). */
  async indexIncident(incident: Incident): Promise<void> {
    const vec = await embedText(incidentEmbeddingText(incident));
    storeEmbedding(this.db, incident.id, vec);
  }

  async recall(queryText: string, k = 3, threshold = 0.6, excludeId?: string): Promise<SimilarIncident[]> {
    const vec = await embedText(queryText);
    const hits = topKSimilar(this.db, vec, k, threshold, excludeId);
    const out: SimilarIncident[] = [];
    for (const h of hits) {
      const inc = this.db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(h.incidentId) as Incident | undefined;
      if (inc) out.push({ incident: inc, score: h.score });
    }
    return out;
  }

  /** Recall query for a new incident: title + its clustered signals (spec §6.4). */
  recallQueryFor(incident: Incident): string {
    const signals = signalsForIncident(this.db, incident.id)
      .map((s) => s.text)
      .filter(Boolean)
      .slice(0, 5)
      .join('. ');
    return `${incident.title}. ${incident.service ?? ''}. ${signals}`;
  }

  /** One-liner for the triage card: "INC-042 (83% match) — ..., resolved in 22 min." */
  async similarLine(queryText: string): Promise<string | undefined> {
    const [top] = await this.recall(queryText, 1, 0.35);
    if (!top) return undefined;
    const mins = top.incident.resolved_at
      ? Math.round((top.incident.resolved_at - top.incident.started_at) / 60)
      : null;
    return `Similar past: *${top.incident.id}* (${Math.round(top.score * 100)}% match) — ${top.incident.title}${mins ? `, resolved in ${mins} min` : ''}.`;
  }

  /** Full 🧠 card for the war room. */
  async memoryCard(incident: Incident): Promise<Block[] | undefined> {
    const query = this.recallQueryFor(incident);
    const similar = await this.recall(query, 3, 0.35, incident.id);
    if (similar.length === 0) return undefined;

    let rtsEchoes: string[] = [];
    if (this.rts) {
      try {
        const terms = (incident.service ?? incident.title).split(/\s+/).slice(0, 3).join(' ');
        const echoes = await this.rts.searchMessages({ query: `${terms} in:#inc-*`, after: minutesAgo(60 * 24 * 180) });
        rtsEchoes = echoes.slice(0, 3).map((e) => e.text);
      } catch (err) {
        logger.warn({ err }, 'RTS echo lookup failed');
      }
    }

    let copy: string;
    if (this.llm) {
      try {
        copy = await this.llm.complete({
          system: memoryFuse.system,
          user: memoryFuse.buildUser(
            { title: incident.title, service: incident.service, signalsText: query },
            similar,
            rtsEchoes,
          ),
          temperature: memoryFuse.temperature,
        });
      } catch (err) {
        logger.warn({ err }, 'memoryFuse LLM failed; using template copy');
        copy = templateCopy(similar);
      }
    } else {
      copy = templateCopy(similar);
    }

    const top = similar[0];
    const blocks: Block[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `🧠 *Institutional memory*\n${copy}` } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'open_past_incident',
            text: { type: 'plain_text', text: `📋 Open ${top.incident.id} postmortem`, emoji: true },
            value: top.incident.id,
          },
          ...(top.incident.commander_user_id
            ? [
                {
                  type: 'button',
                  action_id: 'page_resolver',
                  text: { type: 'plain_text', text: `📟 Page resolver`, emoji: true },
                  value: `${top.incident.commander_user_id}|${incident.id}`,
                },
              ]
            : []),
        ],
      },
    ];
    return blocks;
  }
}

function templateCopy(similar: SimilarIncident[]): string {
  return similar
    .map((s) => {
      const mins = s.incident.resolved_at ? Math.round((s.incident.resolved_at - s.incident.started_at) / 60) : null;
      const date = new Date(s.incident.started_at * 1000).toISOString().slice(0, 10);
      const resolver = s.incident.commander_user_id ? ` Resolver <@${s.incident.commander_user_id}>.` : '';
      return `• ${Math.round(s.score * 100)}% match: *${s.incident.id}* (${date}) _${s.incident.title}_. ${s.incident.resolution ?? ''}${mins ? ` (${mins} min).` : ''}${resolver}`;
    })
    .join('\n');
}
