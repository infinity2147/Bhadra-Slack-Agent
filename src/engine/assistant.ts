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
  return `${inc.id}${score ? ` (${Math.round(score * 100)}% relevant)` : ''} [${date}] "${inc.title}" service=${inc.service} status=${inc.status} duration=${dur} | summary: ${inc.summary ?? '—'} | root cause: ${inc.root_cause ?? '—'} | resolution: ${inc.resolution ?? '—'}`;
}

export async function answerIncidentQuestion(
  deps: { db: Database; llm: LlmClient | null; memory: MemoryEngine; rts?: RtsClient },
  question: string,
): Promise<string> {
  // Retrieval: vector recall + recent incident roster.
  const similar = await deps.memory.recall(question, 3, 0.15);
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
