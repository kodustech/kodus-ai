import { CreateOrUpdateParametersUseCase } from '@/core/application/use-cases/parameters/create-or-update-use-case';
import { FindByKeyParametersUseCase } from '@/core/application/use-cases/parameters/find-by-key-use-case';
import { ListCodeReviewAutomationLabelsUseCase } from '@/core/application/use-cases/parameters/list-code-review-automation-labels-use-case';
import { UpdateCodeReviewParameterRepositoriesUseCase } from '@/core/application/use-cases/parameters/update-code-review-parameter-repositories-use-case';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/update-or-create-code-review-parameter-use-case';

import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';

import { CreateOrUpdateCodeReviewParameterDto } from '../dtos/create-or-update-code-review-parameter.dto';
import { GenerateKodusConfigFileUseCase } from '@/core/application/use-cases/parameters/generate-kodus-config-file.use-case';
import { CopyCodeReviewParameterDTO } from '../dtos/copy-code-review-parameter.dto';
import { CopyCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/copy-code-review-parameter.use-case';
import { GenerateCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/generate-code-review-paremeter.use-case';
import { GenerateCodeReviewParameterDTO } from '../dtos/generate-code-review-parameter.dto';
@Controller('parameters')
export class ParametersController {
    constructor(
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly findByKeyParametersUseCase: FindByKeyParametersUseCase,
        private readonly listCodeReviewAutomationLabelsUseCase: ListCodeReviewAutomationLabelsUseCase,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly updateCodeReviewParameterRepositoriesUseCase: UpdateCodeReviewParameterRepositoriesUseCase,
        private readonly generateKodusConfigFileUseCase: GenerateKodusConfigFileUseCase,
        private readonly copyCodeReviewParameterUseCase: CopyCodeReviewParameterUseCase,
        private readonly generateCodeReviewParameterUseCase: GenerateCodeReviewParameterUseCase,
    ) { }

    //#region Parameters
    @Post('/create-or-update')
    public async createOrUpdate(
        @Body()
        body: {
            key: ParametersKey;
            configValue: any;
            organizationAndTeamData: { organizationId: string; teamId: string };
        },
    ) {
        return await this.createOrUpdateParametersUseCase.execute(
            body.key,
            body.configValue,
            body.organizationAndTeamData,
        );
    }

    @Get('/find-by-key')
    public async findByKey(
        @Query('key') key: ParametersKey,
        @Query('teamId') teamId: string,
    ) {
        return await this.findByKeyParametersUseCase.execute(key, { teamId });
    }

    @Get('/list-all')
    public async listAll() { }
    //endregion
    //#region Code review routes
    @Get('/list-code-review-automation-labels')
    public async listCodeReviewAutomationLabels() {
        return this.listCodeReviewAutomationLabelsUseCase.execute();
    }

    @Post('/create-or-update-code-review')
    public async updateOrCreateCodeReviewParameter(
        @Body()
        body: CreateOrUpdateCodeReviewParameterDto,
    ) {
        return await this.updateOrCreateCodeReviewParameterUseCase.execute(
            body,
        );
    }

    @Post('/update-code-review-parameter-repositories')
    public async UpdateCodeReviewParameterRepositories(
        @Body()
        body: {
            organizationAndTeamData: { organizationId: string; teamId: string };
        },
    ) {
        return await this.updateCodeReviewParameterRepositoriesUseCase.execute(
            body,
        );
    }

    @Get('/generate-kodus-config-file')
    public async GenerateKodusConfigFile(
        @Res() response: Response,
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
    ) {
        const { yamlString } =
            await this.generateKodusConfigFileUseCase.execute(
                teamId,
                repositoryId,
            );

        response.set({
            'Content-Type': 'application/x-yaml',
            'Content-Disposition': 'attachment; filename=kodus-config.yml',
        });

        return response.send(yamlString);
    }

    @Post('/copy-code-review-parameter')
    public async copyCodeReviewParameter(
        @Body()
        body: CopyCodeReviewParameterDTO,
    ) {
        return this.copyCodeReviewParameterUseCase.execute(body);
    }

    @Post('/generate-code-review-parameter')
    public async generateCodeReviewParameter(
        @Body()
        body: GenerateCodeReviewParameterDTO,
    ) {
        return this.generateCodeReviewParameterUseCase.execute(body);
    }
    //#endregion
}
