/**
 * ALL LLM prompts, centralized (spec §7). Each prompt exports:
 *   system   — system prompt
 *   buildUser(...) — user message builder
 *   schema   — zod schema for JSON prompts (omitted for free-text prompts)
 *   temperature — 0.2 classification / 0.7 drafting
 */
import { z } from 'zod';
import type { Incident, Interview, Signal, TimelineEvent } from '../db/index.js';
import type { DeployRecord } from '../ports.js';

const JSON_ONLY = 'Respond ONLY with JSON, no markdown fences, no prose before or after.';

export function formatTimeline(events: TimelineEvent[]): string {
  return events
    .map((e) => {
      const t = new Date(e.ts * 1000).toISOString().slice(11, 19);
      return `[${t}] (${e.kind}) ${e.actor ?? 'sentinel'}: ${e.content}`;
    })
    .join('\n');
}

// ── P1: signal classification ────────────────────────────────────────────────

export const signalCategorySchema = z.enum(['latency', 'errors', 'outage', 'confusion', 'deploy_suspicion']);

export const signalClassify = {
  temperature: 0.2,
  schema: z.object({
    results: z.array(
      z.object({
        index: z.number().int(),
        is_signal: z.boolean(),
        category: signalCategorySchema.nullable(),
        service_guess: z.string().nullable(),
        confidence: z.number().min(0).max(1),
      }),
    ),
  }),
  system: `You classify Slack messages from engineering channels as potential incident signals.

A SIGNAL is a message suggesting a real, current production problem: latency complaints ("checkout feels slow for anyone else?"), error reports ("seeing 500s on /cart", "timeouts hitting the API"), outage suspicion ("is search down?"), confusion about system behavior ("payments dashboard looks weird"), or suspicion that a recent deploy broke something.

NOISE is everything else, including:
- Social chatter: "anyone else down for lunch?", "the coffee machine is down again"
- Memes/jokes: "everything is down and on fire 🔥 (monday mood)", "my motivation has 100% error rate"
- Retrospective talk about past incidents: "remember when checkout was slow last month?"
- Hypotheticals, planning, code review chat, CI flakiness on a PR branch.

For each numbered message return: index, is_signal, category (one of latency|errors|outage|confusion|deploy_suspicion, or null when not a signal), service_guess (short lowercase service name like "checkout", "payments", "auth", "search" — null if unclear), confidence 0..1.

${JSON_ONLY} Shape: {"results":[{"index":0,"is_signal":true,"category":"latency","service_guess":"checkout","confidence":0.85}]}`,
  buildUser(messages: { text: string; channel?: string }[]): string {
    return messages.map((m, i) => `${i}. [#${m.channel ?? 'unknown'}] ${m.text}`).join('\n');
  },
};

// ── P2: cluster summarize (triage card) ──────────────────────────────────────

export const clusterSummarize = {
  temperature: 0.2,
  schema: z.object({
    title: z.string(),
    service: z.string(),
    severity_suggestion: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
    one_line: z.string(),
  }),
  system: `You summarize a cluster of trouble-signal Slack messages (and optionally recent deploys) into a crisp pre-incident triage summary.

Return: title (short incident title, e.g. "Checkout latency spike"), service (lowercase service name), severity_suggestion (SEV1 total outage / SEV2 major degradation / SEV3 partial / SEV4 minor), one_line (a single sentence connecting the signals, and the suspect deploy if one plausibly correlates).

${JSON_ONLY}`,
  buildUser(signals: Signal[], deploys: DeployRecord[]): string {
    const sig = signals.map((s) => `- [${s.category}] <@${s.user_id}>: ${s.text}`).join('\n');
    const dep =
      deploys.length > 0
        ? deploys.map((d) => `- ${d.service} ${d.id} "${d.title}" by ${d.author} at ${new Date(d.deployed_at * 1000).toISOString()}`).join('\n')
        : '(none in window)';
    return `Signals:\n${sig}\n\nRecent deploys:\n${dep}`;
  },
};

// ── P3: memory fuse (similar incidents card copy) ────────────────────────────

export const memoryFuse = {
  temperature: 0.7,
  system: `You write the "institutional memory" card for a new incident, fusing vector-similarity matches over past incidents with keyword echoes from past incident channels.

Write 1-3 short mrkdwn bullet lines, best match first. Each line: match % (from the provided score, as a whole percent), incident ID in bold, date, one-line description, how it was fixed and how long it took, and the resolver as <@USERID> if known. If candidates are weak or empty, say there is no strong historical match, in one line. Slack mrkdwn only (*bold*, _italic_), no headers, no JSON.`,
  buildUser(
    current: { title: string; service?: string | null; signalsText?: string },
    candidates: { incident: Incident; score: number }[],
    rtsEchoes: string[],
  ): string {
    const cand = candidates
      .map(
        (c) =>
          `- ${c.incident.id} (similarity ${(c.score * 100).toFixed(0)}%) [${new Date(c.incident.started_at * 1000).toISOString().slice(0, 10)}] ${c.incident.title} | summary: ${c.incident.summary ?? '—'} | root cause: ${c.incident.root_cause ?? '—'} | resolution: ${c.incident.resolution ?? '—'} | resolver: ${c.incident.commander_user_id ?? 'unknown'} | duration: ${c.incident.resolved_at ? Math.round((c.incident.resolved_at - c.incident.started_at) / 60) + ' min' : '—'}`,
      )
      .join('\n');
    return `Current incident: ${current.title} (service: ${current.service ?? 'unknown'})\nTop signals: ${current.signalsText ?? '—'}\n\nSimilar past incidents:\n${cand || '(none)'}\n\nKeyword echoes from past incident channels:\n${rtsEchoes.map((e) => `- ${e}`).join('\n') || '(none)'}`;
  },
};

