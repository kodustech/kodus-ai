import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    api: {
        issues: {
            listIssues: vi.fn(),
            fixPrompt: vi.fn(),
        },
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: {
        requireUserToken: vi.fn(),
    },
}));

import { api } from '../api/index.js';
import { FIX_PROMPT_MAX_ISSUES, issuesService } from '../issues.service.js';
import { userContextService } from '../user-context.service.js';

const issuesApi = vi.mocked(api.issues);
const userContext = vi.mocked(userContextService);

const issue = (uuid: string, overrides: Record<string, unknown> = {}): any => ({
    uuid,
    title: `Issue ${uuid}`,
    severity: 'medium',
    status: 'open',
    filePath: 'src/a.ts',
    createdAt: '2026-11-01',
    repository: { id: 'r1', name: 'shop' },
    ...overrides,
});

describe('issuesService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userContext.requireUserToken.mockResolvedValue('eyJ.user.token');
    });

    it('lists open issues, most severe first, by default', async () => {
        issuesApi.listIssues.mockResolvedValue([
            issue('low', { severity: 'low' }),
            issue('done', { status: 'resolved', severity: 'critical' }),
            issue('crit', { severity: 'critical' }),
        ]);

        const issues = await issuesService.list();

        expect(issues.map((i) => i.uuid)).toEqual(['crit', 'low']);
        expect(userContext.requireUserToken).toHaveBeenCalledWith('Issues');
    });

    it('narrows to security findings of one repository', async () => {
        issuesApi.listIssues.mockResolvedValue([
            issue('scan', { source: 'security_scan' }),
            issue('review'),
            issue('other-repo', {
                source: 'security_scan',
                repository: { id: 'r2', name: 'api' },
            }),
        ]);

        const issues = await issuesService.list({
            security: true,
            repo: 'Shop',
        });

        expect(issues.map((i) => i.uuid)).toEqual(['scan']);
    });

    it('refuses an unknown status', async () => {
        await expect(
            issuesService.list({ status: 'closed' as any }),
        ).rejects.toThrow(/Unknown status/);
    });

    it('asks the API for a prompt of at most the cap, without duplicates', async () => {
        issuesApi.fixPrompt.mockResolvedValue({
            prompt: 'p',
            included: [],
            skipped: [],
        });
        const ids = Array.from(
            { length: FIX_PROMPT_MAX_ISSUES + 5 },
            (_, i) => `id-${i}`,
        );

        await issuesService.fixPrompt(['id-0', ...ids]);

        const sent = issuesApi.fixPrompt.mock.calls[0][1];
        expect(sent).toHaveLength(FIX_PROMPT_MAX_ISSUES);
        expect(new Set(sent).size).toBe(sent.length);
    });

    it('needs at least one id', async () => {
        await expect(issuesService.fixPrompt([' '])).rejects.toThrow(
            /at least one issue id/,
        );
    });
});
