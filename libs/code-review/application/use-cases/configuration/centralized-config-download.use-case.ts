import { Injectable } from '@nestjs/common';

import { createLogger } from '@kodus/flow';
import { GenerateKodusConfigFileUseCase } from './generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from './get-code-review-parameter.use-case';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';

@Injectable()
export class CentralizedConfigDownloadUseCase {
    private readonly logger = createLogger(
        CentralizedConfigDownloadUseCase.name,
    );

    constructor(
        private readonly getCodeReviewParameterUseCase: GetCodeReviewParameterUseCase,
        private readonly generateKodusConfigFileUseCase: GenerateKodusConfigFileUseCase,
    ) {}

    public async execute(
        user: Partial<IUser>,
        teamId: string,
        options: {
            skipAuthorization?: boolean;
            organizationId?: string;
        } = {},
    ): Promise<Array<{ path: string; content: string }>> {
        const entries: Array<{ path: string; content: string }> = [];

        // Default
        try {
            const kodusDefaultConfigYMLfile = yaml.load(
                fs.readFileSync('default-kodus-config.yml', 'utf8'),
            ) as KodusConfigFile;
            let yamlString = yaml.dump(kodusDefaultConfigYMLfile);
            yamlString = `# This file is a copy of the default Kodus configuration. It is provided for reference and can be used as a starting point for your own configuration.
# Any changes to this file will not affect the actual configuration used by Kodus.
# Your own configuration should be defined in the global or repository-specific config files.
# They behave as a diff to this default config, or higher level config that exists, so you only need to include the properties you want to override.
\n\n${yamlString}`;

            if (yamlString) {
                entries.push({
                    path: 'default-kodus-config.yml',
                    content: yamlString,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to load default Kodus config file',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: {
                    teamId,
                    errorMessage: error.message,
                },
            });
        }

        // Global
        try {
            const { yamlString } =
                await this.generateKodusConfigFileUseCase.execute(
                    teamId,
                    'global',
                    undefined,
                    { skipAuthorization: options.skipAuthorization },
                );

            if (yamlString) {
                entries.push({ path: 'kodus-config.yml', content: yamlString });
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to generate global Kodus config file',
                context: CentralizedConfigDownloadUseCase.name,
                metadata: {
                    teamId,
                    errorMessage: error.message,
                },
            });
        }

        // Fetch formatted config to enumerate repos/directories
        const codeReview = await this.getCodeReviewParameterUseCase.execute(
            user,
            teamId,
            options,
        );

        for (const repo of codeReview.configValue.repositories ?? []) {
            if (!repo.isSelected) {
                continue;
            }

            const repoFolderName = repo.name || repo.id;

            try {
                const { yamlString } =
                    await this.generateKodusConfigFileUseCase.execute(
                        teamId,
                        repo.id,
                        undefined,
                        { skipAuthorization: options.skipAuthorization },
                    );

                if (yamlString) {
                    entries.push({
                        path: `${repoFolderName}/kodus-config.yml`,
                        content: yamlString,
                    });
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to generate repo Kodus config file',
                    context: CentralizedConfigDownloadUseCase.name,
                    metadata: {
                        teamId,
                        repoId: repo.id,
                        errorMessage: error.message,
                    },
                });
            }

            for (const dir of repo.directories ?? []) {
                if (!dir.isSelected) {
                    continue;
                }

                try {
                    const { yamlString } =
                        await this.generateKodusConfigFileUseCase.execute(
                            teamId,
                            repo.id,
                            dir.id,
                            { skipAuthorization: options.skipAuthorization },
                        );

                    if (yamlString) {
                        const dirPath = (dir.path || '').replace(/^\//, '');
                        const entryName = dirPath
                            ? `${repoFolderName}/${dirPath}/kodus-config.yml`
                            : `${repoFolderName}/kodus-config.yml`;

                        entries.push({ path: entryName, content: yamlString });
                    }
                } catch (error) {
                    this.logger.error({
                        message:
                            'Failed to generate directory Kodus config file',
                        context: CentralizedConfigDownloadUseCase.name,
                        metadata: {
                            teamId,
                            repoId: repo.id,
                            dirId: dir.id,
                            errorMessage: error.message,
                        },
                    });
                }
            }
        }

        return entries;
    }
}
