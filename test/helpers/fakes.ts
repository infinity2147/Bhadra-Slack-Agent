import type { McpPort, McpServerName, PostedMessage, SlackPort } from '../../src/ports.js';

export interface FakeCall {
  method: string;
  args: unknown;
}

export class FakeSlack implements SlackPort {
  calls: FakeCall[] = [];
  posted: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string; ts: string }[] = [];
  updated: { channel: string; ts: string; text: string; blocks?: unknown[] }[] = [];
  dms: { userId: string; text: string; blocks?: unknown[] }[] = [];
  uploads: { channel: string; filename: string; content: string }[] = [];
  channels: string[] = [];
  private tsCounter = 0;

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  async createChannel(name: string): Promise<string> {
    this.record('createChannel', name);
    this.channels.push(name);
    return `C_${name}`;
  }
  async inviteUsers(channelId: string, userIds: string[]): Promise<void> {
    this.record('inviteUsers', { channelId, userIds });
  }
  async postMessage(opts: { channel: string; text: string; blocks?: unknown[]; thread_ts?: string }): Promise<PostedMessage> {
    const ts = `${++this.tsCounter}.000`;
    this.record('postMessage', opts);
    this.posted.push({ ...opts, ts });
    return { channel: opts.channel, ts };
  }
  async updateMessage(opts: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void> {
    this.record('updateMessage', opts);
    this.updated.push(opts);
  }
  async pin(channel: string, ts: string): Promise<void> {
    this.record('pin', { channel, ts });
  }
  async addBookmark(channelId: string, title: string, link: string): Promise<void> {
    this.record('addBookmark', { channelId, title, link });
  }
  async dm(userId: string, text: string, blocks?: unknown[]): Promise<PostedMessage> {
    const ts = `${++this.tsCounter}.000`;
    this.record('dm', { userId, text });
    this.dms.push({ userId, text, blocks });
    return { channel: `D_${userId}`, ts };
  }
  async uploadFile(opts: { channel: string; filename: string; content: string; title?: string }): Promise<void> {
    this.record('uploadFile', opts);
    this.uploads.push(opts);
  }
  async setTopic(channelId: string, topic: string): Promise<void> {
    this.record('setTopic', { channelId, topic });
  }
  async channelIdByName(name: string): Promise<string | undefined> {
    return `C_${name}`;
  }
  async joinChannel(channelId: string): Promise<void> {
    this.record('joinChannel', channelId);
  }
}

export class FakeMcp implements McpPort {
  calls: { server: McpServerName; tool: string; args: Record<string, unknown> }[] = [];
  responses = new Map<string, unknown>();

  when(server: McpServerName, tool: string, response: unknown): void {
    this.responses.set(`${server}/${tool}`, response);
  }

  async callTool(server: McpServerName, tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ server, tool, args });
    const key = `${server}/${tool}`;
    if (this.responses.has(key)) return this.responses.get(key);
    return {};
  }
}
