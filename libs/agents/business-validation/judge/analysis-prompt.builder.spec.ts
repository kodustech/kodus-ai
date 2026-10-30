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

    it('shows the parent and the sub-tasks as context, with how to use them', () => {
        const prompt = buildBusinessRulesAnalysisPrompt({
            ...input,
            task: {
                ...input.task,
                parent: {
                    id: '#3',
                    title: 'Ticket list',
                    description: 'Agents filter and sort tickets.',
                },
                subtasks: [{ id: '#8', title: 'Sort by date', status: 'Todo' }],
            },
        });
        expect(prompt).toContain(
            'PARENT_TASK (context: the larger task this one is part of):\n#3 — Ticket list\nAgents filter and sort tickets.',
        );
        expect(prompt).toContain('- #8: Sort by date (Todo)');
        expect(prompt).toContain('Its requirements are not this task');
        expect(prompt).toContain('"Delivered by <id>:"');
        expect(prompt.indexOf('PARENT_TASK')).toBeLessThan(
            prompt.indexOf('PR_DIFF:'),
        );
    });

    it('says nothing of a parent or sub-tasks the task has none of', () => {
        const prompt = buildBusinessRulesAnalysisPrompt(input);
        expect(prompt).not.toContain('PARENT_TASK');
        expect(prompt).not.toContain('SUB_TASKS');
    });
});
