import { buildUserPrompt } from './conversation-prompt';
import { RUNTIME_NOTE_PREFIX, WriteTruthPolicy } from './write-truth.policy';

describe('conversation prompt — repository guidance', () => {
    const base = {
        prompt: 'Fixed in 3f3df1e8',
        userLanguage: 'en-US',
        organizationAndTeamData: { organizationId: 'o', teamId: 't' } as any,
        availableTools: ['grep', 'readFile', 'listDir', 'exec'],
    };

    // One commit printed whole was 424 MB (Nov 2026).
    it('tells the agent to read a commit by its stat and the thread file', () => {
        const prompt = buildUserPrompt({ ...base, hasSandbox: true });
        expect(prompt).toContain('git show --stat <sha>');
        expect(prompt).toContain('git show <sha> -- <file>');
    });

    it('says nothing about commits without a checkout', () => {
        expect(buildUserPrompt({ ...base, hasSandbox: false })).not.toContain('git show');
    });
});

// Models answered the per-step note as if the developer had written it.
describe('WriteTruthPolicy — the note says whose it is', () => {
    it('marks the note as runtime status, not a developer message', () => {
        const out = new WriteTruthPolicy(() => false).prepareStep({ steps: [] } as any);
        expect(out.injectNote?.content.startsWith(RUNTIME_NOTE_PREFIX)).toBe(true);
    });
});
