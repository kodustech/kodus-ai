/**
 * The archive is driven for real here rather than mocked.
 *
 * The archiver v8 bump broke both download endpoints and no test noticed,
 * because the only coverage asserted on the shape of a mocked archive. A
 * `typeof === 'function'` check would have passed against the broken version
 * too, so these assertions look at the bytes that come out.
 */
import { CentralizedConfigDownloadZipUseCase } from '../centralized-config-download-zip.use-case';

/** Local ZIP file header — every zip starts with it. */
const ZIP_MAGIC = Buffer.from('PK\x03\x04');

describe('CentralizedConfigDownloadZipUseCase', () => {
    const user = { uuid: 'user-1', organization: { uuid: 'org-1' } } as any;
    const teamId = 'team-1';

    const drain = async (archive: NodeJS.ReadableStream): Promise<Buffer> => {
        const chunks: Buffer[] = [];
        archive.on('data', (chunk: Buffer) => chunks.push(chunk));

        await new Promise<void>((resolve, reject) => {
            archive.on('end', () => resolve());
            archive.on('error', reject);
        });

        return Buffer.concat(chunks);
    };

    it('packs every entry from the download use-case into a real zip', async () => {
        const entries = [
            { path: 'kodus-config.yml', content: 'version: 2\n' },
            { path: 'repo-one/kodus-config.yml', content: 'bug: true\n' },
            {
                path: 'repo-one/.kody-rules/review/no-raw-sql.yml',
                content: 'title: No raw SQL\n',
            },
        ];

        const centralizedConfigDownloadUseCase = {
            execute: jest.fn().mockResolvedValue(entries),
        };

        const useCase = new CentralizedConfigDownloadZipUseCase(
            centralizedConfigDownloadUseCase as any,
        );

        const archive = await useCase.execute(user, teamId, {
            skipAuthorization: true,
        });

        const output = await drain(archive);

        expect(output.subarray(0, 4)).toEqual(ZIP_MAGIC);
        // The entry name travels in each local header, so an archive that
        // skipped an append still fails here.
        for (const entry of entries) {
            expect(output.toString('latin1')).toContain(entry.path);
        }

        expect(centralizedConfigDownloadUseCase.execute).toHaveBeenCalledWith(
            user,
            teamId,
            { skipAuthorization: true },
        );
    });

    it('propagates a failure from the download use-case', async () => {
        const centralizedConfigDownloadUseCase = {
            execute: jest.fn().mockRejectedValue(new Error('no such team')),
        };

        const useCase = new CentralizedConfigDownloadZipUseCase(
            centralizedConfigDownloadUseCase as any,
        );

        // Rejecting before any byte is produced is what lets the controller
        // answer with an error status instead of a truncated zip.
        await expect(useCase.execute(user, teamId)).rejects.toThrow(
            'no such team',
        );
    });
});
