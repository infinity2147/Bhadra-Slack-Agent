import type { PostedMessage, SlackPort } from '../ports.js';
import { logger } from '../util/logger.js';
import { RateGate } from './app.js';

type ApiMethod = (args?: Record<string, unknown>) => Promise<Record<string, any>>;

/** Structural slice of Bolt's WebClient — keeps the port testable and version-tolerant. */
export interface SlackWebApi {
  apiCall(method: string, options?: Record<string, unknown>): Promise<Record<string, any>>;
  conversations: {
    create: ApiMethod;
    invite: ApiMethod;
    open: ApiMethod;
    list: ApiMethod;
    join: ApiMethod;
    setTopic: ApiMethod;
  };
  chat: { postMessage: ApiMethod; update: ApiMethod };
  pins: { add: ApiMethod };
  bookmarks: { add: ApiMethod };
  files: { uploadV2: ApiMethod };
}

export class WebSlackPort implements SlackPort {
  private updateGate = new RateGate(1000);
  private dmChannelCache = new Map<string, string>();
  private nameCache = new Map<string, string>();

  constructor(private web: SlackWebApi) {}

  async createChannel(name: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`;
      try {
        const res = await this.web.conversations.create({ name: candidate });
        return (res.channel as { id: string }).id;
      } catch (err) {
        const code = (err as { data?: { error?: string } }).data?.error;
        if (code !== 'name_taken') throw err;
      }
    }
    throw new Error(`could not create channel ${name}: name taken repeatedly`);
  }

  async inviteUsers(channelId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.web.conversations.invite({ channel: channelId, users: userIds.join(',') });
    } catch (err) {
      const code = (err as { data?: { error?: string } }).data?.error;
      if (code !== 'already_in_channel' && code !== 'cant_invite_self') throw err;
    }
  }

  async postMessage(opts: {
    channel: string;
    text: string;
    blocks?: unknown[];
    thread_ts?: string;
  }): Promise<PostedMessage> {
    const res = await this.web.chat.postMessage({
      channel: opts.channel,
      text: opts.text,
      blocks: opts.blocks,
      thread_ts: opts.thread_ts,
      unfurl_links: false,
    });
    return { channel: (res.channel as string) ?? opts.channel, ts: res.ts as string };
  }

  async updateMessage(opts: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void> {
    await this.updateGate.wait(opts.channel); // ≥1 update/sec/channel
    await this.web.chat.update({ channel: opts.channel, ts: opts.ts, text: opts.text, blocks: opts.blocks });
  }

  async pin(channel: string, ts: string): Promise<void> {
    await this.web.pins.add({ channel, timestamp: ts });
  }

  async addBookmark(channelId: string, title: string, link: string, emoji?: string): Promise<void> {
    await this.web.bookmarks.add({ channel_id: channelId, title, type: 'link', link, emoji });
  }

  async dm(userId: string, text: string, blocks?: unknown[]): Promise<PostedMessage> {
    let channel = this.dmChannelCache.get(userId);
    if (!channel) {
      const res = await this.web.conversations.open({ users: userId });
      channel = (res.channel as { id: string }).id;
      this.dmChannelCache.set(userId, channel);
    }
    return this.postMessage({ channel, text, blocks });
  }

  async uploadFile(opts: { channel: string; filename: string; content: string; title?: string }): Promise<void> {
    await this.web.files.uploadV2({
      channel_id: opts.channel,
      filename: opts.filename,
      content: opts.content,
      title: opts.title ?? opts.filename,
      snippet_type: 'markdown',
    });
  }

  async setTopic(channelId: string, topic: string): Promise<void> {
    await this.web.conversations.setTopic({ channel: channelId, topic });
  }

  async channelIdByName(name: string): Promise<string | undefined> {
    const clean = name.replace(/^#/, '');
    if (/^C[A-Z0-9]{6,}$/i.test(clean)) return clean; // already an ID
    if (this.nameCache.has(clean)) return this.nameCache.get(clean);
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.web.conversations.list({
        types: 'public_channel',
        limit: 1000,
        exclude_archived: true,
        cursor,
      });
      for (const ch of (res.channels ?? []) as { id: string; name: string }[]) {
        this.nameCache.set(ch.name, ch.id);
      }
      cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      if (!cursor) break;
    }
    return this.nameCache.get(clean);
  }

  async joinChannel(channelId: string): Promise<void> {
    try {
      await this.web.conversations.join({ channel: channelId });
    } catch (err) {
      logger.warn({ err, channelId }, 'join failed (private channel? invite the bot manually)');
    }
  }
}
