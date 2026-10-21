jest.mock('e2b', () => {
    class CommandExitError extends Error {
        stdout: string;
        stderr: string;
        exitCode: number;
        constructor(o: { stdout: string; stderr: string; exitCode: number }) {
            super('command exited non-zero');
            this.stdout = o.stdout;
            this.stderr = o.stderr;
            this.exitCode = o.exitCode;
        }
    }
    return { CommandExitError, Sandbox: class {} };
});

import { fetchE2BSubmodules } from './e2b-sandbox.service';

const REPO = 'https://github.com/acme/app.git';
const AUTH = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46U0VDUkVU';

/**
 * A `.gitmodules` fixture: the file itself, and what
 * `git config -f .gitmodules --get-regexp '^submodule\\.'` prints for it.
 *
 * Both dumps are captured from real git — the provider reads the declaration
 * through git rather than scanning the file, because git's config parser
 * accepts shapes a scanner does not (see SUBMODULE_DECLARED_DUMP_ARGS).
 */
type Gitmodules = { file: string; declared: string };

const GITMODULES_SAME_HOST: Gitmodules = {
    file: '[submodule "packages/commons"]\n\tpath = packages/commons\n\turl = https://github.com/acme/commons.git\n',
    declared:
        'submodule.packages/commons.path packages/commons\n' +
        'submodule.packages/commons.url https://github.com/acme/commons.git\n',
};
const GITMODULES_FOREIGN_HOST: Gitmodules = {
    file: '[submodule "packages/commons"]\n\tpath = packages/commons\n\turl = https://evil.example/acme/commons.git\n',
    declared:
        'submodule.packages/commons.path packages/commons\n' +
        'submodule.packages/commons.url https://evil.example/acme/commons.git\n',
};

/**
 * Fake sandbox recording every command. `cat .gitmodules` answers with the
 * supplied content (or throws, the way a missing file does).
 */
function makeSandbox(
    gitmodules: Gitmodules | null,
    /** What `git config --get-regexp` reports after `git submodule init`. */
    resolvedDump = '',
) {
    const calls: Array<{ cmd: string; opts: any }> = [];
    return {
        calls,
        // Every argument is shell-quoted individually by the provider.
        submoduleCalls: () =>
            calls.filter((c) => c.cmd.includes("'submodule' 'update'")),
        cleanupCalls: () =>
            calls.filter((c) => c.cmd.includes("'--remove-section'")),
        commands: {
            run: jest.fn(async (cmd: string, opts: any) => {
                calls.push({ cmd, opts });
                if (cmd.includes('cat ') && cmd.includes('.gitmodules')) {
                    if (gitmodules === null) throw new Error('No such file');
                    return { stdout: gitmodules.file, stderr: '', exitCode: 0 };
                }
                // The base ref is present in the sandbox by default.
                if (cmd.includes("'rev-parse'")) {
                    return { stdout: 'abc123', stderr: '', exitCode: 0 };
                }
                // THREE dumps now: `--blob <ref>:.gitmodules` is what the BASE
                // branch declares, `-f .gitmodules` what the PR declares, and
                // the plain one what git RESOLVED after `submodule init`.
                if (cmd.includes("'--get-regexp'")) {
                    if (cmd.includes("'--blob'")) {
                        // Identical to the PR's: the already-merged case,
                        // which is the only one that fetches. The diverging
                        // cases are asserted in submodule-fetch.spec.ts.
                        return {
                            stdout: gitmodules?.declared ?? '',
                            stderr: '',
                            exitCode: 0,
                        };
                    }
                    const declaredDump = cmd.includes("'-f' '.gitmodules'");
                    return {
                        stdout: declaredDump
                            ? (gitmodules?.declared ?? '')
                            : resolvedDump,
                        stderr: '',
                        exitCode: 0,
                    };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            }),
        },
    };
}

const BASE_REF = 'origin/main';

const RESOLVED_SAME_HOST =
    'submodule.packages/commons.url https://github.com/acme/commons.git\n';
const RESOLVED_FOREIGN_HOST =
    'submodule.packages/commons.url https://evil.example/acme/commons.git\n';

describe('fetchE2BSubmodules — a same-host submodule is fetched', () => {
    it('issues one scoped `git submodule update` for the declared path', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });

        const [call] = sandbox.submoduleCalls();
        expect(call).toBeDefined();
        expect(call.cmd).toContain("'submodule' 'update' '--depth=1'");
        expect(call.cmd).toContain("'packages/commons'");
        expect(call.opts.envs).toMatchObject({
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
            GIT_CONFIG_VALUE_0: AUTH,
        });
    });

    it('never puts the token in the command string', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        for (const { cmd } of sandbox.calls) {
            expect(cmd).not.toContain(AUTH);
        }
    });

    it('never uses the global header key, which leaks the token to any host', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        const [call] = sandbox.submoduleCalls();
        expect(Object.values(call.opts.envs ?? {})).not.toContain(
            'http.extraHeader',
        );
    });

    it('is bounded by a timeout so a big repo cannot hang the review', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        expect(sandbox.submoduleCalls()[0].opts.timeoutMs).toBeGreaterThan(0);
    });
});