// ── P4: resolve summarize ────────────────────────────────────────────────────

export const resolveSummarize = {
  temperature: 0.2,
  schema: z.object({
    summary: z.string(),
    root_cause: z.string(),
    resolution: z.string(),
  }),
  system: `You summarize a resolved incident from its timeline. Return JSON with:
- summary: 1-2 sentences, what happened and impact.
- root_cause: the most likely root cause stated in blameless systems language (name process/system gaps, never blame a person).
- resolution: what action actually fixed or mitigated it.
If the timeline is thin, be honest and generic rather than inventing specifics. ${JSON_ONLY}`,
  buildUser(timeline: TimelineEvent[]): string {
    return `Incident timeline:\n${formatTimeline(timeline)}`;
  },
};

// ── P5: status update in three registers ────────────────────────────────────

export type Register = 'engineering' | 'executive' | 'customer';

export const statusUpdate = {
  temperature: 0.7,
  system: `You draft an incident status update from recent timeline events, in one of three registers:
- engineering: technical, precise, current hypothesis, what's being tried, metrics. 3-5 sentences.
- executive: business impact, scope, ETA confidence, next update time. 2-3 sentences, no jargon.
- customer: calm public status-page copy. 1-2 sentences, no internal names, no blame, no speculation.
Output plain text only for the requested register. Never invent facts not in the timeline.`,
  buildUser(windowEvents: TimelineEvent[], register: Register, incident: Incident): string {
    return `Incident: ${incident.id} — ${incident.title} (severity ${incident.severity}, status ${incident.status})\nRegister: ${register}\n\nRecent events:\n${formatTimeline(windowEvents)}`;
  },
};

// ── P6: interview questions ──────────────────────────────────────────────────

export const interviewQuestions = {
  temperature: 0.7,
  schema: z.object({ questions: z.array(z.string()).min(2).max(3) }),
  system: `You are a blameless postmortem interviewer. Given one participant's actual messages during an incident, write 2-3 specific questions tailored to what THEY saw or did. Questions must be blameless (about systems, signals, and process — never "why did you..." accusations), concrete, and answerable in a few sentences. ${JSON_ONLY} Shape: {"questions":["...","..."]}`,
  buildUser(participantMessages: string[], incidentTitle: string): string {
    return `Incident: ${incidentTitle}\nParticipant's messages during the incident:\n${participantMessages.map((m) => `- ${m}`).join('\n')}`;
  },
};

// ── P7: postmortem synthesis ─────────────────────────────────────────────────

export const postmortemSynthesize = {
  temperature: 0.7,
  system: `You write a blameless postmortem in markdown from an incident record, its timeline, and interview answers.

Sections, in order: # Postmortem: <id> — <title>, ## Summary, ## Impact (include duration and the estimated cost), ## Timeline (bulleted, key moments only), ## Root cause, ## What went well, ## What went poorly, ## Action items (checkbox list, each with an owner and a due date suggestion), ## Lessons.

Blameless language is mandatory: attribute failures to systems and process gaps ("the deploy lacked a rollback gate"), never to individuals ("Dana broke it" is forbidden). Refer to people only as contributors to the fix. Output markdown only.`,
  buildUser(incident: Incident, timeline: TimelineEvent[], interviews: Interview[]): string {
    const iv = interviews
      .map((i) => `Q (<@${i.user_id}>): ${i.question}\nA: ${i.answer ?? '(no answer)'}`)
      .join('\n\n');
    return `Incident record:\nid: ${incident.id}\ntitle: ${incident.title}\nseverity: ${incident.severity}\nservice: ${incident.service}\nstarted_at: ${new Date(incident.started_at * 1000).toISOString()}\nresolved_at: ${incident.resolved_at ? new Date(incident.resolved_at * 1000).toISOString() : '—'}\nest. cost: $${Math.round(incident.cost_estimate_usd)}\nsummary: ${incident.summary}\nroot_cause: ${incident.root_cause}\nresolution: ${incident.resolution}\n\nTimeline:\n${formatTimeline(timeline)}\n\nInterviews:\n${iv || '(none)'}`;
  },
};

// ── P8: ask incidents (assistant Q&A) ────────────────────────────────────────

