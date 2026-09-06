import { describe, expect, it } from 'vitest';
import { createReviewCommand } from '../command.js';

describe('createReviewCommand', () => {
    it('creates the review command with the expected interactive options', () => {
        const command = createReviewCommand();

        expect(command.name()).toBe('review');

        const optionFlags = command.options.map((option) => option.flags);
        expect(optionFlags).toEqual(
            expect.arrayContaining([
                '-s, --staged',
                '-c, --commit <sha>',
                '-b, --branch <name>',
                '-i, --interactive',
                '--fix',
                '--prompt-only',
                '--fail-on <severity>',
                '--context <file>',
                '--review-context-file <path>',
                '--fields <csv>',
            ]),
        );
    });

    it('parses the review context file path', () => {
        const command = createReviewCommand();

        command.parseOptions([
            '--review-context-file',
            '/tmp/review-context.txt',
        ]);

        expect(command.opts().reviewContextFile).toBe(
            '/tmp/review-context.txt',
        );
    });

    it('includes concrete examples in the help output', () => {
        const command = createReviewCommand();
        const help = command.helpInformation();

        expect(help).toContain('Examples:');
        expect(help).toContain('kodus review');
        expect(help).toContain('kodus review --staged');
        expect(help).toContain('kodus review --fail-on error');
    });
});
