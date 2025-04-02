import { CreateOrUpdateKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/create-or-update.use-case';
import { DeleteByOrganizationIdKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/delete-by-organization-id.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/delete-rule-in-organization-by-id.use-case';
import { FindByOrganizationIdKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-by-organization-id.use-case';
import { FindRuleInOrganizationByRuleIdKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-rule-in-organization-by-id.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-rules-in-organization-by-filter.use-case';
import { CreateKodyRuleDto } from '../dtos/create-kody-rule.dto';
import { FindLibraryKodyRulesDto } from '../dtos/find-library-kody-rules.dto';
import {
    Body,
    Controller,
    Delete,
    Get,
    Inject,
    Post,
    Query,
} from '@nestjs/common';
import { FindLibraryKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/find-library-kody-rules.use-case';
import { AddLibraryKodyRulesDto } from '../dtos/add-library-kody-rules.dto';
import { AddLibraryKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/add-library-kody-rules.use-case';
import { GenerateKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/generate-kody-rules.use-case';
import { GenerateKodyRulesDTO } from '../dtos/generate-kody-rules.dto';
import { ChangeStatusKodyRulesDTO } from '../dtos/change-status-kody-rules.dto';
import { ChangeStatusKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/change-status-kody-rules.use-case';
import { REQUEST } from '@nestjs/core';

@Controller('kody-rules')
export class KodyRulesController {
    constructor(
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly findByOrganizationIdKodyRulesUseCase: FindByOrganizationIdKodyRulesUseCase,
        private readonly findRuleInOrganizationByIdKodyRulesUseCase: FindRuleInOrganizationByRuleIdKodyRulesUseCase,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly deleteByOrganizationIdKodyRulesUseCase: DeleteByOrganizationIdKodyRulesUseCase,
        private readonly deleteRuleInOrganizationByIdKodyRulesUseCase: DeleteRuleInOrganizationByIdKodyRulesUseCase,
        private readonly findLibraryKodyRulesUseCase: FindLibraryKodyRulesUseCase,
        private readonly addLibraryKodyRulesUseCase: AddLibraryKodyRulesUseCase,
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
        private readonly changeStatusKodyRulesUseCase: ChangeStatusKodyRulesUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    @Post('/create-or-update')
    public async create(
        @Body()
        body: CreateKodyRuleDto,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }
        return this.createOrUpdateKodyRulesUseCase.execute(
            body,
            this.request.user.organization.uuid,
        );
    }

    @Get('/find-by-organization-id')
    public async findByOrganizationId() {
        return this.findByOrganizationIdKodyRulesUseCase.execute();
    }

    @Get('/find-rule-in-organization-by-id')
    public async findRuleInOrganizationById(
        @Query('ruleId')
        ruleId: string,
    ) {
        return this.findRuleInOrganizationByIdKodyRulesUseCase.execute(ruleId);
    }

    @Get('/find-rules-in-organization-by-title')
    public async findRulesInOrganizationByTitle(
        @Query('title')
        title: string,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
            this.request.user.organization.uuid,
            { title },
        );
    }

    @Get('/find-rules-in-organization-by-severity')
    public async findRulesInOrganizationBySeverity(
        @Query('severity')
        severity: string,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
            this.request.user.organization.uuid,
            { severity },
        );
    }

    @Get('/find-rules-in-organization-by-path')
    public async findRulesInOrganizationByPath(
        @Query('path')
        path: string,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
            this.request.user.organization.uuid,
            { path },
        );
    }

    @Get('/find-rules-in-organization-by-filter')
    public async findRulesInOrganizationByFilter(
        @Query('key')
        key: string,
        @Query('value')
        value: string,
        @Query('repositoryId')
        repositoryId?: string,
    ) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
            this.request.user.organization.uuid,
            { [key]: value },
            repositoryId,
        );
    }

    @Delete('/delete-by-organization-id')
    public async deleteByOrganizationId() {
        return this.deleteByOrganizationIdKodyRulesUseCase.execute();
    }

    @Delete('/delete-rule-in-organization-by-id')
    public async deleteRuleInOrganizationById(
        @Query('ruleId')
        ruleId: string,
    ) {
        return this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
            ruleId,
        );
    }

    @Get('/find-library-kody-rules')
    public async findLibraryKodyRules(@Body() body: FindLibraryKodyRulesDto) {
        return this.findLibraryKodyRulesUseCase.execute(body);
    }

    @Post('/add-library-kody-rules')
    public async addLibraryKodyRules(@Body() body: AddLibraryKodyRulesDto) {
        return this.addLibraryKodyRulesUseCase.execute(body);
    }

    @Post('/generate-kody-rules')
    public async generateKodyRules(@Body() body: GenerateKodyRulesDTO) {
        if (!this.request.user.organization.uuid) {
            throw new Error('Organization ID not found');
        }

        return this.generateKodyRulesUseCase.execute(
            body,
            this.request.user.organization.uuid,
        );
    }

    @Post('/change-status-kody-rules')
    public async changeStatusKodyRules(@Body() body: ChangeStatusKodyRulesDTO) {
        return this.changeStatusKodyRulesUseCase.execute(body);
    }
}