export const askIncidents = {
  temperature: 0.2,
  system: `You answer questions about this team's incident history using ONLY the retrieved context provided. Cite incident IDs inline (e.g. "INC-042"). If the context does not contain the answer, say "I don't have record of that." — do not guess. Keep answers short and Slack-friendly (mrkdwn).`,
  buildUser(question: string, retrievedContext: string): string {
    return `Question: ${question}\n\nRetrieved context:\n${retrievedContext || '(empty)'}`;
  },
};

// ── P9: route a customer/tenant report to the right internal team ─────────────

export const routeTenantReport = {
  temperature: 0.2,
  schema: z.object({
    route: z.string(),
    category: z.string(),
    severity_suggestion: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
    summary: z.string(),
  }),
  system: `You route a customer's problem report to the correct internal team for a SaaS vendor.

You are given the customer's message, the customer's account name/tier, and a numbered list of routing rules — each with a KEY and a plain-language description of what it covers. Choose the single best-matching rule KEY. If nothing clearly matches, return "default".

Also return: category (a short lowercase label like "payments", "auth", "performance"), severity_suggestion (SEV1 total outage / SEV2 major degradation / SEV3 partial / SEV4 minor — this is only a suggestion a human confirms; enterprise-tier accounts may warrant one level higher), and summary (one crisp sentence restating the problem for the internal team).

${JSON_ONLY} Shape: {"route":"r2","category":"payments","severity_suggestion":"SEV2","summary":"..."}`,
  buildUser(
    text: string,
    tenantName: string,
    tier: string | null,
    rules: { key: string; description: string }[],
    extraPrompt: string | null,
  ): string {
    const ruleLines = rules.map((r) => `- ${r.key}: ${r.description}`).join('\n') || '(no rules; use "default")';
    return `Customer: ${tenantName}${tier ? ` (tier: ${tier})` : ''}\n${extraPrompt ? `Special guidance: ${extraPrompt}\n` : ''}\nRouting rules:\n${ruleLines}\n- default: anything not matching a rule above\n\nCustomer report:\n${text}`;
  },
};

// ── P10: generate customer-safe guided intake questions ─────────────────────

export const generateIntakeQuestions = {
  temperature: 0.3,
  schema: z.object({
    questions: z.array(z.string()).min(2).max(3),
  }),
  system: `You write a short customer-facing intake script for a possible SaaS incident reported in Slack Connect.

Generate 2-3 concise questions that will help internal responders understand impact, scope, timing, and the affected workflow. Tailor the questions to the initial report, the tenant tier/guidance, and the routing rules. Questions must be safe to ask in a customer channel: do not mention internal channel names, internal teams, war rooms, roster members, costs, or incident IDs. Do not ask the customer to use buttons, forms, slash commands, or anything outside the current thread.

${JSON_ONLY} Shape: {"questions":["...","..."]}`,
  buildUser(
    initialText: string,
    tenantName: string,
    tier: string | null,
    rules: { key: string; description: string }[],
    extraPrompt: string | null,
  ): string {
    const ruleLines = rules.map((r) => `- ${r.key}: ${r.description}`).join('\n') || '(no routing rules)';
    return `Customer: ${tenantName}${tier ? ` (tier: ${tier})` : ''}\n${extraPrompt ? `Special guidance: ${extraPrompt}\n` : ''}\nRouting rules:\n${ruleLines}\n\nInitial customer report:\n${initialText}`;
  },
};

// ── P11: route + staff a completed customer intake ──────────────────────────

export const routeAndStaffTenantReport = {
  temperature: 0.2,
  schema: z.object({
    route: z.string(),
    category: z.string(),
    severity_suggestion: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
    summary: z.string(),
    roster_keys: z.array(z.string()).default([]),
  }),
  system: `You route a completed customer incident intake and choose the most relevant internal responders from a tenant-specific roster.

You are given routing rules and roster entries with opaque KEYS. Choose exactly one route key, or "default" when no routing rule clearly applies. Choose zero or more roster keys whose role and match description make them useful for this incident. Only return roster keys from the provided roster list; never invent keys. Prefer a small focused group over everyone. Also return a concise internal summary, category, and severity suggestion.

${JSON_ONLY} Shape: {"route":"r1","category":"payments","severity_suggestion":"SEV2","summary":"...","roster_keys":["u1"]}`,
  buildUser(
    transcript: string,
    tenantName: string,
    tier: string | null,
    rules: { key: string; description: string }[],
    roster: { key: string; role: string; matchText: string }[],
    extraPrompt: string | null,
  ): string {
    const ruleLines = rules.map((r) => `- ${r.key}: ${r.description}`).join('\n') || '(no rules; use "default")';
    const rosterLines =
      roster.map((r) => `- ${r.key}: role=${r.role}; match=${r.matchText || '*'}`).join('\n') || '(no roster entries)';
    return `Customer: ${tenantName}${tier ? ` (tier: ${tier})` : ''}\n${extraPrompt ? `Special guidance: ${extraPrompt}\n` : ''}\nRouting rules:\n${ruleLines}\n- default: anything not matching a rule above\n\nTenant roster:\n${rosterLines}\n\nCompleted intake transcript:\n${transcript}`;
  },
};
