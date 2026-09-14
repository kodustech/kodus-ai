/**
 * Spec for the repository-lookup capability signal (issue #1826).
 *
 * Derived from spec.md, not from the implementation:
 *   KRC-01  availability is an explicit signal derived from the sandbox handle
 *   KRC-02  an unavailable lookup RAISES from grep and read; it never answers ''
 *   KRC-22  a read that comes back empty while the lookup claims to be
 *           available means the lookup is lying: treat it as unavailable for
 *           the rest of the review, and record it
 */
import {
    buildRepoLookup,
    RepoLookupUnavailableError,
} from './repo-lookup';
import { NULL_SANDBOX_INSTANCE } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

const realHandle = (
    over: Partial<SandboxInstance['remoteCommands']> = {},
): SandboxInstance =>
    ({
        type: 'e2b',
        sandboxId: 'sb-1',
        repoDir: '/repo',
        cleanup: async () => undefined,
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        readFile: async () => '',
        writeFile: async () => undefined,
        remoteCommands: {
            grep: async () => 'src/a.ts:4:formatDate(order.placedAt)\n',
            read: async () => 'export const x = 1;\n',
            listDir: async () => 'src/routes/orders.controller.ts\n',
            ...over,
        },
    }) as unknown as SandboxInstance;

describe('buildRepoLookup — availability derived from the sandbox handle (KRC-01)', () => {
    it('reports unavailable when there is no sandbox handle at all', () => {
        expect(buildRepoLookup(undefined).available).toBe(false);
        expect(buildRepoLookup(undefined).unavailableReason).toBe(
            'no sandbox handle',
        );
    });

    it('reports unavailable for the null sandbox, which answers empty AND success', () => {
        // The whole point: NULL_SANDBOX_INSTANCE.grep resolves '' without
        // throwing, so nothing downstream can tell it from a real empty result.
        const lookup = buildRepoLookup(NULL_SANDBOX_INSTANCE);
        expect(lookup.available).toBe(false);
        expect(lookup.unavailableReason).toBe('null sandbox');
    });

    it('reports available for a real sandbox handle', () => {
        const lookup = buildRepoLookup(realHandle());
        expect(lookup.available).toBe(true);
        expect(lookup.unavailableReason).toBe('');
    });

    it('reports unavailable when the handle carries no remote commands', () => {
        const handle = { type: 'e2b' } as unknown as SandboxInstance;
        expect(buildRepoLookup(handle).available).toBe(false);
        expect(buildRepoLookup(handle).unavailableReason).toBe(
            'sandbox handle carries no remote commands',
        );
    });
});

describe('an unavailable lookup raises instead of answering empty (KRC-02)', () => {
    it.each([
        ['no handle', undefined],
        ['null sandbox', NULL_SANDBOX_INSTANCE],
    ])('grep throws RepoLookupUnavailableError (%s)', async (_label, handle) => {
        const lookup = buildRepoLookup(handle as SandboxInstance | undefined);
        await expect(lookup.grep('formatDate')).rejects.toBeInstanceOf(
            RepoLookupUnavailableError,
        );
    });

    it.each([
        ['no handle', undefined],
        ['null sandbox', NULL_SANDBOX_INSTANCE],
    ])('read throws RepoLookupUnavailableError (%s)', async (_label, handle) => {
        const lookup = buildRepoLookup(handle as SandboxInstance | undefined);
        await expect(lookup.read('src/a.ts', 1, 20)).rejects.toBeInstanceOf(
            RepoLookupUnavailableError,
        );
    });

    it('exists throws too, so "not found" can never be manufactured by absence', async () => {
        const lookup = buildRepoLookup(NULL_SANDBOX_INSTANCE);
        await expect(lookup.exists('src/a.spec.ts')).rejects.toBeInstanceOf(
            RepoLookupUnavailableError,
        );
    });

    it('names the operation and the reason so a log line says what was refused', async () => {
        const lookup = buildRepoLookup(NULL_SANDBOX_INSTANCE);
        await expect(lookup.grep('formatDate')).rejects.toThrow(
            /null sandbox.*cannot grep "formatDate"/,
        );
    });
});

