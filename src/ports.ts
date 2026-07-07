/**
 * Ports are the seams between engines and the outside world (Slack, MCP, LLM).
 * Engines depend on these interfaces; production wiring lives in src/slack and
 * src/mcp, tests inject fakes.
 */

export interface PostedMessage {
  channel: string;
  ts: string;
}

export interface SlackPort {
  /** Create a public channel, returns channel id. Must tolerate name collisions. */
  createChannel(name: string): Promise<string>;
  inviteUsers(channelId: string, userIds: string[]): Promise<void>;
  postMessage(opts: {
    channel: string;
    text: string;
    blocks?: unknown[];
    thread_ts?: string;
  }): Promise<PostedMessage>;
  updateMessage(opts: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  pin(channel: string, ts: string): Promise<void>;
  addBookmark(channelId: string, title: string, link: string, emoji?: string): Promise<void>;
  /** Open (or reuse) a DM with the user and post. Returns the DM channel + ts. */
  dm(userId: string, text: string, blocks?: unknown[]): Promise<PostedMessage>;
  uploadFile(opts: { channel: string; filename: string; content: string; title?: string }): Promise<void>;
  setTopic(channelId: string, topic: string): Promise<void>;
  /** Resolve a channel name to an id (undefined when not found / not accessible). */
  channelIdByName(name: string): Promise<string | undefined>;
  joinChannel(channelId: string): Promise<void>;

  // ── Slack AI / Assistant surface (optional; no-op on ports that don't model it) ──
  /** Show the "Agent is …" status pill in an assistant thread (empty string clears it). */
  setAssistantStatus?(channel: string, threadTs: string | undefined, status: string): Promise<void>;
  /** Seed the assistant thread with clickable starter prompts. */
  setSuggestedPrompts?(
    channel: string,
    threadTs: string | undefined,
    prompts: { title: string; message: string }[],
    greeting?: string,
  ): Promise<void>;
  /** Set the assistant thread's title (shown in the thread list). */
  setAssistantTitle?(channel: string, threadTs: string | undefined, title: string): Promise<void>;
}

export type McpServerName = 'deploys' | 'observability' | 'oncall';

export interface McpPort {
  callTool(server: McpServerName, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface DeployRecord {
  id: string;
  service: string;
  title: string;
  author: string;
  deployed_at: number; // epoch seconds
  url?: string;
}
