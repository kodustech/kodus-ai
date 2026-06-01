import { describe, expect, it } from 'vitest';
import { createCommandContext } from '../command-context.js';

describe('command context', () => {
    it('defaults to terminal output for human mode when format is missing', () => {
        const context = createCommandContext('schema', {
            agent: false,
            quiet: false,
            verbose: false,
        });

        expect(context.mode).toBe('human');
        expect(context.isAgent).toBe(false);
        expect(context.outputFormat).toBe('terminal');
    });

    it('forces json output in agent mode', () => {
        const context = createCommandContext('review', {
            agent: true,
            quiet: false,
            verbose: false,
            format: 'markdown',
        });

        expect(context.mode).toBe('agent');
        expect(context.outputFormat).toBe('json');
    });
});
