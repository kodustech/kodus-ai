import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
    '../../../services/custom-agents.service.js',
    async (importOriginal) => {
        const actual =
            await importOriginal<
                typeof import('../../../services/custom-agents.service.js')
            >();
        return {
            ...actual,
            customAgentsService: {
                list: vi.fn(),
                show: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
                setEnabled: vi.fn(),
                delete: vi.fn(),
                tryAgent: vi.fn(),
            },
        };
    },
);

vi.mock('../../../utils/logger.js', () => ({
    cliInfo: vi.fn(),
    cliError: vi.fn(),
}));

import { customAgentsService } from '../../../services/custom-agents.service.js';
import { cliInfo } from '../../../utils/logger.js';
import { createAgentsCommand, readAgentFile } from '../command.js';

const service = vi.mocked(customAgentsService);

const parse = (args: string[]) =>
    createAgentsCommand().parseAsync(args, { from: 'user' });

describe('agents command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('registers every subcommand', () => {
        expect(createAgentsCommand().commands.map((c) => c.name())).toEqual([
            'list',
            'show',
            'create',
            'update',
            'enable',
            'disable',
            'delete',
            'try',
        ]);
    });

    it('creates with repeatable globs at a directory', async () => {
        service.create.mockResolvedValue({
            level: 'directory',
            agent: { name: 'Data contracts' } as never,
        });

        await parse([
            'create',
            '--name',
            'Data contracts',
            '--include',
            'migrations/**',
            '--include',
            'db/**',
            '--repo',
            'kodus-ai',
            '--directory',
            'apps/api',
            '--template',
            'security',
            '--json',
        ]);

        expect(service.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Data contracts',
                include: ['migrations/**', 'db/**'],
                template: 'security',
                enabled: undefined,
            }),
            { team: undefined, repo: 'kodus-ai', directory: 'apps/api' },
        );
        expect(cliInfo).toHaveBeenCalledWith(
            expect.stringContaining('"level": "directory"'),
        );
    });

    it('defaults to the global level', async () => {
        service.setEnabled.mockResolvedValue({ level: 'global' });

        await parse(['disable', 'security']);

        expect(service.setEnabled).toHaveBeenCalledWith('security', false, {
            team: undefined,
            repo: 'global',
            directory: undefined,
        });
    });

    it('passes the pull request to try', async () => {
        service.tryAgent.mockResolvedValue({
            agent: {} as never,
            trace: {
                status: 'completed',
                skillsOpened: [],
                toolCalls: [],
                findings: [],
            },
        });

        await parse([
            'try',
            'security',
            '--repo',
            'kodus-ai',
            '--pr',
            'https://github.com/acme/app/pull/3',
            '--json',
        ]);

        expect(service.tryAgent).toHaveBeenCalledWith(
            'security',
            'https://github.com/acme/app/pull/3',
            { team: undefined, repo: 'kodus-ai', directory: undefined },
            { input: undefined },
        );
    });
});

describe('readAgentFile', () => {
    it('reads instructions from markdown and fields from JSON', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-agents-'));
        const md = path.join(dir, 'agent.md');
        const json = path.join(dir, 'agent.json');
        await fs.writeFile(md, '# Review migrations\nCheck locks.');
        await fs.writeFile(
            json,
            JSON.stringify({
                name: 'Migrations',
                scope: { include: ['db/**'] },
            }),
        );

        await expect(readAgentFile(md)).resolves.toEqual({
            instructions: '# Review migrations\nCheck locks.',
        });
        await expect(readAgentFile(json)).resolves.toEqual({
            fromJson: { name: 'Migrations', scope: { include: ['db/**'] } },
        });
    });
});
