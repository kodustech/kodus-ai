import { buildBusinessRulesAnalysisPrompt } from './analysis-prompt.builder';

const input = {
    task: { tracker: 'Git Issues', id: '#7', title: 'Empty state' },
    taskText: 'The empty state says "No tickets".',
    taskQuality: 'COMPLETE' as const,
    diff: '+<p>Nothing here.</p>',
};

describe('buildBusinessRulesAnalysisPrompt', () => {
    it("puts the team's guidance next to the task, with what to do with it", () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            ...input,
            teamGuidance: 'Ignore criteria about copy; QA covers those.',
        });
        expect(prompt).toContain(
            'TEAM_GUIDANCE (from the team that owns this repository, set in Kodus; follow it):\nIgnore criteria about copy; QA covers those.',
        );
        expect(prompt).toContain('set `state` to check_manually');
        expect(prompt.indexOf('TEAM_GUIDANCE')).toBeLessThan(
            prompt.indexOf('INSTRUCTIONS:'),
        );
    });

    it('says nothing about guidance when the team gave none', () => {
        expect(buildBusinessRulesAnalysisPrompt(input)).not.toContain(
            'TEAM_GUIDANCE',
        );
    });
});
