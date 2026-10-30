/**
 * Regression for the centralized-config download returning 500.
 *
 *   TypeError: archiver is not a function
 *     at ParametersController.downloadCentralizedConfig (parameters.controller.ts:563:25)
 *
 * The endpoint shipped in d531f15b2 against archiver ^7.0.1, where the package
 * default export is a callable factory: `archiver('zip', opts)`. 7e390743f
 * ("migrate review agents to the agent-harness runtime", 2026-06-16) bumped the
 * dependency to ^8 as a side effect, and v8 exports only classes — `Archiver`,
 * `JsonArchive`, `TarArchive`, `ZipArchive` — with no callable default at all.
 * Neither download call site was migrated, so both have thrown ever since.
 *
 * `esModuleInterop` is off in tsconfig (only `allowSyntheticDefaultImports`,
 * which is types-only), so nothing failed at build time either: the type
 * checker accepted the default import that does not exist at runtime.
 *
 * This exercises the archive end to end rather than asserting on shapes. A
 * test that only checked `typeof createZipArchive === 'function'` would have
 * passed against the broken version too.
 */
import { createZipArchive } from '@libs/common/utils/zip-archive';

/** Local ZIP file header — every zip starts with it. */
const ZIP_MAGIC = Buffer.from('PK\x03\x04');

describe('createZipArchive', () => {
    it('produces a real zip containing the appended entry', async () => {
        const archive = createZipArchive();

        const chunks: Buffer[] = [];
        archive.on('data', (chunk: Buffer) => chunks.push(chunk));

        const done = new Promise<void>((resolve, reject) => {
            archive.on('end', () => resolve());
            archive.on('error', reject);
        });

        archive.append('version: 2\n', { name: 'kodus-config.yml' });
        await archive.finalize();
        await done;

        const output = Buffer.concat(chunks);

        expect(output.length).toBeGreaterThan(0);
        expect(output.subarray(0, 4)).toEqual(ZIP_MAGIC);
        // The entry name travels in the local header, so a non-empty archive
        // that omitted the append would still fail here.
        expect(output.toString('latin1')).toContain('kodus-config.yml');
    });
});
