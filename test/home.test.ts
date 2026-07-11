import { describe, expect, it } from 'vitest';
import { homeBlocks } from '../src/slack/blocks/home.js';

describe('homeBlocks', () => {
  it('shows the judge-friendly demo path on App Home', () => {
    const blocks = homeBlocks({ active: [], recent: [], appName: 'Sentinel IC' });
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain('Demo path');
    expect(rendered).toContain('Run drill');
    expect(rendered).toContain('recall the last fix');
  });
});