describe('fetchE2BSubmodules — a foreign-host submodule makes NO request', () => {
    it('never runs the fetch', async () => {
        const sandbox = makeSandbox(
            GITMODULES_FOREIGN_HOST,
            RESOLVED_FOREIGN_HOST,
        );
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        expect(sandbox.submoduleCalls()).toHaveLength(0);
    });

    it('never mentions the foreign host in any command', async () => {
        const sandbox = makeSandbox(
            GITMODULES_FOREIGN_HOST,
            RESOLVED_FOREIGN_HOST,
        );
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        for (const { cmd } of sandbox.calls) {
            expect(cmd).not.toContain('evil.example');
        }
    });

    it('reports the skip so it is visible in the logs, not silent', async () => {
        const warn = jest.fn();
        await fetchE2BSubmodules(
            makeSandbox(GITMODULES_FOREIGN_HOST, RESOLVED_FOREIGN_HOST) as any,
            REPO,
            AUTH,
            { logger: { warn } as any, baseRef: BASE_REF },
        );
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    skipped: [
                        expect.objectContaining({ path: 'packages/commons' }),
                    ],
                }),
            }),
        );
    });
});

describe('fetchE2BSubmodules — the rejected url does not survive in the checkout', () => {
    it('removes the config section `git submodule init` wrote for it', async () => {
        const sandbox = makeSandbox(
            GITMODULES_FOREIGN_HOST,
            RESOLVED_FOREIGN_HOST,
        );
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        const [cleanup] = sandbox.cleanupCalls();
        expect(cleanup).toBeDefined();
        expect(cleanup.cmd).toContain("'submodule.packages/commons'");
    });

    it('leaves an allowed submodule registered', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        expect(sandbox.cleanupCalls()).toHaveLength(0);
    });

    it('resolves urls BEFORE deciding — init runs, and it makes no network call', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        const order = sandbox.calls.map((c) => c.cmd);
        const initAt = order.findIndex((c) => c.includes("'submodule' 'init'"));
        const updateAt = order.findIndex((c) =>
            c.includes("'submodule' 'update'"),
        );
        expect(initAt).toBeGreaterThanOrEqual(0);
        expect(updateAt).toBeGreaterThan(initAt);
    });

    it('fetches nothing when git resolved no urls — unresolved is unvalidated', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, '');
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        expect(sandbox.submoduleCalls()).toHaveLength(0);
    });
});

describe('fetchE2BSubmodules — the log says WHICH review it belongs to', () => {
    // One worker runs several reviews at once, so a `[SUBMODULES]` line with
    // no pr number cannot be matched to the repository whose submodules did
    // not populate — which is the only question an operator asks about it.
    it('tags the skip warning with the caller metadata', async () => {
        const warn = jest.fn();
        await fetchE2BSubmodules(
            makeSandbox(GITMODULES_FOREIGN_HOST, RESOLVED_FOREIGN_HOST) as any,
            REPO,
            AUTH,
            {
                logger: { warn } as any,
                logMetadata: { prNumber: 196 },
                baseRef: BASE_REF,
            },
        );
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ prNumber: 196 }),
            }),
        );
    });

    it('reports how long the step took, for the p95 after rollout', async () => {
        const log = jest.fn();
        await fetchE2BSubmodules(
            makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST) as any,
            REPO,
            AUTH,
            {
                logger: { log, warn: jest.fn() } as any,
                logMetadata: { prNumber: 196 },
                baseRef: BASE_REF,
            },
        );
        const entry = log.mock.calls[0][0];
        expect(entry.metadata.durationMs).toEqual(expect.any(Number));
        expect(entry.message).toMatch(/in \d+ms/);
    });

    it('tags the success line too', async () => {
        const log = jest.fn();
        await fetchE2BSubmodules(
            makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST) as any,
            REPO,
            AUTH,
            {
                logger: { log, warn: jest.fn() } as any,
                logMetadata: { prNumber: 196 },
                baseRef: BASE_REF,
            },
        );
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ prNumber: 196 }),
            }),
        );
    });
});

