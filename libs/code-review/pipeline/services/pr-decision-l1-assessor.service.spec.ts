import type {
    GateVerdict,
    L1Verdict,
} from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';

import { PrDecisionL1AssessorService } from './pr-decision-l1-assessor.service';

function ready<T>(verdict: GateVerdict<T>): T {
    if (verdict.status !== 'Ready') {
        throw new Error(`Expected a Ready verdict, got ${verdict.status}`);
    }
    return verdict.value;
}

function unavailable<T>(verdict: GateVerdict<T>): string {
    if (verdict.status !== 'Unavailable') {
        throw new Error(
            `Expected an Unavailable verdict, got ${verdict.status}`,
        );
    }
    return verdict.reason;
}

describe('PrDecisionL1AssessorService', () => {
    const CLI = {
        install: jest.fn().mockResolvedValue(undefined),
        analyzeFiles: jest.fn().mockResolvedValue(undefined),
    };

    /** A repository whose graph baseline is READY (the only case where L1 runs). */
    function repoService(status: AstGraphStatus = AstGraphStatus.READY) {
        return {
            findByExternalId: jest.fn().mockResolvedValue({
                uuid: 'repo-uuid',
                astGraphStatus: status,
            }),
        } as any;
    }

    function buildService(cli: any = CLI, repos: any = repoService()) {
        return new PrDecisionL1AssessorService(cli, repos);
    }

    /** A sandbox whose baseline subgraph is present at the expected path. */
    function sandboxWithBaseline(over: Partial<Record<string, any>> = {}) {
        return {
            repoDir: '/repo',
            run: jest.fn(),
            readFile: jest.fn(async (path: string) => {
                if (path.includes('base-graph.json')) {
                    return JSON.stringify({ nodes: [], edges: [] });
                }
                return JSON.stringify({
                    risk_score: { score: 0.16, level: 'LOW' },
                });
            }),
            ...over,
        } as any;
    }

    const INPUT = (sandbox: any = null) => ({
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        prNumber: 142,
        headSha: 'h',
        baseSha: 'b',
        changedFiles: [{ filename: 'src/a.ts', status: 'modified' }],
        graphPath: '.kodus-graph/base-graph.json',
        snapshotKey: 'k',
        sandbox,
        platform: 'forgejo',
    });

    it('is Unavailable when there is no sandbox', async () => {
        const reason = unavailable(await buildService().assess(INPUT(null)));

        expect(reason).toMatch(/sandbox/i);
    });

    it('is Unavailable when the PR has no changed source files', async () => {
        const reason = unavailable(
            await buildService().assess({
                ...INPUT(sandboxWithBaseline()),
                changedFiles: [{ filename: 'README.md', status: 'modified' }],
            }),
        );

        expect(reason).toMatch(/source files/i);
    });

    describe('the graph baseline', () => {
        it('is Unavailable when the repository has no graph baseline', async () => {
            const reason = unavailable(
                await buildService(
                    CLI,
                    repoService(AstGraphStatus.PENDING),
                ).assess(INPUT(sandboxWithBaseline())),
            );

            expect(reason).toMatch(/no graph baseline/i);
            expect(reason).toContain('pending');
        });

        it('is Unavailable when the graph build FAILED', async () => {
            const reason = unavailable(
                await buildService(
                    CLI,
                    repoService(AstGraphStatus.FAILED),
                ).assess(INPUT(sandboxWithBaseline())),
            );

            expect(reason).toMatch(/no graph baseline/i);
        });

        it('is Unavailable when the repository record is missing', async () => {
            const missing = {
                findByExternalId: jest.fn().mockResolvedValue(null),
            } as any;
            const reason = unavailable(
                await buildService(CLI, missing).assess(
                    INPUT(sandboxWithBaseline()),
                ),
            );

            expect(reason).toMatch(/no graph baseline/i);
        });

        it('is Unavailable when the baseline is not in the sandbox', async () => {
            // The subgraph export only happens for a READY repository; if the
            // review fell back to the legacy path, there is no file.
            const sandbox = {
                repoDir: '/repo',
                run: jest.fn(),
                readFile: jest.fn().mockRejectedValue(new Error('ENOENT')),
            } as any;
            const reason = unavailable(
                await buildService().assess(INPUT(sandbox)),
            );

            expect(reason).toMatch(/no graph baseline in the sandbox/i);
        });

        it('does not run the CLI when the baseline is missing', async () => {
            const cli = { ...CLI, analyzeFiles: jest.fn() };
            const sandbox = {
                repoDir: '/repo',
                run: jest.fn(),
                readFile: jest.fn().mockRejectedValue(new Error('ENOENT')),
            } as any;

            await buildService(cli).assess(INPUT(sandbox));

            expect(cli.analyzeFiles).not.toHaveBeenCalled();
        });
    });

    it('is Unavailable when the CLI throws', async () => {
        const cli = {
            ...CLI,
            analyzeFiles: jest
                .fn()
                .mockRejectedValue(new Error('exit=1: graph not found')),
        };
        const reason = unavailable(
            await buildService(cli).assess(INPUT(sandboxWithBaseline())),
        );

        expect(reason).toMatch(/kodus-graph analyze failed/);
        expect(reason).toMatch(/graph not found/);
    });

    it('is Unavailable when the analyze output is not valid JSON', async () => {
        const sandbox = sandboxWithBaseline({
            readFile: jest.fn(async (path: string) =>
                path.includes('base-graph.json')
                    ? JSON.stringify({ nodes: [] })
                    : 'not json at all',
            ),
        });
        const reason = unavailable(await buildService().assess(INPUT(sandbox)));

        expect(reason).toMatch(/not valid JSON/i);
    });

    it('is Unavailable when the analyze output lacks a risk score', async () => {
        const sandbox = sandboxWithBaseline({
            readFile: jest.fn(async (path: string) =>
                path.includes('base-graph.json')
                    ? JSON.stringify({ nodes: [] })
                    : JSON.stringify({}),
            ),
        });
        const reason = unavailable(await buildService().assess(INPUT(sandbox)));

        expect(reason).toMatch(/risk_score/i);
    });

    it('maps a valid analyze output to Ready with the risk level', async () => {
        const sandbox = sandboxWithBaseline({
            readFile: jest.fn(async (path: string) =>
                path.includes('base-graph.json')
                    ? JSON.stringify({ nodes: [] })
                    : JSON.stringify({
                          risk_score: {
                              score: 0.16,
                              level: 'LOW',
                              factors: {
                                  blast_radius: {
                                      value: 0.1,
                                      detail: 'small',
                                  },
                              },
                          },
                      }),
            ),
        });
        const value = ready<L1Verdict>(
            await buildService().assess(INPUT(sandbox)),
        );

        expect(value.level).toBe('LOW');
        expect(value.riskScore).toBe(0.16);
    });

    it('analyzes against the baseline path the graph context wrote', async () => {
        const cli = {
            ...CLI,
            analyzeFiles: jest.fn().mockResolvedValue(undefined),
        };

        await buildService(cli).assess(INPUT(sandboxWithBaseline()));

        // The path is the one `GraphContextService` writes the subgraph to —
        // not an invented per-PR filename.
        expect(cli.analyzeFiles.mock.calls[0][2].graphPath).toBe(
            '.kodus-graph/base-graph.json',
        );
    });

    it('passes only source files to the CLI and skips tests and removals', async () => {
        const cli = {
            ...CLI,
            analyzeFiles: jest.fn().mockResolvedValue(undefined),
        };

        await buildService(cli).assess({
            ...INPUT(sandboxWithBaseline()),
            changedFiles: [
                { filename: 'src/a.ts', status: 'modified' },
                { filename: 'src/a.test.ts', status: 'modified' },
                { filename: 'src/gone.ts', status: 'removed' },
                { filename: 'README.md', status: 'modified' },
            ],
        });

        expect(cli.analyzeFiles.mock.calls[0][1]).toEqual(['src/a.ts']);
    });

    it('installs the CLI before analyzing', async () => {
        const order: string[] = [];
        const cli = {
            install: jest.fn(async () => {
                order.push('install');
            }),
            analyzeFiles: jest.fn(async () => {
                order.push('analyze');
            }),
        };

        await buildService(cli).assess(INPUT(sandboxWithBaseline()));

        expect(order).toEqual(['install', 'analyze']);
    });

    it('reads the repository by the platform and external id', async () => {
        const repos = repoService();
        const cli = {
            ...CLI,
            analyzeFiles: jest.fn().mockResolvedValue(undefined),
        };

        await buildService(cli, repos).assess(INPUT(sandboxWithBaseline()));

        expect(repos.findByExternalId).toHaveBeenCalledWith(
            'forgejo',
            'repo-1',
        );
    });

    it('runs in the sandbox ITS input carries — two calls do not share state', async () => {
        // The reconciler may run for several PRs concurrently in one worker
        // process, so the assessor must not hold the sandbox between calls.
        const cli = {
            ...CLI,
            analyzeFiles: jest.fn().mockResolvedValue(undefined),
        };
        const sandboxA = sandboxWithBaseline({ repoDir: '/repo-a' });
        const sandboxB = sandboxWithBaseline({ repoDir: '/repo-b' });

        await buildService(cli).assess(INPUT(sandboxA));
        await buildService(cli).assess(INPUT(sandboxB));

        expect(cli.analyzeFiles.mock.calls[0][2].repoDir).toBe('/repo-a');
        expect(cli.analyzeFiles.mock.calls[1][2].repoDir).toBe('/repo-b');
    });
});
