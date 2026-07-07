import {
  getConfigValue,
  hasSignalForMessage,
  insertSignal,
  setConfigValue,
  unclusteredSignalsSince,
  type Database,
  type Signal,
  type SignalCategory,
} from '../db/index.js';
import type { LlmClient } from '../llm/client.js';
import { signalClassify, clusterSummarize } from '../llm/prompts.js';
import type { DeployRecord, McpPort, SlackPort } from '../ports.js';
import type { RtsClient } from '../rts/client.js';
import { logger } from '../util/logger.js';
import { minutesAgo, now } from '../util/time.js';
import { triageBlocks } from '../slack/blocks/triage.js';

const PREFILTER_PATTERNS: RegExp[] = [
  /is it just me/i,
  /anyone else/i,
  /\b5\d\ds?\b/,
  /\btimeouts?\b/i,
  /\btim(e|ed|ing)s? ?out\b/i,
  /\bdown\b/i,
  /\bslow\b/i,
  /\berror(s|ing)?\b/i,
  /\bfail(s|ed|ing)\b/i,
  /\bbroken?\b/i,
  /\blatency\b/i,
  /\bdegraded\b/i,
  /\boutage\b/i,
  /\bunreachable\b/i,
  /\bweird\b/i,
  /not (working|loading|responding)/i,
];

/** Cheap prefilter so we never pay LLM cost on obvious noise (spec §6.1 step 1). */
export function prefilter(text: string): boolean {
  return PREFILTER_PATTERNS.some((p) => p.test(text));
}

/** Sentinel's own cards must not re-trigger detection; 🎭 drill messages MUST flow through. */
export function looksLikeSentinelCard(text: string): boolean {
  return /^(⚠️|🚨|🧠|💸|📋|✅|🔁|👀)/.test(text.trim());
}

const CATEGORY_HEURISTICS: [RegExp, SignalCategory][] = [
  [/\b5\d\ds?\b|\berror/i, 'errors'],
  [/\bdown\b|\boutage\b|\bunreachable\b/i, 'outage'],
  [/\bslow\b|\blatency\b|\btime(d)? ?out/i, 'latency'],
  [/deploy|release|rollback|ship/i, 'deploy_suspicion'],
];

// Hints map surface nouns to owning services (cart lives in checkout, etc.).
const SERVICE_HINTS: [string, string][] = [
  ['checkout', 'checkout'],
  ['cart', 'checkout'],
  ['payments', 'payments'],
  ['payment', 'payments'],
  ['billing', 'payments'],
  ['auth', 'auth'],
  ['login', 'auth'],
  ['sso', 'auth'],
  ['search', 'search'],
  ['api', 'api'],
];

/** Heuristic classification used when the LLM is unavailable (graceful degradation). */
export function heuristicClassify(text: string): {
  is_signal: boolean;
  category: SignalCategory;
  service_guess: string | null;
  confidence: number;
} {
  let category: SignalCategory = 'confusion';
  for (const [re, cat] of CATEGORY_HEURISTICS) {
    if (re.test(text)) {
      category = cat;
      break;
    }
  }
  const lower = text.toLowerCase();
  const service = SERVICE_HINTS.find(([hint]) => lower.includes(hint))?.[1] ?? null;
  // 0.8, not 0.6: to even reach here a message already cleared the prefilter and
  // matched a trouble-category pattern — that's high-precision. Crucially, this
  // must sit at/above the default threshold (0.72) so that when the LLM is down,
  // two heuristic signals from two humans still clear the clustering weight bar
  // (threshold × 2). At 0.6 the offline path — and the flagship drill demo when
  // ANTHROPIC_API_KEY is absent — could never declare. See clusterTick().
  return { is_signal: true, category, service_guess: service, confidence: 0.8 };
}

export interface PreIncident {
  key: string;
  title: string;
  service: string;
  severity_suggestion: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
  one_line: string;
  signals: Signal[];
  signalIds: number[];
  deploy?: DeployRecord;
  sourceChannelId: string;
  similarLine?: string;
}

export interface SignalEngineOpts {
  windowMinutes: number;
  threshold: number;
  watchChannelIds: string[];
  pollQuery?: string;
}

export interface IncomingMessage {
  channelId: string;
  ts: string;
  userId: string;
  text: string;
}

