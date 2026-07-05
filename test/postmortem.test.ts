import { describe, expect, it } from 'vitest';
import { getIncident, interviewsFor, messageAuthors, openDb } from '../src/db/index.js';
import { IncidentCore } from '../src/engine/incident.js';
import { PostmortemEngine } from '../src/engine/postmortem.js';
import { FakeSlack } from './helpers/fakes.js';

async function resolvedIncident() {
  const db = openDb();
  const slack = new FakeSlack();
  const core = new IncidentCore(db, slack, { costRateDefaultPerMin: 180, appName: 'Sentinel' });
  const inc = await core.declare({ title: 'Redis pool exhaustion', service: 'checkout' });
  core.recordMessage(inc.id, { userId: 'U1', text: 'seeing 500s on /cart' });
  core.recordMessage(inc.id, { userId: 'U2', text: 'restarting the redis pool now' });
  core.recordMessage(inc.id, { userId: 'U1', text: 'latency recovering' });
  await core.resolve(inc.id, 'U1');
  return { db, slack, core, inc };
}

describe('PostmortemEngine', () => {
  it('extracts distinct human participants from war-room messages', async () => {
    const { db, inc } = await resolvedIncident();
    expect(messageAuthors(db, inc.id).sort()).toEqual(['U1', 'U2']);
  });

  it('kickoff DMs each participant their first question and queues the rest', async () => {
    const { db, slack, inc } = await resolvedIncident();
    const pm = new PostmortemEngine(db, slack, null, { delaySeconds: 0, timeoutSeconds: 300 });
    await pm.kickoff(inc.id);

    const dmUsers = slack.dms.map((d) => d.userId).sort();
    expect(dmUsers).toEqual(['U1', 'U2']);
    expect(slack.dms[0].text).toContain('Q1');

    const ivs = interviewsFor(db, inc.id);
    expect(ivs.filter((i) => i.user_id === 'U1')).toHaveLength(3);
    expect(ivs.filter((i) => i.user_id === 'U1' && i.asked_at !== null)).toHaveLength(1);
  });

  it('routes DM replies to the open interview, asks the next question, and finalizes when done', async () => {
    const { db, slack, inc } = await resolvedIncident();
    const pm = new PostmortemEngine(db, slack, null, { delaySeconds: 0, timeoutSeconds: 300 });
    await pm.kickoff(inc.id);

    // Answer all 3 questions per participant.
    for (const user of ['U1', 'U2']) {
      for (let i = 0; i < 3; i++) {
        expect(await pm.handleDmReply(user, `answer ${i} from ${user}`)).toBe(true);
      }
    }

    const done = getIncident(db, inc.id)!;
    expect(done.status).toBe('postmortem_done');
    expect(done.postmortem_doc).toContain('# Postmortem');
    expect(done.postmortem_doc).toContain('Lessons');
    expect(slack.uploads.some((u) => u.filename === `postmortem-${inc.id}.md`)).toBe(true);
  });

  it('finalize on timeout works with unanswered interviews and is idempotent', async () => {
    const { db, slack, inc } = await resolvedIncident();
    const pm = new PostmortemEngine(db, slack, null, { delaySeconds: 0, timeoutSeconds: 300 });
    await pm.kickoff(inc.id);
    const doc = await pm.finalize(inc.id);
    expect(doc).toContain('# Postmortem');
    expect(getIncident(db, inc.id)!.status).toBe('postmortem_done');
    expect(await pm.finalize(inc.id)).toBeNull(); // second run is a no-op
  });

  it('ignores DMs from users with no open interview', async () => {
    const { db, slack } = await resolvedIncident();
    const pm = new PostmortemEngine(db, slack, null, { delaySeconds: 0, timeoutSeconds: 300 });
    expect(await pm.handleDmReply('URANDO', 'hello?')).toBe(false);
  });
});
