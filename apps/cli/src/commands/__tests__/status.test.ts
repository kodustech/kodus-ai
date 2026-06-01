import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/auth-mode.js', () => ({
    getAuthModeSummary: vi.fn(),
}));

vi.mock('../../services/git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(false),
        getGitRoot: vi.fn(),
        getCurrentBranch: vi.fn(),
    },
}));

vi.mock('../../utils/skills.js', () => ({
    listBundledSkills: vi.fn().mockResolvedValue([]),
}));

import { getAuthModeSummary } from '../../utils/auth-mode.js';
import { statusAction } from '../status.js';

const mockGetAuthModeSummary = vi.mocked(getAuthModeSummary);

function captureOutput(): () => string {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    return () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
}

describe('statusAction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('flags team key as not configured when logged in', async () => {
        mockGetAuthModeSummary.mockResolvedValue({
            mode: 'logged-in',
            source: 'stored',
            label: 'logged in',
        });
        const output = captureOutput();

        await statusAction();

        expect(output()).toContain('logged in');
        expect(output()).toContain('Team key:');
        expect(output()).toContain('not configured');
        expect(output()).toContain('required for: rules, config writes');
    });

    it('reports team key as configured in team-key mode', async () => {
        mockGetAuthModeSummary.mockResolvedValue({
            mode: 'team-key',
            source: 'stored',
            label: 'team key',
        });
        const output = captureOutput();

        await statusAction();

        expect(output()).toMatch(/Team key:\s+configured/);
        expect(output()).not.toContain('required for: rules, config writes');
    });
});
