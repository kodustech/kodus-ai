import { AzureReposRequestHelper } from './azure-repos-request-helper';

/**
 * Tests for the two pre-existing bugs in the Azure DevOps adapter
 * that surfaced once the kodus-flow logger stopped masking errors
 * under `loggerFallback: true / RangeError`:
 *
 *  1. `mapAzureStatusToFileChangeStatus` only handles bare verbs
 *     ('add', 'edit', 'rename', ...) but Azure's `VersionControlChangeType`
 *     is a bit-flag enum that serializes as a comma-joined string when
 *     more than one flag is set (e.g. 'add, edit', 'sourceRename, edit',
 *     'rename, edit'). Anything compound falls through the switch into
 *     the 'changed' default, which is NOT equal to 'added' — so
 *     `_generateFileDiffForAzure` then tries to fetch the file at the
 *     base commit even for newly-added files, producing pointless 404s
 *     on every `.gitkeep` and other freshly-added file in big PRs.
 *
 *  2. `getFileContent` catches the AxiosError 404 and wraps it in a
 *     plain `new Error('File not found...')` whose only
 *     reference back to the original is via `cause`. The caller
 *     (`_generateFileDiffForAzure`) checks `error.status === 404` to
 *     decide between 'warn + treat as empty content' (correct path)
 *     and 'log full error + throw' (error path). Without `status`
 *     preserved on the wrapper, the 404 always hits the error path.
 *
 * These tests pin both bugs before the fix and lock the correct
 * behavior after.
 */

describe('AzureReposRequestHelper.mapAzureStatusToFileChangeStatus', () => {
    let helper: AzureReposRequestHelper;

    beforeEach(() => {
        helper = new AzureReposRequestHelper();
    });

    describe('bare verbs (already worked)', () => {
        it.each([
            ['add', 'added'],
            ['added', 'added'],
            ['edit', 'modified'],
            ['modified', 'modified'],
            ['delete', 'removed'],
            ['removed', 'removed'],
            ['rename', 'renamed'],
            ['renamed', 'renamed'],
            ['copy', 'copied'],
            ['copied', 'copied'],
            ['unchanged', 'unchanged'],
        ])('maps "%s" → "%s"', (input, expected) => {
            expect(helper.mapAzureStatusToFileChangeStatus(input)).toBe(
                expected,
            );
        });

        it('is case-insensitive on bare verbs', () => {
            expect(helper.mapAzureStatusToFileChangeStatus('ADD')).toBe(
                'added',
            );
            expect(helper.mapAzureStatusToFileChangeStatus('Edit')).toBe(
                'modified',
            );
        });

        it('returns "changed" as the safe default for unknown verbs', () => {
            expect(helper.mapAzureStatusToFileChangeStatus('unknown')).toBe(
                'changed',
            );
        });
    });

    describe('compound bit-flag values (the .gitkeep bug)', () => {
        // Azure's VersionControlChangeType is a bit-flag, serialized
        // as a comma-joined string. Real-world examples observed in
        // production logs against Discourse repos:
        //   "add, edit"          — newly-added file then immediately edited
        //   "edit, rename"       — renamed file plus content change
        //   "sourceRename, edit" — the destination side of a rename
        //   "delete, sourceRename" — old path of a rename (source side)
        //
        // Resolution priority: delete > add > rename > edit > else.
        // Reason for the order:
        //   - delete dominates because if the file is removed, there
        //     is nothing to diff against the target commit.
        //   - add dominates over edit/rename because the file did not
        //     exist before — fetching at baseCommit is guaranteed 404.
        //   - rename dominates over edit so we route to the renamed
        //     path with originalPath.
        //   - edit is the catch-all for "changed but still here".

        it('"add, edit" → "added" (was wrongly "changed" pre-fix)', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus('add, edit'),
            ).toBe('added');
        });

        it('"edit, add" → "added" (token order must not matter)', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus('edit, add'),
            ).toBe('added');
        });

        it('"edit, rename" → "renamed"', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus('edit, rename'),
            ).toBe('renamed');
        });

        it('"sourceRename, edit" → "renamed"', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus('sourceRename, edit'),
            ).toBe('renamed');
        });

        it('"delete, sourceRename" → "removed" (delete dominates)', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus(
                    'delete, sourceRename',
                ),
            ).toBe('removed');
        });

        it('handles extra whitespace and mixed casing', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus(' Add ,  Edit '),
            ).toBe('added');
            expect(
                helper.mapAzureStatusToFileChangeStatus('EDIT,RENAME'),
            ).toBe('renamed');
        });

        it('still returns "changed" when no recognized verb is present', () => {
            expect(
                helper.mapAzureStatusToFileChangeStatus('encoding, property'),
            ).toBe('changed');
        });
    });
});