describe('fetchE2BSubmodules — the time budget covers ALL submodules together', () => {
    const THREE: Gitmodules = {
        file:
            '[submodule "a"]\n\tpath = pkg/a\n\turl = https://github.com/acme/a.git\n' +
            '[submodule "b"]\n\tpath = pkg/b\n\turl = https://github.com/acme/b.git\n' +
            '[submodule "c"]\n\tpath = pkg/c\n\turl = https://github.com/acme/c.git\n',
        declared:
            'submodule.a.path pkg/a\nsubmodule.a.url https://github.com/acme/a.git\n' +
            'submodule.b.path pkg/b\nsubmodule.b.url https://github.com/acme/b.git\n' +
            'submodule.c.path pkg/c\nsubmodule.c.url https://github.com/acme/c.git\n',
    };
    const THREE_RESOLVED =
        'submodule.a.url https://github.com/acme/a.git\n' +
        'submodule.b.url https://github.com/acme/b.git\n' +
        'submodule.c.url https://github.com/acme/c.git\n';

    /** Each update takes real, measurable time so elapsed cannot be 0ms. */
    const slowSandbox = () => {
        const sandbox = makeSandbox(THREE, THREE_RESOLVED);
        const inner = sandbox.commands.run;
        sandbox.commands.run = jest.fn(async (cmd: string, opts: any) => {
            if (cmd.includes("'submodule' 'update'")) {
                await new Promise((r) => setTimeout(r, 20));
            }
            return inner(cmd, opts);
        }) as any;
        return sandbox;
    };

    it('hands each submodule what is LEFT, not a fresh full allowance', async () => {
        const sandbox = slowSandbox();
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        const budgets = sandbox
            .submoduleCalls()
            .map((c) => c.opts.timeoutMs as number);
        expect(budgets).toHaveLength(3);
        // With a per-path timeout these would all be the SAME number — three
        // submodules would each get the whole allowance and the review could
        // hang for three times as long. A shared deadline makes them shrink.
        expect(budgets[1]).toBeLessThan(budgets[0]);
        expect(budgets[2]).toBeLessThan(budgets[1]);
        expect(new Set(budgets).size).toBe(3);
    });

    it('never hands out more than the total budget', async () => {
        const sandbox = slowSandbox();
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        const budgets = sandbox
            .submoduleCalls()
            .map((c) => c.opts.timeoutMs as number);
        for (const b of budgets) expect(b).toBeLessThanOrEqual(120_000);
    });
});

describe('fetchE2BSubmodules — the deep retry deletes inside the checkout only', () => {
    /** Shallow always fails, so every submodule reaches the deep retry. */
    const shallowFails = (gm: Gitmodules, resolved: string) => {
        const sandbox = makeSandbox(gm, resolved);
        const inner = sandbox.commands.run;
        sandbox.commands.run = jest.fn(async (cmd: string, opts: any) => {
            if (cmd.includes("'--depth=1'")) throw new Error('unadvertised');
            return inner(cmd, opts);
        }) as any;
        return sandbox;
    };

    it('removes `.git/modules/<name>` under the repo dir, never above it', async () => {
        const sandbox = shallowFails(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        const removals = sandbox.calls
            .map((c) => c.cmd)
            .filter((cmd) => cmd.includes('rm -rf'));
        expect(removals).toHaveLength(1);
        // Keyed by NAME, and the name is the declared one.
        expect(removals[0]).toContain(
            "'/home/user/repo/.git/modules/packages/commons'",
        );
        // Nothing that `rm -rf` receives may climb out of the checkout.
        expect(removals[0]).not.toContain('..');
    });

    it('deletes NOTHING when the shallow fetch succeeds', async () => {
        // The other direction of the same guard: hoisting the cleanup out of
        // the deep retry would wipe a healthy `.git/modules/<name>` on the
        // happy path, and the test above — where every shallow fetch fails —
        // would still pass.
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        expect(
            sandbox.calls
                .map((c) => c.cmd)
                .filter((cmd) => cmd.includes('rm -rf')),
        ).toHaveLength(0);
        // And no deinit either — the recovery must not have started at all.
        expect(
            sandbox.calls
                .map((c) => c.cmd)
                .filter((cmd) => cmd.includes("'deinit'")),
        ).toHaveLength(0);
    });
});

describe('fetchE2BSubmodules — never breaks a review', () => {
    it('does nothing at all when the repo has no .gitmodules', async () => {
        const sandbox = makeSandbox(null);
        await fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
            baseRef: BASE_REF,
        });
        expect(sandbox.submoduleCalls()).toHaveLength(0);
    });

    it('swallows a failed fetch — a token without access must not fail the review', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        sandbox.commands.run = jest.fn(async (cmd: string) => {
            if (cmd.includes('.gitmodules')) {
                return {
                    stdout: cmd.includes("'--get-regexp'")
                        ? GITMODULES_SAME_HOST.declared
                        : GITMODULES_SAME_HOST.file,
                    stderr: '',
                    exitCode: 0,
                };
            }
            throw new Error('fatal: could not read Username');
        }) as any;
        await expect(
            fetchE2BSubmodules(sandbox as any, REPO, AUTH, {
                baseRef: BASE_REF,
            }),
        ).resolves.toBeUndefined();
    });

    it('works for an anonymous clone (public repo, no token)', async () => {
        const sandbox = makeSandbox(GITMODULES_SAME_HOST, RESOLVED_SAME_HOST);
        await fetchE2BSubmodules(sandbox as any, REPO, undefined, {
            baseRef: BASE_REF,
        });
        expect(sandbox.submoduleCalls()[0].opts.envs).toEqual({});
    });
});
