import { isExpiredTokenDownload, SetupRepoTokensRequestSchema, setupRepoTokensRunOut } from './setup-repo-tokens';

// What the product accepts as the boot new download tokens are for.
describe('the boot a setup asks new download tokens for', () => {
    it("is the setup's first boot, one of Kody's repairs, or one of the learn loop's clean boots (two per hypothesis), and nothing else", () => {
        const ok = (attempt: string) => SetupRepoTokensRequestSchema.safeParse({ attempt }).success;
        expect(['boot', 'repair-1', 'repair-5', 'learn-1', 'learn-6'].filter(ok)).toEqual(['boot', 'repair-1', 'repair-5', 'learn-1', 'learn-6']);
        expect(['boot-1', 'boots', 'repair-0', 'repair-6', 'learn-0', 'learn-7', 'learn-1-replay', 'author-0', 'learn-01'].filter(ok)).toEqual([]);
    });
});

// A download token lives an hour from when the product issued it.
describe("a boot's download tokens", () => {
    const ISSUED = '2026-11-12T01:48:07.000Z';
    const after = (min: number) => new Date(Date.parse(ISSUED) + min * 60_000).toISOString();

    it('run out when less than 15 minutes of their hour is left when the boot starts', () => {
        expect([0, 44, 45, 46, 77].map((m) => setupRepoTokensRunOut(ISSUED, after(m)))).toEqual([false, false, false, true, true]);
        expect(setupRepoTokensRunOut('not a time', after(77))).toBe(false);
    });

    it("are expired when the cell's download was refused with 401 past their hour, and only then", () => {
        const refused = { kind: 'platform', signature: 'repo_fetch', message: 'repo_fetch: tarball: download status 401' };
        expect(isExpiredTokenDownload(refused, ISSUED, after(60))).toBe(true);
        expect(isExpiredTokenDownload({ ...refused, message: 'repo_fetch: in repository billing: tarball: download status 401\ntoken revocation (3 tries): 401' }, ISSUED, after(77))).toBe(true);
        // Still in their hour: revoked, or an installation removed; new tokens would not change it.
        expect(isExpiredTokenDownload(refused, ISSUED, after(59))).toBe(false);
        // Not the download refused for its token.
        for (const other of [
            { ...refused, message: 'repo_fetch: tarball: download status 404' },
            { ...refused, message: 'repo_fetch: tarball: download status 4010' },
            { ...refused, signature: 'repo_refused' },
            { ...refused, kind: 'toolchain' },
            undefined,
        ]) {
            expect(isExpiredTokenDownload(other, ISSUED, after(77))).toBe(false);
        }
    });
});
