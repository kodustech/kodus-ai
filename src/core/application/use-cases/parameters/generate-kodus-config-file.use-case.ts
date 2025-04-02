import { Inject, Injectable } from '@nestjs/common';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { REQUEST } from '@nestjs/core';
import { KodusConfigFile } from '@/config/types/general/codeReview.type';

import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@/core/domain/codeBase/contracts/CodeBaseConfigService.contract';

interface ICodeRepository extends Partial<KodusConfigFile> {
    id: string;
    name: string;
}

@Injectable()
export class GenerateKodusConfigFileUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        teamId: string,
        repositoryId?: string,
    ): Promise<{ yamlString?: string }> {
        try {
            const organizationId = this.request.user?.organization.uuid;
            const organizationAndTeamData = {
                organizationId: organizationId,
                teamId,
            };

            if (!repositoryId || repositoryId === 'global') {
                return this.getKodyConfigFile();
            }

            const codeReviewConfigs = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const codeReviewRepositories = codeReviewConfigs.configValue
                .repositories as ICodeRepository[];

            const repository = codeReviewRepositories.find(
                (repository) => repository.id === repositoryId,
            );

            if (!repository) {
                return this.getKodyConfigFile();
            }

            const codeReviewConfig = await this.codeBaseConfigService.getConfig(
                organizationAndTeamData,
                { name: repository.name, id: repository.id },
                true,
            );

            const {
                languageResultPrompt,
                llmProvider,
                kodyRules,
                kodusConfigFileOverridesWebPreferences,
                ...codeReviewConfigsFile
            } = codeReviewConfig;

            const codeReviewConfigWithValidIgnorePaths: KodusConfigFile = {
                version: '1.2',
                ...codeReviewConfigsFile,
                ignorePaths: repository.ignorePaths,
            };

            return this.getKodyConfigFile(codeReviewConfigWithValidIgnorePaths);
        } catch (error) {
            this.logger.error({
                message: 'Failed to generate Kodus config file!',
                context: GenerateKodusConfigFileUseCase.name,
                error: error,
                metadata: {
                    parametersKey: ParametersKey.CODE_REVIEW_CONFIG,
                    teamId,
                    repositoryId,
                },
            });
            throw new Error(
                `Failed to generate Kodus config file for team ${teamId}${repositoryId ? ` and repository ${repositoryId}` : ''}: ${error.message}`,
            );
        }
    }

    private getKodyConfigFile(configObject?: KodusConfigFile): {
        yamlString: string;
    } {
        let yamlString: string;

        if (configObject) {
            yamlString = yaml.dump(configObject);
        } else {
            const kodusDefaultConfigYMLfile = yaml.load(
                fs.readFileSync('default-kodus-config.yml', 'utf8'),
            ) as KodusConfigFile;
            yamlString = yaml.dump(kodusDefaultConfigYMLfile);
        }

        return { yamlString };
    }
}
