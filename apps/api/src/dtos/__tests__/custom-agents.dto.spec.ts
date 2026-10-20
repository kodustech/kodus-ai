import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
    CustomAgentsStatusQueryDto,
    ResolveCustomAgentDto,
    TryCustomAgentDto,
} from '../custom-agents.dto';

// Mirror the app's global ValidationPipe.
const VALIDATION_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

const failed = async (
    dto: new () => object,
    plain: Record<string, unknown>,
): Promise<string[]> =>
    (await validate(plainToInstance(dto, plain), VALIDATION_OPTIONS)).map(
        (e) => e.property,
    );

describe('custom agents request DTOs', () => {
    const agent = { id: 'a1', name: 'Ledger rules', tools: { mcp: [] } };
    const knowledge = [{ kind: 'skill', path: '.claude/skills/ledger' }];

    it('accepts what the settings page sends to resolve', async () => {
        expect(
            await failed(ResolveCustomAgentDto, {
                teamId: 't1',
                repositoryId: 'r1',
                agent,
                knowledge,
                discover: true,
            }),
        ).toEqual([]);
    });

    it('requires the team and repository to resolve', async () => {
        expect(await failed(ResolveCustomAgentDto, { agent })).toEqual(
            expect.arrayContaining(['teamId', 'repositoryId']),
        );
    });

    it('requires a pull request and an agent to try', async () => {
        expect(
            await failed(TryCustomAgentDto, {
                teamId: 't1',
                repositoryId: 'r1',
                prUrl: '   ',
            }),
        ).toEqual(expect.arrayContaining(['prUrl', 'agent']));
        expect(
            await failed(TryCustomAgentDto, {
                teamId: 't1',
                repositoryId: 'r1',
                prUrl: 'https://git.example.com/acme/ledger/pull/7',
                agent,
                knowledge,
            }),
        ).toEqual([]);
    });

    it('trims the pull request URL', () => {
        expect(
            plainToInstance(TryCustomAgentDto, {
                prUrl: '  https://git.example.com/acme/ledger/pull/7 ',
            }).prUrl,
        ).toBe('https://git.example.com/acme/ledger/pull/7');
    });

    it('requires the team and repository for the status', async () => {
        expect(await failed(CustomAgentsStatusQueryDto, {})).toEqual(
            expect.arrayContaining(['teamId', 'repositoryId']),
        );
    });
});
