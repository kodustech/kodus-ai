import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';

import { createLogger } from '@libs/core/log/logger';
import { createZipArchive } from '@libs/common/utils/zip-archive';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { CentralizedConfigDownloadUseCase } from './centralized-config-download.use-case';

/**
 * Packs the centralized config entries into a zip stream.
 *
 * Both download endpoints used to build the archive themselves, which is how
 * the archiver v8 bump broke them in two places at once. This owns the
 * packing so the controllers keep only headers and a pipe.
 */
@Injectable()
export class CentralizedConfigDownloadZipUseCase implements IUseCase {
    private readonly logger = createLogger(
        CentralizedConfigDownloadZipUseCase.name,
    );

    constructor(
        private readonly centralizedConfigDownloadUseCase: CentralizedConfigDownloadUseCase,
    ) {}

    public async execute(
        user: Partial<IUser>,
        teamId: string,
        options: {
            skipAuthorization?: boolean;
            organizationId?: string;
            markRulesAsPendingWithSourcePath?: boolean;
        } = {},
    ): Promise<Readable> {
        const entries = await this.centralizedConfigDownloadUseCase.execute(
            user,
            teamId,
            options,
        );

        const archive = createZipArchive();

        for (const entry of entries) {
            archive.append(entry.content, { name: entry.path });
        }

        // Not awaited: the caller has to be piping before the archive drains.
        // A rejection here would otherwise be unhandled, so it is routed back
        // into the stream as an 'error' the caller is already listening for.
        // It is logged here too: the caller only sees a destroyed stream after
        // headers are already on the wire, so this is the last place with
        // enough context to say which download failed and why.
        archive.finalize().catch((error) => {
            this.logger.error({
                message: 'Failed to finalize centralized config zip',
                context: CentralizedConfigDownloadZipUseCase.name,
                metadata: {
                    teamId,
                    organizationId:
                        user?.organization?.uuid || options.organizationId,
                    entryCount: entries.length,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                },
            });

            archive.destroy(
                error instanceof Error ? error : new Error(String(error)),
            );
        });

        return archive;
    }
}
