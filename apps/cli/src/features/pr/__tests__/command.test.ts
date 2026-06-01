import { describe, expect, it } from 'vitest';
import { createPrCommand } from '../command.js';

describe('createPrCommand', () => {
    it('registers the expected pull request subcommands', () => {
        const command = createPrCommand();

        expect(command.name()).toBe('pr');
        expect(command.commands.map((subcommand) => subcommand.name())).toEqual(
            expect.arrayContaining(['suggestions', 'business-validation']),
        );
    });
});
