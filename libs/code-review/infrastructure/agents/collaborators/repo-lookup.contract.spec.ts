/**
 * The RepoLookup contract, exercised against a REAL sandbox.
 *
 * repo-lookup.spec.ts covers this module's logic with a stubbed RemoteCommands,
 * which is the right test for the logic and the wrong one for the contract: a
 * stub answers whatever the author imagined, and both shipped providers
 * answered something else. `exists` returned false for EVERY file on E2B
 * (listDir emitted absolute paths while the comparison is repo-relative) and
 * THREW on LocalSandbox whenever the parent directory was absent — which is the
 * ordinary case for a sibling candidate like `<dir>/__tests__/<name>`. Neither
 * was visible to a mock, and one of them was pinned by a passing unit test.
 *
 * So this file uses LocalSandboxService's own `buildRemoteCommands` over a real
 * temporary directory: real `rg`, real `find`, real filesystem. It is the same
 * shape as the existing `LocalSandboxService sandbox file access` suite.
 *
 * The E2B half cannot run without an API key, so its command construction is
 * pinned in e2b-sandbox.service.spec.ts and the two providers are compared live
 * by evals/kody-rules/lookup-conformance.js.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { buildRepoLookup, grepIsEmpty } from './repo-lookup';

describe('RepoLookup contract, over a real sandbox', () => {
    let dir: string;
    let lookup: ReturnType<typeof buildRepoLookup>;

    const handleFor = (repoDir: string): SandboxInstance =>
        ({
            remoteCommands: (
                new LocalSandboxService({} as any) as any
            ).buildRemoteCommands(repoDir),
            type: 'local',
            sandboxId: repoDir,
            repoDir,
            cleanup: async () => {},
        }) as unknown as SandboxInstance;

    const write = (rel: string, content: string) => {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-lookup-contract-'));
        write('src/orders/order.controller.ts', 'export class OrderController {}\n');
        write(
            'src/orders/order.controller.spec.ts',
            "import { OrderController } from './order.controller';\n",
        );
        write('src/shared/strings.ts', 'export function slugify() {}\n');
        lookup = buildRepoLookup(handleFor(dir));
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    describe('exists', () => {
        it('answers true for a file that is there', async () => {
            await expect(
                lookup.exists('src/orders/order.controller.spec.ts'),
            ).resolves.toBe(true);
        });

        it('answers false when the parent lists fine and the file is absent', async () => {
            await expect(
                lookup.exists('src/orders/order.controller.test.ts'),
            ).resolves.toBe(false);
        });

        // The regression that made sibling-file retrieval unusable on
        // self-hosted: a missing parent is a REAL ABSENCE, not a failure to
        // look, and `<dir>/__tests__/` usually does not exist.
        it('answers false when the parent directory does not exist', async () => {
            await expect(
                lookup.exists('src/orders/__tests__/order.controller.ts'),
            ).resolves.toBe(false);
        });

        it('answers false for a deeply absent path', async () => {
            await expect(lookup.exists('a/b/c/d.ts')).resolves.toBe(false);
        });

        it('does not mistake a prefix for the file itself', async () => {
            await expect(
                lookup.exists('src/orders/order.controller'),
            ).resolves.toBe(false);
        });

        // The other half of the contract: silence must never stand in for an
        // answer. A provider reports a broken command as an `Error:` payload,
        // and parsed as a listing that contains no match — i.e. "not there".
        it('THROWS when the listing came back as an error', async () => {
            const broken = buildRepoLookup({
                ...handleFor(dir),
                remoteCommands: {
                    grep: async () => '',
                    read: async () => '',
                    listDir: async () => 'Error: find: permission denied',
                },
            } as unknown as SandboxInstance);

            await expect(broken.exists('src/orders/x.ts')).rejects.toThrow(
                /permission denied/,
            );
        });
    });

    describe('grep', () => {
        it('returns repo-relative paths, never absolute ones', async () => {
            const out = await lookup.grep('slugify');
            expect(out).toContain('src/shared/strings.ts');
            expect(out).not.toContain(dir);
            expect(out.split('\n').filter(Boolean)).toEqual(
                expect.arrayContaining([expect.stringMatching(/^\.?\/?src\//)]),
            );
        });

        it('reports no occurrence in a form grepIsEmpty accepts', async () => {
            expect(grepIsEmpty(await lookup.grep('zzz_no_such_symbol'))).toBe(
                true,
            );
        });

        it('does not report an empty answer for a symbol that IS there', async () => {
            expect(grepIsEmpty(await lookup.grep('slugify'))).toBe(false);
        });
    });

    describe('read', () => {
        it('returns the requested line window', async () => {
            const out = await lookup.read('src/shared/strings.ts', 1, 1);
            expect(out).toContain('slugify');
        });

        it('THROWS for a file that is not there rather than answering empty', async () => {
            await expect(lookup.read('src/nope.ts', 1, 3)).rejects.toThrow();
        });
    });

    // A review that retrieved nothing looks exactly like a clean PR in every
    // other log line. These counters are the only signal that separates "the
    // repository said no" from "the repository never answered".
    describe('stats', () => {
        it('counts each accessor', async () => {
            await lookup.grep('slugify');
            await lookup.read('src/shared/strings.ts', 1, 1);
            await lookup.exists('src/shared/strings.ts');
            expect(lookup.stats).toMatchObject({
                grep: 1,
                read: 1,
                exists: 1,
                failures: 0,
            });
        });

        it('counts a raise as a failure and still lets it through', async () => {
            await expect(lookup.read('src/nope.ts', 1, 2)).rejects.toThrow();
            expect(lookup.stats.read).toBe(1);
            expect(lookup.stats.failures).toBe(1);
        });

        it('does not count a real absence as a failure', async () => {
            await expect(lookup.exists('src/orders/__tests__/x.ts')).resolves.toBe(
                false,
            );
            expect(lookup.stats.failures).toBe(0);
        });
    });

    describe('availability', () => {
        it('is unavailable, and throws on every accessor, without a handle', async () => {
            const none = buildRepoLookup(undefined);
            expect(none.available).toBe(false);
            await expect(none.exists('a.ts')).rejects.toThrow(/unavailable/);
            await expect(none.grep('x')).rejects.toThrow(/unavailable/);
            await expect(none.read('a.ts', 1, 2)).rejects.toThrow(/unavailable/);
        });

        it('probe leaves a healthy lookup available', async () => {
            await lookup.probe('src/shared/strings.ts');
            expect(lookup.available).toBe(true);
        });

        // The positive control that catches a sandbox answering with silence:
        // NULL_SANDBOX_INSTANCE used to return '' AND success, so an empty grep
        // would have "confirmed" a finding.
        it('probe disables the lookup when a known file reads back empty', async () => {
            const lying = buildRepoLookup({
                ...handleFor(dir),
                remoteCommands: {
                    grep: async () => '',
                    read: async () => '',
                    listDir: async () => '',
                },
            } as unknown as SandboxInstance);

            expect(lying.available).toBe(true);
            await lying.probe('src/shared/strings.ts');
            expect(lying.available).toBe(false);
            await expect(lying.grep('slugify')).rejects.toThrow(/unavailable/);
        });
    });
});
