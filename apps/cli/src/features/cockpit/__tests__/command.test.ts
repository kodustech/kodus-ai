import { describe, expect, it } from 'vitest';
import { createUsageCommand } from '../../usage/command.js';
import { createCockpitCommand } from '../command.js';

describe('createCockpitCommand', () => {
    it('registers one subcommand per web cockpit tab with the shared filters', () => {
        const cockpit = createCockpitCommand();

        expect(cockpit.commands.map((command) => command.name())).toEqual([
            'kodus-review',
            'intent',
            'productivity',
            'code-areas',
        ]);
        for (const tab of cockpit.commands) {
            expect(tab.options.map((option) => option.long)).toEqual([
                '--from',
                '--to',
                '--repo',
                '--team',
                '--json',
            ]);
        }
    });
});

describe('createUsageCommand', () => {
    it('registers usage tokens with the Token Usage page filters', () => {
        const usage = createUsageCommand();
        const tokens = usage.commands.find(
            (command) => command.name() === 'tokens',
        );

        expect(tokens?.options.map((option) => option.long)).toEqual([
            '--by',
            '--from',
            '--to',
            '--repo',
            '--developer',
            '--pr',
            '--team',
            '--json',
        ]);
    });
});
