/**
 * Coverage for the web download endpoint.
 *
 * `GET /parameters/centralized-config-download` had no spec at all, which is
 * how it kept returning 500 after the archiver v8 bump without a single test
 * going red. Its CLI twin was covered, but only against a mocked archive, so
 * it stayed green too.
 *
 * These drive a real archive through the handler and assert on the bytes that
 * reach the response, so a controller that sets the headers and then forgets
 * to pipe cannot pass.
 */
import { PassThrough } from 'stream';

import { ParametersController } from '../parameters.controller';
import { createZipArchive } from '@libs/common/utils/zip-archive';

/** Local ZIP file header — every zip starts with it. */
const ZIP_MAGIC = Buffer.from('PK\x03\x04');

type ResponseDouble = PassThrough & { set: jest.Mock };

const buildResponse = (): ResponseDouble =>
    Object.assign(new PassThrough(), { set: jest.fn() }) as ResponseDouble;

const buildController = (
    centralizedConfigDownloadUseCase: { executeAsZipStream: jest.Mock },
    request: any,
) =>
    new ParametersController(
        request,
        null as any, // createOrUpdateParametersUseCase
        null as any, // findByKeyParametersUseCase
        null as any, // updateOrCreateCodeReviewParameterUseCase
        null as any, // updateCodeReviewParameterRepositoriesUseCase
        null as any, // generateKodusConfigFileUseCase
        null as any, // deleteRepositoryCodeReviewParameterUseCase
        null as any, // previewPrSummaryUseCase
        null as any, // listCodeReviewAutomationLabelsWithStatusUseCase
        null as any, // getDefaultConfigUseCase
        null as any, // getCodeReviewParameterUseCase
        null as any, // centralizedConfigSyncUseCase
        centralizedConfigDownloadUseCase as any,
        null as any, // centralizedConfigInitUseCase
        null as any, // codeBaseConfigService
    );

describe('ParametersController › downloadCentralizedConfig', () => {
    const user = { uuid: 'user-1', organization: { uuid: 'org-1' } };

    it('streams the archive bytes to the response', async () => {
        const archive = createZipArchive();
        archive.append('version: 2\n', { name: 'kodus-config.yml' });
        void archive.finalize();

        const centralizedConfigDownloadUseCase = {
            executeAsZipStream: jest.fn().mockResolvedValue(archive),
        };

        const controller = buildController(centralizedConfigDownloadUseCase, {
            user,
        });

        const response = buildResponse();
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));

        await controller.downloadCentralizedConfig(response as any, 'team-1');

        expect(response.set).toHaveBeenCalledWith({
            'Content-Type': 'application/zip',
            'Content-Disposition':
                'attachment; filename=centralized-config.zip',
        });
        expect(
            centralizedConfigDownloadUseCase.executeAsZipStream,
        ).toHaveBeenCalledWith(user, 'team-1');

        const output = Buffer.concat(chunks);
        expect(output.subarray(0, 4)).toEqual(ZIP_MAGIC);
        expect(output.toString('latin1')).toContain('kodus-config.yml');
    });

    it('destroys the response when the archive fails mid-stream', async () => {
        const archive = new PassThrough();

        const centralizedConfigDownloadUseCase = {
            executeAsZipStream: jest.fn().mockResolvedValue(archive),
        };

        const controller = buildController(centralizedConfigDownloadUseCase, {
            user,
        });

        const response = buildResponse();
        response.resume();

        const done = controller.downloadCentralizedConfig(
            response as any,
            'team-1',
        );

        // Headers are already on the wire by now, so the only thing left is to
        // kill the connection — a truncated zip beats a silently valid one.
        setImmediate(() => archive.emit('error', new Error('disk full')));

        await expect(done).rejects.toThrow();
        expect(response.destroyed).toBe(true);
    });

    it('refuses to build anything without an organization', async () => {
        const centralizedConfigDownloadUseCase = {
            executeAsZipStream: jest.fn(),
        };

        const controller = buildController(centralizedConfigDownloadUseCase, {
            user: { uuid: 'user-1' },
        });

        await expect(
            controller.downloadCentralizedConfig(
                buildResponse() as any,
                'team-1',
            ),
        ).rejects.toThrow('Organization ID is missing from request');

        expect(
            centralizedConfigDownloadUseCase.executeAsZipStream,
        ).not.toHaveBeenCalled();
    });
});
