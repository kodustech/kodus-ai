import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/review.service.js', () => ({
    reviewService: { triggerBusinessValidation: vi.fn() },
}));

vi.mock('../../../services/git.service.js', () => ({
    gitService: {
        setVerbose: vi.fn(),
        getWorkingTreeDiff: vi.fn(),
        extractOrgRepo: vi.fn(),
    },
}));

import { reviewService } from '../../../services/review.service.js';
import { gitService } from '../../../services/git.service.js';
import { CliExitError } from '../../../utils/cli-exit.js';
import { createPrCommand } from '../command.js';

const verdict = {
    status: 'issues_found',
    passed: false,
    tasks: [
        {
            tracker: 'Azure DevOps',
            id: 'AB#8',
            requirements: [
                {
                    requirement: 'Defaults to comfortable',
                    source: 'AC #2',
                    state: 'missing',
                    evidence: [{ file: 'src/settings/density.ts', line: 6 }],
                    action: 'Change the default to "comfortable".',
                    confidence: 'high',
                },
            ],
            outOfScope: [],
        },
    ],
};

const response = {
    accepted: true,
    mode: 'local_diff' as const,
    command: '@kody -v business-logic AB#8',
    repositoryName: 'acme/notes',
    taskReference: 'AB#8',
    result: 'AB#8 · Compact density toggle\n  MISSING        AC #2 Defaults to comfortable\n\nstatus: issues_found (--format json for the full verdict)',
    verdict,
};

// The global options `kodus` declares (src/cli.ts).
function program(): Command {
    return new Command()
        .exitOverride()
        .option('-f, --format <format>', 'Output format', 'terminal')
        .option('-o, --output <file>', 'Output file')
        .option('-q, --quiet', 'Quiet mode', false)
        .option('--agent', 'Agent mode')
        .addCommand(createPrCommand());
}

async function run(args: string[]): Promise<string> {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...parts) => {
        writes.push(`${parts.join(' ')}\n`);
    });
    await program().parseAsync([
        'node',
        'kodus',
        ...args,
        'pr',
        'business-validation',
        '--task-id',
        'AB#8',
    ]);
    return writes.join('');
}

describe('kodus pr business-validation', () => {
    beforeEach(() => {
        vi.mocked(gitService.getWorkingTreeDiff).mockResolvedValue(
            'diff --git a/x.ts b/x.ts\n+const x = 1;\n',
        );
        vi.mocked(gitService.extractOrgRepo).mockResolvedValue({
            org: 'acme',
            repo: 'notes',
        } as never);
        vi.mocked(reviewService.triggerBusinessValidation).mockResolvedValue(
            response as never,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prints the structured verdict with --format json', async () => {
        const output = await run(['--format', 'json']);

        expect(JSON.parse(output)).toEqual({
            command: response.command,
            repository: 'acme/notes',
            task: 'AB#8',
            ...verdict,
        });
    });

    it('reads --format json after the subcommand too, as the docs write it', async () => {
        const writes: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            writes.push(String(chunk));
            return true;
        });
        await program().parseAsync([
            'node',
            'kodus',
            'pr',
            'business-validation',
            '--task-id',
            'AB#8',
            '--format',
            'json',
        ]);

        expect(JSON.parse(writes.join(''))).toMatchObject({
            task: 'AB#8',
            status: 'issues_found',
        });
    });

    it('wraps the same verdict in the agent envelope with --agent', async () => {
        const output = JSON.parse(await run(['--agent']));

        expect(output).toMatchObject({
            ok: true,
            command: 'pr business-validation',
            data: { status: 'issues_found', passed: false, task: 'AB#8' },
            error: null,
        });
        expect(output.data.tasks[0].requirements[0]).toMatchObject({
            state: 'missing',
            action: 'Change the default to "comfortable".',
        });
    });

    it('falls back to the text verdict when the server sends no structured one', async () => {
        vi.mocked(reviewService.triggerBusinessValidation).mockResolvedValue({
            ...response,
            verdict: undefined,
        } as never);

        const output = JSON.parse(await run(['--format', 'json']));

        expect(output).toMatchObject({ task: 'AB#8', result: response.result });
    });

    it('reports a failure as an agent error envelope and exits non-zero', async () => {
        vi.mocked(reviewService.triggerBusinessValidation).mockRejectedValue(
            new Error('Task AB#8 was not found'),
        );
        const writes: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            writes.push(String(chunk));
            return true;
        });

        await expect(
            program().parseAsync([
                'node',
                'kodus',
                '--agent',
                'pr',
                'business-validation',
                '--task-id',
                'AB#8',
            ]),
        ).rejects.toBeInstanceOf(CliExitError);
        expect(JSON.parse(writes.join(''))).toMatchObject({
            ok: false,
            error: { message: 'Task AB#8 was not found' },
        });
    });

    it('keeps the terminal text by default', async () => {
        const output = await run([]);

        expect(output).toContain(
            'MISSING        AC #2 Defaults to comfortable',
        );
        expect(() => JSON.parse(output)).toThrow();
    });
});
