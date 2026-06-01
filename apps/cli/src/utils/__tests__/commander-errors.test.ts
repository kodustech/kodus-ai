import { describe, expect, it } from 'vitest';
import { formatCommanderError } from '../commander-errors.js';

describe('commander errors', () => {
    it('explains the config shortcut misuse with a concrete fix', () => {
        const message = formatCommanderError(
            {
                code: 'commander.excessArguments',
                exitCode: 1,
                message:
                    "error: too many arguments for 'config'. Expected 0 arguments but got 1.",
            },
            ['config', '-r', 'Wellington01/kodus-extension', 'setup'],
        );

        expect(message).toContain(
            "The '-r, --remote' shortcut only adds a repository.",
        );
        expect(message).toContain(
            'Use `kodus config -r Wellington01/kodus-extension` to add it.',
        );
        expect(message).toContain(
            'Use `kodus config remote setup Wellington01/kodus-extension` to run onboarding.',
        );
    });

    it('formats generic excess-arguments errors more clearly', () => {
        const message = formatCommanderError(
            {
                code: 'commander.excessArguments',
                exitCode: 1,
                message:
                    "error: too many arguments for 'config'. Expected 0 arguments but got 1.",
            },
            ['config', 'extra'],
        );

        expect(message).toContain('Too many arguments.');
        expect(message).toContain('Run `kodus config --help`');
    });

    it('formats unknown-option errors with a friendlier hint', () => {
        const message = formatCommanderError(
            {
                code: 'commander.unknownOption',
                exitCode: 1,
                message: "error: unknown option '--remoet'",
            },
            ['config', '--remoet'],
        );

        expect(message).toContain('Unknown option: `--remoet`.');
        expect(message).toContain('Run `kodus config --help`');
    });

    it('formats unknown-command errors with the expected command family', () => {
        const message = formatCommanderError(
            {
                code: 'commander.unknownCommand',
                exitCode: 1,
                message: "error: unknown command 'remoet'",
            },
            ['config', 'remoet'],
        );

        expect(message).toContain('Unknown command: `remoet`.');
        expect(message).toContain('Run `kodus config --help`');
        expect(message).toContain(
            'For repository settings, use `kodus config remote <command>`.',
        );
    });

    it('formats missing-argument style errors more clearly', () => {
        const message = formatCommanderError(
            {
                code: 'commander.missingArgument',
                exitCode: 1,
                message: "error: missing required argument 'repository'",
            },
            ['config', 'remote', 'show'],
        );

        expect(message).toContain('Missing required argument: `repository`.');
        expect(message).toContain('Run `kodus config --help`');
    });
});
