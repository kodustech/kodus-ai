import { PlatformType } from '@libs/core/domain/enums';
import {
    LazyLinkedRepoAccess,
    formatLinkedReposSummaryLine,
} from '@libs/ee/linked-repositories';
import type { ResolvedLinkedRepository } from '@libs/ee/linked-repositories';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

function makeRepo(
    over: Partial<ResolvedLinkedRepository> = {},
): ResolvedLinkedRepository {
    const preferredRef = over.preferredRef ?? 'feature/x';
    const defaultBranch = over.defaultBranch ?? 'main';
    return {
        repository: 'org/backend-api',
        fullName: 'org/backend-api',
        id: '1',
        name: 'backend-api',
        preferredRef,
        defaultBranch,
        refCandidates: over.refCandidates ?? [
            {
                fetchRef: preferredRef,
                displayRef: preferredRef,
                source: 'head-branch',
            },
            {
                fetchRef: defaultBranch,
                displayRef: defaultBranch,
                source: 'default',
            },
            { fetchRef: 'main', displayRef: 'main', source: 'fallback' },
            { fetchRef: 'master', displayRef: 'master', source: 'fallback' },
        ],
        rootPath: '/home/user/_linked/org_backend-api',
        status: 'pending',
        ...over,
    };
}

function makeSandbox(
    runImpl?: SandboxInstance['run'],
): SandboxInstance {
    return {
        remoteCommands: {} as any,
        cleanup: async () => undefined,
        type: 'e2b',
        sandboxId: 'sbx',
        repoDir: '/home/user/repo',
        run:
            runImpl ||
            (async () => ({ stdout: '', stderr: '', exitCode: 0 })),
        readFile: async () => '',
        writeFile: async () => undefined,
    };
}

describe('LazyLinkedRepoAccess', () => {
    it('rejects unknown repo keys against the whitelist', async () => {
        const access = new LazyLinkedRepoAccess({
            sandbox: makeSandbox(),
            resolved: [makeRepo()],
            warnings: [],
            getCloneParams: async () => null,
        });
        const result = await access.ensureCloned('org/unknown');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Unknown linked repository');
        }
    });

    it('clones on first ensureCloned and reuses status on second call', async () => {
        let runs = 0;
        const access = new LazyLinkedRepoAccess({
            sandbox: makeSandbox(async () => {
                runs += 1;
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
            resolved: [makeRepo()],
            warnings: [],
            getCloneParams: async () => ({
                url: 'https://github.com/org/backend-api.git',
                authToken: 'tok',
                platform: PlatformType.GITHUB,
            }),
        });

        const first = await access.ensureCloned('org/backend-api');
        const second = await access.ensureCloned('backend-api');
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) {
            expect(first.rootPath).toBe('/home/user/_linked/org_backend-api');
            expect(second.ref).toBe(first.ref);
        }
        // Second call should not re-clone.
        expect(runs).toBe(1);
        expect(access.getMetadata().cloned).toBe(1);
    });

    it('falls through cascade candidates when first fetch fails', async () => {
        const refsTried: string[] = [];
        const access = new LazyLinkedRepoAccess({
            sandbox: makeSandbox(async (cmd) => {
                // Extract the ref from the fetch command.
                const m = cmd.match(
                    /fetch[^\n]*\s+'([^']+)':linked-head/,
                );
                if (m) refsTried.push(m[1]);
                // Fail first, succeed second.
                if (refsTried.length === 1) {
                    return {
                        stdout: '',
                        stderr: 'not found',
                        exitCode: 128,
                    };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
            resolved: [
                makeRepo({ preferredRef: 'feature/x', defaultBranch: 'main' }),
            ],
            warnings: [],
            getCloneParams: async () => ({
                url: 'https://github.com/org/backend-api.git',
                authToken: 'tok',
                platform: PlatformType.GITHUB,
            }),
        });

        const result = await access.ensureCloned('org/backend-api');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.ref).toBe('main');
        }
        expect(refsTried[0]).toBe('feature/x');
        expect(refsTried).toContain('main');
    });

    it('records open-PR display ref when that candidate wins', async () => {
        const access = new LazyLinkedRepoAccess({
            sandbox: makeSandbox(async () => ({
                stdout: '',
                stderr: '',
                exitCode: 0,
            })),
            resolved: [
                makeRepo({
                    preferredRef: 'open PR #77',
                    refCandidates: [
                        {
                            fetchRef: 'refs/pull/77/head',
                            displayRef: 'open PR #77',
                            source: 'open-pr',
                            prNumber: 77,
                        },
                        {
                            fetchRef: 'main',
                            displayRef: 'main',
                            source: 'default',
                        },
                    ],
                }),
            ],
            warnings: [],
            getCloneParams: async () => ({
                url: 'https://github.com/org/backend-api.git',
                authToken: 'tok',
                platform: PlatformType.GITHUB,
            }),
        });

        const result = await access.ensureCloned('org/backend-api');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.ref).toBe('open PR #77');
        }
        const meta = access.getMetadata();
        expect(meta.repositories[0].prNumber).toBe(77);
        expect(meta.repositories[0].source).toBe('open-pr');
        expect(
            formatLinkedReposSummaryLine(meta),
        ).toContain('open PR #77');
    });

    it('records failure without throwing when clone params are missing', async () => {
        const access = new LazyLinkedRepoAccess({
            sandbox: makeSandbox(),
            resolved: [makeRepo()],
            warnings: [],
            getCloneParams: async () => null,
        });
        const result = await access.ensureCloned('org/backend-api');
        expect(result.ok).toBe(false);
        expect(access.getMetadata().failed).toBe(1);
        expect(access.getMetadata().warnings.length).toBeGreaterThan(0);
    });

    it('formatLinkedReposSummaryLine only lists ready repos', () => {
        expect(
            formatLinkedReposSummaryLine({
                configured: 2,
                resolved: 2,
                cloned: 1,
                failed: 1,
                warnings: [],
                repositories: [
                    {
                        repository: 'org/backend-api',
                        ref: 'main',
                        status: 'ready',
                    },
                    {
                        repository: 'org/other',
                        ref: 'main',
                        status: 'failed',
                        reason: 'timeout',
                    },
                ],
            }),
        ).toContain('org/backend-api@main');
        expect(
            formatLinkedReposSummaryLine({
                configured: 0,
                resolved: 0,
                cloned: 0,
                failed: 0,
                warnings: [],
                repositories: [],
            }),
        ).toBe('');
    });

    it('formatLinkedReposSummaryLine annotates open PR source', () => {
        const line = formatLinkedReposSummaryLine({
            configured: 1,
            resolved: 1,
            cloned: 1,
            failed: 0,
            warnings: [],
            repositories: [
                {
                    repository: 'org/backend-api',
                    ref: 'feature/x',
                    source: 'open-pr',
                    prNumber: 77,
                    status: 'ready',
                },
            ],
        });
        expect(line).toContain('org/backend-api@feature/x');
        expect(line).toContain('open PR #77');
    });
});
