import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getGitRoot: vi.fn(),
        getHooksDir: vi.fn(),
    },
}));

import { gitService } from '../../services/git.service.js';
import { buildStatusReport, statusAction } from '../trace/status.js';
import { appendRecordLine } from '../../services/trace/session-store.js';
import { saveLocalBranchRecord } from '../../services/trace/local-decisions.js';
import { recordIncident } from '../../services/trace/incidents.js';
import { pinDecision } from '../../services/trace/overrides.js';
import { installSessionHooks } from '../trace/session-hooks-install.js';
import { gitHooksService } from '../../services/git-hooks.service.js';

let repoRoot: string;
let traceHome: string;
let hooksDir: string;

beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-status-repo-'));
    traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-status-home-'));
    process.env.KODUS_TRACE_HOME = traceHome;
    hooksDir = path.join(repoRoot, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });

    vi.mocked(gitService.getGitRoot).mockResolvedValue(repoRoot);
    vi.mocked(gitService.getHooksDir).mockResolvedValue(hooksDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    delete process.env.KODUS_TRACE_HOME;
    vi.restoreAllMocks();
    await Promise.all(
        [repoRoot, traceHome].map((dir) =>
            fs.rm(dir, { recursive: true, force: true }),
        ),
    );
});

async function seedSession(sessionId: string): Promise<void> {
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'session-start',
        sessionId,
        agentType: 'claude-code',
        branch: 'feat/x',
        baseCommit: 'abc',
        gitRemote: '',
        cliVersion: '1.0.0',
        timestamp: '2026-03-01T09:00:00.000Z',
    });
    await appendRecordLine(repoRoot, sessionId, {
        kind: 'turn-start',
        turnId: 't1',
        prompt: 'do the thing',
        commitBefore: 'abc',
        timestamp: '2026-03-01T09:00:01.000Z',
    });
}

function printed(): string {
    return vi.mocked(console.log).mock.calls.flat().join('\n');
}

describe('trace status', () => {
    it('says so plainly when nothing has been captured', async () => {
        await statusAction({});

        const output = printed();
        expect(output).toContain('No sessions captured yet');
        expect(output).toContain('kodus trace enable');
    });

    it('counts sessions, turns and decisions', async () => {
        await seedSession('sess-1');
        await seedSession('sess-2');
        await saveLocalBranchRecord(repoRoot, {
            version: 1,
            branch: 'feat/x',
            mergeBase: 'a',
            head: 'b',
            commits: ['b'],
            updatedAt: '2026-03-01T10:00:00.000Z',
            decisions: [
                {
                    id: 'dec-1',
                    type: 'convention',
                    decision: 'one',
                    scope: ['src'],
                },
                {
                    id: 'dec-2',
                    type: 'tradeoff',
                    decision: 'two',
                    scope: ['src'],
                },
            ],
        });

        const report = await buildStatusReport(repoRoot, hooksDir);

        expect(report.sessions).toBe(2);
        expect(report.turns).toBe(2);
        expect(report.decisions.local).toBe(2);
        expect(report.lastCaptureAt).toBeTruthy();
    });

    it('reports which agent hooks are installed', async () => {
        let report = await buildStatusReport(repoRoot, hooksDir);
        expect(report.hooks.claudeCode).toBe(false);
        expect(report.hooks.gitPrePush).toBe(false);

        await installSessionHooks(repoRoot, 'claude-code');
        await gitHooksService.install(hooksDir);

        report = await buildStatusReport(repoRoot, hooksDir);
        expect(report.hooks.claudeCode).toBe(true);
        expect(report.hooks.gitPrePush).toBe(true);
        expect(report.hooks.gitPrepareCommitMsg).toBe(true);
    });

    it('reports a push collision that survived the retry', async () => {
        await recordIncident(repoRoot, {
            at: '2026-03-01T11:00:00.000Z',
            kind: 'push-collision',
            branch: 'feat/x',
            message: 'non-fast-forward after rebase',
        });

        await statusAction({});

        const output = printed();
        expect(output).toContain('Problems');
        expect(output).toContain('non-fast-forward after rebase');
    });

    it('reports human corrections', async () => {
        await pinDecision(repoRoot, 'dec-1');

        const report = await buildStatusReport(repoRoot, hooksDir);
        expect(report.pinned).toBe(1);
        expect(report.forgotten).toBe(0);
    });

    it('emits JSON when asked', async () => {
        await seedSession('sess-1');

        await statusAction({}, { format: 'json' } as never);

        const parsed = JSON.parse(printed());
        expect(parsed.sessions).toBe(1);
        expect(parsed.storePath).toContain(traceHome);
    });
});
