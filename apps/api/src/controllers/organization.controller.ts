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

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { UpdateInfoOrganizationAndPhoneDto } from '../dtos/updateInfoOrgAndPhone.dto';
import { GetOrganizationNameUseCase } from '@libs/organization/application/use-cases/organization/get-organization-name';
import { UpdateInfoOrganizationAndPhoneUseCase } from '@libs/organization/application/use-cases/organization/update-infos.use-case';
import { GetOrganizationsByDomainUseCase } from '@libs/organization/application/use-cases/organization/get-organizations-domain.use-case';
import { GetReleaseTrackUseCase } from '@libs/organization/application/use-cases/organization/get-release-track.use-case';
import { GetOrganizationLanguageUseCase } from '@libs/platform/application/use-cases/organization/get-organization-language.use-case';
import { CacheService } from '@libs/core/cache/cache.service';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ApiArrayResponseDto,
    ApiBooleanResponseDto,
    ApiStringResponseDto,
} from '../dtos/api-response.dto';
import { OrganizationLanguageResponseDto } from '../dtos/organization-response.dto';

@ApiTags('Organization')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('organization')
export class OrganizationController {
    constructor(
        private readonly getOrganizationNameUseCase: GetOrganizationNameUseCase,
        private readonly getOrganizationLanguageUseCase: GetOrganizationLanguageUseCase,
        private readonly updateInfoOrganizationAndPhoneUseCase: UpdateInfoOrganizationAndPhoneUseCase,
        private readonly getOrganizationsByDomainUseCase: GetOrganizationsByDomainUseCase,
        private readonly getReleaseTrackUseCase: GetReleaseTrackUseCase,
        private readonly cacheService: CacheService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Get('/name')
    @ApiOperation({
        summary: 'Get organization name',
        description: 'Return the name of the authenticated user organization.',
    })
    @ApiOkResponse({ type: ApiStringResponseDto })
    public getOrganizationName() {
        return this.getOrganizationNameUseCase.execute();
    }

    @Get('/release-track')
    @ApiOperation({
        summary: 'Get organization release track',
        description:
            'Returns the release track (stable | beta | internal) for the authenticated user organization.',
    })
    public getReleaseTrack() {
        return this.getReleaseTrackUseCase.execute();
    }

    @Patch('/update-infos')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Update organization info',
        description: 'Update organization details and phone information.',
    })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    public async updateInfoOrganizationAndPhone(
        @Body() body: UpdateInfoOrganizationAndPhoneDto,
    ) {
        return await this.updateInfoOrganizationAndPhoneUseCase.execute(body);
    }

    @Get('/domain')
    @ApiOperation({
        summary: 'Find organizations by domain',
        description: 'Return organizations that match a given email domain.',
    })
    @ApiQuery({ name: 'domain', type: String, required: true })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async getOrganizationsByDomain(
        @Query('domain')
        domain: string,
    ) {
        return await this.getOrganizationsByDomainUseCase.execute(domain);
    }

    @Get('/language')
    @ApiOperation({
        summary: 'Detect organization language',
        description: 'Infer primary language based on repository or team data.',
    })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiQuery({ name: 'repositoryId', type: String, required: false })
    @ApiQuery({ name: 'sampleSize', type: String, required: false })
    @ApiOkResponse({ type: OrganizationLanguageResponseDto })
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

        if (cached) {
            return cached;
        }

        const result = await this.getOrganizationLanguageUseCase.execute({
            teamId,
            repositoryId,
            sampleSize: sampleSize ? Number(sampleSize) : undefined,
        });

        await this.cacheService.addToCache(cacheKey, result, 900000);
        return result;
    }
}