export class SignalEngine {
  private db: Database;
  private llm: LlmClient | null;
  private slack: SlackPort;
  private mcp?: McpPort;
  private rts?: RtsClient;
  private opts: SignalEngineOpts;
  /** Optional enrichment: one-line "similar past incidents" summary for the triage card. */
  similarLineProvider?: (pre: Omit<PreIncident, 'similarLine' | 'key'>) => Promise<string | undefined>;

  constructor(args: {
    db: Database;
    llm: LlmClient | null;
    slack: SlackPort;
    mcp?: McpPort;
    rts?: RtsClient;
    opts: SignalEngineOpts;
  }) {
    this.db = args.db;
    this.llm = args.llm;
    this.slack = args.slack;
    this.mcp = args.mcp;
    this.rts = args.rts;
    this.opts = args.opts;
  }

  set mcpPort(port: McpPort) {
    this.mcp = port;
  }

  /** Live message path (Events API). */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!msg.text || looksLikeSentinelCard(msg.text)) return;
    if (!prefilter(msg.text)) return;
    if (hasSignalForMessage(this.db, msg.channelId, msg.ts)) return;
    await this.classifyAndStore([msg]);
  }

  /** RTS redundancy net (spec §6.1): poll for trouble phrases we may have missed. */
  async pollTick(): Promise<void> {
    if (!this.rts) return;
    const query = this.opts.pollQuery ?? '"is it just me" OR "anyone else" OR "500" OR "timeout" OR "down" OR "slow"';
    try {
      const results = await this.rts.searchMessages({
        query,
        channels: this.opts.watchChannelIds,
        after: minutesAgo(this.opts.windowMinutes),
      });
      const fresh = results
        .filter((r) => r.userId && !looksLikeSentinelCard(r.text))
        .filter((r) => prefilter(r.text))
        .filter((r) => !hasSignalForMessage(this.db, r.channelId, r.ts))
        .map((r) => ({ channelId: r.channelId, ts: r.ts, userId: r.userId, text: r.text }));
      if (fresh.length > 0) await this.classifyAndStore(fresh);
    } catch (err) {
      logger.warn({ err }, 'signal pollTick failed');
    }
  }

  private async classifyAndStore(msgs: IncomingMessage[]): Promise<void> {
    let results: { index: number; is_signal: boolean; category: SignalCategory | null; service_guess: string | null; confidence: number }[];
    if (this.llm) {
      try {
        const out = await this.llm.completeJson(
          {
            system: signalClassify.system,
            user: signalClassify.buildUser(msgs.map((m) => ({ text: m.text, channel: m.channelId }))),
            temperature: signalClassify.temperature,
          },
          signalClassify.schema,
        );
        results = out.results;
      } catch (err) {
        logger.warn({ err }, 'LLM classify failed; using heuristics');
        results = msgs.map((m, index) => ({ index, ...heuristicClassify(m.text) }));
      }
    } else {
      results = msgs.map((m, index) => ({ index, ...heuristicClassify(m.text) }));
    }

    for (const r of results) {
      const msg = msgs[r.index];
      if (!msg || !r.is_signal || r.confidence < 0.5 || !r.category) continue;
      insertSignal(this.db, {
        channel_id: msg.channelId,
        message_ts: msg.ts,
        user_id: msg.userId,
        text: msg.text,
        score: r.confidence,
        category: r.category,
        created_at: now(),
        service_guess: r.service_guess,
      });
    }
  }

  /**
   * Clustering tick (spec §6.1 step 4): group unassigned signals in the window
   * by service/category; fire a pre-incident when the cluster is heavy enough
   * and involves ≥2 distinct users. Posts the ⚠️ triage card.
   */
  async clusterTick(): Promise<PreIncident | null> {
    const signals = unclusteredSignalsSince(this.db, minutesAgo(this.opts.windowMinutes));
    if (signals.length === 0) return null;

    // Group by service (falling back to category). When the window contains
    // exactly one distinct service, service-less signals almost certainly
    // belong to the same brewing issue — fold them in.
    const services = new Set(signals.map((s) => s.service_guess?.toLowerCase()).filter(Boolean));
    const soleService = services.size === 1 ? [...services][0]! : null;
    const groups = new Map<string, Signal[]>();
    for (const s of signals) {
      const key = (s.service_guess ?? soleService ?? s.category ?? 'unknown').toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }

    for (const [groupKey, group] of groups) {
      if (this.isSuppressed(groupKey)) continue;
      const weight = group.reduce((sum, s) => sum + (s.score ?? 0), 0);
      const distinctUsers = new Set(group.map((s) => s.user_id)).size;
      // threshold is a 0..1 confidence knob; a cluster needs ~2 confident signals.
      if (distinctUsers < 2 || weight < this.opts.threshold * 2) continue;

      const deploy = await this.correlateDeploy(groupKey);
      const pre = await this.buildPreIncident(groupKey, group, deploy);
      if (this.similarLineProvider) {
        try {
          pre.similarLine = await this.similarLineProvider(pre);
        } catch (err) {
          logger.warn({ err }, 'similar-line provider failed');
        }
      }
      await this.postTriageCard(pre);
      // Cool down this group so we don't re-fire every tick while humans decide.
      this.suppress(groupKey, 30);
      return pre;
    }
    return null;
  }

  private async correlateDeploy(service: string): Promise<DeployRecord | undefined> {
    if (!this.mcp) return undefined;
    try {
      const res = (await this.mcp.callTool('deploys', 'list_recent_deploys', { minutes: 30 })) as {
        deploys?: DeployRecord[];
      };
      const deploys = res?.deploys ?? [];
      return deploys.find((d) => d.service.toLowerCase().includes(service) || service.includes(d.service.toLowerCase())) ?? deploys[0];
    } catch (err) {
      logger.warn({ err }, 'deploy correlation failed');
      return undefined;
    }
  }

  private async buildPreIncident(
    groupKey: string,
    group: Signal[],
    deploy: DeployRecord | undefined,
  ): Promise<PreIncident> {
    let title = `Possible ${groupKey} incident`;
    let service = group.find((s) => s.service_guess)?.service_guess ?? groupKey;
    let severity: PreIncident['severity_suggestion'] = 'SEV3';
    let oneLine = `${new Set(group.map((s) => s.user_id)).size} people reported ${groupKey} trouble in the last ${this.opts.windowMinutes} min.`;
    if (this.llm) {
      try {
        const out = await this.llm.completeJson(
          {
            system: clusterSummarize.system,
            user: clusterSummarize.buildUser(group, deploy ? [deploy] : []),
            temperature: clusterSummarize.temperature,
          },
          clusterSummarize.schema,
        );
        title = out.title;
        service = out.service;
        severity = out.severity_suggestion;
        oneLine = out.one_line;
      } catch (err) {
        logger.warn({ err }, 'cluster summarize failed; using heuristic copy');
      }
    }
    // Boost/attach handled by presence of `deploy` on the card (spec §6.1 step 5).
    const signalIds = group.map((s) => s.id);
    const pre: PreIncident = {
      key: `pre-${signalIds[0]}`,
      title,
      service,
      severity_suggestion: severity,
      one_line: oneLine,
      signals: group,
      signalIds,
      deploy,
      sourceChannelId: group[group.length - 1].channel_id ?? '',
    };
    setConfigValue(
      this.db,
      `preincident:${pre.key}`,
      JSON.stringify({ title, service, severity, signalIds, sourceChannelId: pre.sourceChannelId }),
    );
    return pre;
  }

  private async postTriageCard(pre: PreIncident): Promise<void> {
    if (!pre.sourceChannelId) return;
    // Threaded to the most recent signal message, NOT a new channel yet (spec §6.1).
    const threadTs = pre.signals[pre.signals.length - 1].message_ts ?? undefined;
    await this.slack.postMessage({
      channel: pre.sourceChannelId,
      thread_ts: threadTs,
      text: `⚠️ Possible incident brewing — ${pre.one_line}`,
      blocks: triageBlocks(pre),
    });
  }

  // ── suppression: "Not an incident" feedback loop (spec §6.1) ───────────────

  isSuppressed(key: string): boolean {
    const until = getConfigValue(this.db, `suppress:${key.toLowerCase()}`);
    return !!until && parseInt(until, 10) > now();
  }

  suppress(key: string, minutes: number): void {
    setConfigValue(this.db, `suppress:${key.toLowerCase()}`, String(now() + minutes * 60));
  }
}
