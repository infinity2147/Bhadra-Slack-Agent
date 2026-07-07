import type { Config } from './config.js';
import type { Database } from './db/index.js';
import type { CommsEngine } from './engine/comms.js';
import type { CostMeter } from './engine/costMeter.js';
import type { DrillEngine } from './engine/drill.js';
import type { IncidentCore } from './engine/incident.js';
import type { MemoryEngine } from './engine/memory.js';
import type { PostmortemEngine } from './engine/postmortem.js';
import type { ReporterEngine } from './engine/reporter.js';
import type { SignalEngine } from './engine/signals.js';
import type { LlmClient } from './llm/client.js';
import type { McpHub } from './mcp/hub.js';
import type { SlackPort } from './ports.js';
import type { RtsClient } from './rts/client.js';
import type { EventDeduper } from './slack/app.js';

/** Everything the Slack surface needs, in one bag. */
export interface AppContext {
  config: Config;
  db: Database;
  slack: SlackPort;
  llm: LlmClient | null;
  mcp?: McpHub;
  rts?: RtsClient;
  core: IncidentCore;
  signals: SignalEngine;
  memory: MemoryEngine;
  comms: CommsEngine;
  costMeter: CostMeter;
  postmortem: PostmortemEngine;
  reporter: ReporterEngine;
  drill: DrillEngine;
  deduper: EventDeduper;
  /** Resolved channel IDs Sentinel watches for signals. */
  watchChannelIds: Set<string>;
  botUserId?: string;
}