describe('an available lookup delegates to the sandbox', () => {
    it('grep forwards the pattern, path and glob and returns the output', async () => {
        const grep = jest.fn().mockResolvedValue('src/a.ts:4:hit\n');
        const lookup = buildRepoLookup(realHandle({ grep }));

        await expect(lookup.grep('formatDate', 'src', '*.ts')).resolves.toBe(
            'src/a.ts:4:hit\n',
        );
        expect(grep).toHaveBeenCalledWith('formatDate', 'src', '*.ts');
    });

    it('grep defaults to the repository root when no path is given', async () => {
        const grep = jest.fn().mockResolvedValue('');
        await buildRepoLookup(realHandle({ grep })).grep('formatDate');
        expect(grep).toHaveBeenCalledWith('formatDate', '.', undefined);
    });

    it('read forwards the line window and returns the content', async () => {
        const read = jest.fn().mockResolvedValue('line 4\nline 5\n');
        const lookup = buildRepoLookup(realHandle({ read }));

        await expect(lookup.read('src/a.ts', 4, 5)).resolves.toBe(
            'line 4\nline 5\n',
        );
        expect(read).toHaveBeenCalledWith('src/a.ts', 4, 5);
    });

    it('exists is true when the parent listing contains the path', async () => {
        const listDir = jest
            .fn()
            .mockResolvedValue(
                'src/routes/orders.controller.ts\nsrc/routes/orders.controller.spec.ts\n',
            );
        const lookup = buildRepoLookup(realHandle({ listDir }));

        await expect(
            lookup.exists('src/routes/orders.controller.spec.ts'),
        ).resolves.toBe(true);
        expect(listDir).toHaveBeenCalledWith('src/routes', 1);
    });

    it('exists is false when the listing succeeded and the path is not in it', async () => {
        const listDir = jest
            .fn()
            .mockResolvedValue('src/routes/orders.controller.ts\n');
        const lookup = buildRepoLookup(realHandle({ listDir }));

        await expect(
            lookup.exists('src/routes/orders.controller.spec.ts'),
        ).resolves.toBe(false);
    });

    it('exists propagates a listing failure instead of reporting "not there"', async () => {
        // "I could not check" reported as "it is absent" would CONFIRM a
        // `missing` claim from a broken lookup — the exact inversion #1826 is
        // about. The caller must see the failure and fail closed.
        const listDir = jest.fn().mockRejectedValue(new Error('sandbox gone'));
        const lookup = buildRepoLookup(realHandle({ listDir }));

        await expect(lookup.exists('src/routes/a.spec.ts')).rejects.toThrow(
            'sandbox gone',
        );
    });
});

describe('probe — an available lookup that answers with silence is not available (KRC-22)', () => {
    it('flips availability off when a known changed file reads back empty', async () => {
        const lookup = buildRepoLookup(realHandle({ read: async () => '' }));
        expect(lookup.available).toBe(true);

        await lookup.probe('src/orders/order-mapper.ts');

        expect(lookup.available).toBe(false);
        expect(lookup.unavailableReason).toBe(
            'a read of a known changed file came back empty',
        );
    });

    it('keeps the lookup off for the REST of the review, not just for the probe', async () => {
        const lookup = buildRepoLookup(realHandle({ read: async () => '' }));
        await lookup.probe('src/orders/order-mapper.ts');

        await expect(lookup.grep('formatDate')).rejects.toBeInstanceOf(
            RepoLookupUnavailableError,
        );
        await expect(lookup.read('src/a.ts', 1, 2)).rejects.toBeInstanceOf(
            RepoLookupUnavailableError,
        );
    });

    it('records the flip with the file that exposed it', async () => {
        const warn = jest.fn();
        const lookup = buildRepoLookup(realHandle({ read: async () => '   \n' }), {
            warn,
        });

        await lookup.probe('src/orders/order-mapper.ts');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatchObject({
            context: 'repo-lookup',
            metadata: { file: 'src/orders/order-mapper.ts' },
        });
        expect(warn.mock.calls[0][0].message).toContain(
            'came back empty',
        );
    });

    it('flips availability off when the probe read throws', async () => {
        const warn = jest.fn();
        const lookup = buildRepoLookup(
            realHandle({
                read: async () => {
                    throw new Error('ENOENT');
                },
            }),
            { warn },
        );

        await expect(
            lookup.probe('src/orders/order-mapper.ts'),
        ).resolves.toBeUndefined();
        expect(lookup.available).toBe(false);
        expect(warn.mock.calls[0][0].metadata).toMatchObject({ err: 'ENOENT' });
    });

    it('leaves a healthy lookup available when the probe reads real content', async () => {
        const lookup = buildRepoLookup(
            realHandle({ read: async () => 'export const x = 1;\n' }),
        );

        await lookup.probe('src/orders/order-mapper.ts');

        expect(lookup.available).toBe(true);
        await expect(lookup.grep('x')).resolves.toContain('formatDate');
    });

    it('is a no-op on an already unavailable lookup (no sandbox to probe with)', async () => {
        const warn = jest.fn();
        const lookup = buildRepoLookup(NULL_SANDBOX_INSTANCE, { warn });

        await expect(lookup.probe('src/a.ts')).resolves.toBeUndefined();

        expect(lookup.available).toBe(false);
        expect(lookup.unavailableReason).toBe('null sandbox');
        expect(warn).not.toHaveBeenCalled();
    });
});
