import { GetOrganizationNameUseCase } from '@/core/application/use-cases/organization/get-organization-name';
import { GetOrganizationLanguageUseCase } from '@/core/application/use-cases/organization/get-organization-language.use-case';
import { GetOrganizationsByDomainUseCase } from '@/core/application/use-cases/organization/get-organizations-domain.use-case';
import { UpdateInfoOrganizationAndPhoneUseCase } from '@/core/application/use-cases/organization/update-infos.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { UserRequest } from '@/config/types/http/user-request.type';
import { CacheService } from '@/shared/utils/cache/cache.service';
import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Patch,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';
import { UpdateInfoOrganizationAndPhoneDto } from '../dtos/updateInfoOrgAndPhone.dto';

@Controller('organization')
export class OrganizationController {
    constructor(
        private readonly getOrganizationNameUseCase: GetOrganizationNameUseCase,
        private readonly getOrganizationLanguageUseCase: GetOrganizationLanguageUseCase,
        private readonly updateInfoOrganizationAndPhoneUseCase: UpdateInfoOrganizationAndPhoneUseCase,
        private readonly getOrganizationsByDomainUseCase: GetOrganizationsByDomainUseCase,
        private readonly cacheService: CacheService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Get('/name')
    public getOrganizationName() {
        return this.getOrganizationNameUseCase.execute();
    }

    @Patch('/update-infos')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings
        }),
    )
    public async updateInfoOrganizationAndPhone(
        @Body() body: UpdateInfoOrganizationAndPhoneDto,
    ) {
        return await this.updateInfoOrganizationAndPhoneUseCase.execute(body);
    }

    @Get('/domain')
    public async getOrganizationsByDomain(
        @Query('domain')
        domain: string,
    ) {
        return await this.getOrganizationsByDomainUseCase.execute(domain);
    }

    @Get('/language')
    public async getOrganizationLanguage(
        @Query('teamId') teamId: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('sampleSize') sampleSize?: string,
    ) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        if (!teamId) {
            throw new BadRequestException('teamId is required');
        }

        const cacheKey = `organization-language:${organizationId}:${teamId}:${repositoryId ?? 'auto'}:${sampleSize ?? 'default'}`;

        const cached = await this.cacheService.getFromCache<{
            language: string | null;
        }>(cacheKey);
        if (cached) return cached;

        const result = await this.getOrganizationLanguageUseCase.execute({
            teamId,
            repositoryId,
            sampleSize: sampleSize ? Number(sampleSize) : undefined,
        });

        await this.cacheService.addToCache(cacheKey, result, 900000);
        return result;
    }
}
