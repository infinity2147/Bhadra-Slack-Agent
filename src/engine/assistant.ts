/**
 * Assistant Q&A (spec §6.9): natural-language answers over the incident DB +
 * memory recall + RTS echoes, grounded via prompt P8.
 */
import { listIncidents, type Database, type Incident } from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { askIncidents } from '../llm/prompts.js';
import type { RtsClient } from '../rts/client.js';
import { logger } from '../util/logger.js';
import { fmtDuration } from '../util/time.js';
import type { MemoryEngine } from './memory.js';

function describeIncident(inc: Incident, score?: number): string {
  const dur = inc.resolved_at ? fmtDuration(inc.resolved_at - inc.started_at) : 'ongoing';
  const date = new Date(inc.started_at * 1000).toISOString().slice(0, 10);
  // `score != null`, not truthiness — a legitimate 0 similarity would be dropped.
  const rel = score != null ? ` (${Math.round(score * 100)}% relevant)` : '';
  return `${inc.id}${rel} [${date}] "${inc.title}" service=${inc.service} status=${inc.status} duration=${dur} | summary: ${inc.summary ?? '—'} | root cause: ${inc.root_cause ?? '—'} | resolution: ${inc.resolution ?? '—'}`;
}

/**
 * Pull live workspace chatter relevant to the question via Real-Time Search
 * (spec §6.3). This is what makes the assistant answer over *what's happening
 * right now*, not just the historical incident DB — the whole point of RTS.
 * Best-effort: any failure degrades to memory-only answers.
 */
async function liveEchoes(rts: RtsClient | undefined, question: string, channels?: string[]): Promise<string[]> {
  if (!rts) return [];
  try {
    const hits = await rts.searchMessages({ query: question, channels });
    return hits.slice(0, 5).map((h) => `<#${h.channelId}> <@${h.userId}>: ${h.text.slice(0, 200)}`);
  } catch (err) {
    logger.warn({ err }, 'assistant RTS echo search failed; answering from memory only');
    return [];
  }
}

export async function answerIncidentQuestion(
  deps: { db: Database; llm: LlmClient | null; memory: MemoryEngine; rts?: RtsClient; channels?: string[] },
  question: string,
): Promise<string> {
  // Retrieval: vector recall + recent incident roster + live RTS workspace echoes.
  const [similar, echoes] = await Promise.all([
    deps.memory.recall(question, 3, 0.15),
    liveEchoes(deps.rts, question, deps.channels),
  ]);
  const recent = listIncidents(deps.db, { limit: 8 });
  const seen = new Set<string>();
  const contextLines: string[] = [];
  for (const s of similar) {
    contextLines.push(describeIncident(s.incident, s.score));
    seen.add(s.incident.id);
  }
  for (const inc of recent) {
    if (!seen.has(inc.id)) contextLines.push(describeIncident(inc));
  }
  if (echoes.length > 0) {
    contextLines.push('', 'Live workspace chatter (Real-Time Search):', ...echoes);
  }
  const context = contextLines.join('\n');

  if (deps.llm) {
    try {
      return (
        await deps.llm.complete({
          system: askIncidents.system,
          user: askIncidents.buildUser(question, context),
          temperature: askIncidents.temperature,
        })
      ).trim();
    } catch (err) {
      logger.warn({ err }, 'assistant LLM failed; falling back to retrieval summary');
    }
  }

  // Grounded fallback without LLM: show what retrieval found, never invent.
  if (similar.length === 0) return "I don't have record of that.";
  return `Closest matches from incident memory:\n${similar
    .map((s) => `• *${s.incident.id}* — ${s.incident.title}${s.incident.resolution ? `. Fix: ${s.incident.resolution}` : ''}`)
    .join('\n')}`;
}