describe('AzureReposRequestHelper.getFileContent — 404 wrapper preserves status', () => {
    let helper: AzureReposRequestHelper;
    let axiosInstance: { get: jest.Mock };

    beforeEach(() => {
        helper = new AzureReposRequestHelper();
        axiosInstance = { get: jest.fn() };
        jest.spyOn(helper as any, 'azureRequest').mockResolvedValue(
            axiosInstance,
        );
    });

    /**
     * Builds an AxiosError-shaped object the way axios produces them.
     * The helper's catch block only checks `error.response.status`, so
     * a minimal stub is enough; no need to depend on the real `axios`.
     */
    function axios404(): any {
        const err: any = new Error('Request failed with status code 404');
        err.name = 'AxiosError';
        err.response = { status: 404, data: {} };
        return err;
    }

    it('throws an error with status=404 attached when Azure returns 404', async () => {
        // Both attempts in getFileContent (the items?path= path and the
        // items/<path>?version= fallback) must fail for the catch to
        // be reached.
        axiosInstance.get.mockRejectedValue(axios404());

        let thrown: any;
        try {
            await helper.getFileContent({
                orgName: 'org',
                token: 'enc-token',
                projectId: 'proj',
                repositoryId: 'repo',
                filePath: '/app/assets/javascripts/admin/app/.gitkeep',
                commitId: '8646c21',
            });
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeDefined();
        // The wrapper message remains so existing log greps still match.
        expect(thrown.message).toContain('File not found');
        expect(thrown.message).toContain(
            '/app/assets/javascripts/admin/app/.gitkeep',
        );
        // The fix: status is preserved on the rethrown error so the
        // caller in `_generateFileDiffForAzure` (line ~3548) can
        // branch on `error.status === 404` and route to the cheap
        // 'treat as empty content' warn path instead of the noisy
        // 'log full stack + rethrow' error path.
        expect(thrown.status).toBe(404);
        // The original AxiosError remains reachable via cause for
        // anyone who needs the request context.
        expect(thrown.cause).toBeDefined();
        expect(thrown.cause.response?.status).toBe(404);
    });

    it('does NOT attach status=404 for non-404 errors (e.g. 500)', async () => {
        const err500: any = new Error('Request failed with status code 500');
        err500.response = { status: 500, data: {} };
        axiosInstance.get.mockRejectedValue(err500);

        let thrown: any;
        try {
            await helper.getFileContent({
                orgName: 'org',
                token: 'enc-token',
                projectId: 'proj',
                repositoryId: 'repo',
                filePath: '/server-glitch.ts',
                commitId: 'abc123',
            });
        } catch (e) {
            thrown = e;
        }

        // 500s and other transient failures bubble up as-is (no
        // wrapper) so the caller's outer try/catch logs them with
        // full context. Asserting `status !== 404` here is the
        // anti-regression — we never want a non-404 to be miscoded
        // as 404 and silently swallowed downstream.
        expect(thrown).toBeDefined();
        expect(thrown.status).not.toBe(404);
    });
});
