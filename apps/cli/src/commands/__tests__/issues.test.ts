import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/issues.service.js', () => ({
    FIX_PROMPT_MAX_ISSUES: 25,
    issuesService: {
        list: vi.fn(),
        fixPrompt: vi.fn(),
    },
}));

import { issuesService } from '../../services/issues.service.js';
import { issuesListAction, issuesShowAction } from '../issues.js';

const service = vi.mocked(issuesService);

const issue = (uuid: string): any => ({
    uuid,
    title: `Issue ${uuid}`,
    severity: 'high',
    status: 'open',
    filePath: 'src/a.ts',
    createdAt: '2026-11-01',
    repository: { id: 'r1', name: 'shop' },
});

describe('issues command actions', () => {
    let stdout: string;

    beforeEach(() => {
        vi.clearAllMocks();
        stdout = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            stdout += String(chunk);
            return true;
        });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('prints one fix prompt for the listed issues with --prompt-only', async () => {
        service.list.mockResolvedValue([issue('a'), issue('b')]);
        service.fixPrompt.mockResolvedValue({
            prompt: 'Fix these 2 issues',
            included: ['a', 'b'],
            skipped: [],
        });

        await issuesListAction({ security: true, promptOnly: true });

        expect(service.list).toHaveBeenCalledWith({
            status: undefined,
            security: true,
            repo: undefined,
        });
        expect(service.fixPrompt).toHaveBeenCalledWith(['a', 'b']);
        expect(stdout).toBe('Fix these 2 issues\n');
    });

    it('keeps --json with --prompt-only on list, as show does', async () => {
        service.list.mockResolvedValue([issue('a')]);
        const result = {
            prompt: 'Fix this issue',
            included: ['a'],
            skipped: [],
        };
        service.fixPrompt.mockResolvedValue(result);
        const logged: string[] = [];
        vi.mocked(console.log).mockImplementation((line) => {
            logged.push(String(line));
        });

        await issuesListAction({ promptOnly: true, json: true });

        // The JSON payload, not the bare prompt text.
        expect(stdout).toBe('');
        expect(logged.map((l) => JSON.parse(l))).toContainEqual(result);
    });

    it('prints the prompt of the given ids with show', async () => {
        service.fixPrompt.mockResolvedValue({
            prompt: 'Fix this issue',
            included: ['a'],
            skipped: [],
        });

        await issuesShowAction(['a'], { promptOnly: true });

        expect(service.fixPrompt).toHaveBeenCalledWith(['a']);
        expect(stdout).toBe('Fix this issue\n');
    });
});
