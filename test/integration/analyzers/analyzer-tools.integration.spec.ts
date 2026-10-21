/**
 * Runs each analyzer against a REAL sandbox and REAL binaries.
 *
 * Every unit spec for these tools mocks the sandbox, which verifies the
 * mapping logic and nothing about the contracts. Production bugs reached a
 * branch that way — a flag the CLI does not accept, a path form one sandbox
 * provider rejects, a method arity the interface disagreed with. All are
 * invisible to a mock and obvious here.
 *
 * Skips cleanly when a binary is absent, so it is safe to run anywhere. That
 * graceful skip is also how a suite quietly stops testing anything, so set
 * ANALYZER_INTEGRATION_STRICT=1 (in the image, in CI) to turn a missing binary
 * into a failure instead.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { DependencyScanTool } from '@libs/code-review/infrastructure/analyzers/tools/dependency-scan.tool';
import { SecretScanTool } from '@libs/code-review/infrastructure/analyzers/tools/secret-scan.tool';
import { ChangedFile } from '@libs/code-review/infrastructure/analyzers/tool.contract';

const execFileAsync = promisify(execFile);

/** Opt-in: a missing binary fails rather than skips. */
const STRICT = process.env.ANALYZER_INTEGRATION_STRICT === '1';

const onPath = (binary: string): boolean => {
    for (const dir of (process.env.PATH ?? '').split(':')) {
        if (dir && existsSync(join(dir, binary))) {
            return true;
        }
    }
    return false;
};

/**
 * A sandbox backed by the local filesystem and a real shell — the same
 * contract the providers implement, without needing a clone.
 */
function makeSandbox(repoDir: string): SandboxInstance {
    return {
        repoDir,
        type: 'local',
        sandboxId: 'integration',
        remoteCommands: {} as never,
        cleanup: async () => undefined,
        run: async (command: string) => {
            try {
                const { stdout, stderr } = await execFileAsync(
                    'bash',
                    ['-lc', command],
                    { maxBuffer: 64 * 1024 * 1024 },
                );
                return { stdout, stderr, exitCode: 0 };
            } catch (error) {
                const err = error as {
                    stdout?: string;
                    stderr?: string;
                    code?: number;
                };
                return {
                    stdout: err.stdout ?? '',
                    stderr: err.stderr ?? '',
                    exitCode: typeof err.code === 'number' ? err.code : 1,
                };
            }
        },
        readFile: async (path: string) => {
            const { stdout } = await execFileAsync('cat', [path], {
                maxBuffer: 64 * 1024 * 1024,
            });
            return stdout;
        },
        writeFile: async (path: string, content: string) => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, 'utf8');
        },
    } as SandboxInstance;
}

/** An all-added patch, so every line counts as introduced by the change. */
const wholeFilePatch = (content: string): string => {
    const lines = content.replace(/\n$/, '').split('\n');
    return [
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
    ].join('\n');
};

describe('analyzer tools against a real sandbox', () => {
    let repoDir: string;
    let sandbox: SandboxInstance;

    const write = async (
        path: string,
        content: string,
    ): Promise<ChangedFile> => {
        const absolute = join(repoDir, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content, 'utf8');
        return { filename: path, patch: wholeFilePatch(content) };
    };

    beforeAll(async () => {
        repoDir = await mkdtemp(join(tmpdir(), 'analyzer-integration-'));
        sandbox = makeSandbox(repoDir);
    });

    afterAll(async () => {
        await rm(repoDir, { recursive: true, force: true });
    });

    const maybe = (binary: string) => {
        if (onPath(binary)) {
            return it;
        }
        if (STRICT) {
            return ((name: string) =>
                it(name, () => {
                    throw new Error(
                        `${binary} is not on PATH, and ANALYZER_INTEGRATION_STRICT is set`,
                    );
                })) as unknown as typeof it;
        }
        return it.skip;
    };

    maybe('betterleaks')(
        'secret scan finds a committed token',
        async () => {
            const file = await write(
                'scripts/publish.js',
                'const auth = "ghp_9RmWkQ2xLpD7vTn4ZbJhYs6Fa8CgUe1XoNiV";\n',
            );

            const tool = new SecretScanTool();
            const findings = await tool.run({ sandbox, files: [file] });

            expect(findings.length).toBeGreaterThan(0);
            expect(findings[0].path).toBe('scripts/publish.js');
        },
        120_000,
    );

    maybe('osv-scanner')(
        'dependency scan reports only the package the diff introduced',
        async () => {
            const file = await write(
                'package-lock.json',
                JSON.stringify(
                    {
                        name: 'demo',
                        lockfileVersion: 3,
                        packages: {
                            'node_modules/lodash': { version: '4.17.11' },
                        },
                    },
                    null,
                    2,
                ),
            );

            const tool = new DependencyScanTool();
            const findings = await tool.run({ sandbox, files: [file] });

            expect(findings.length).toBeGreaterThan(0);
            expect(findings[0].path).toBe('package-lock.json');
            expect(findings[0].message).toContain('lodash');
        },
        240_000,
    );
});
