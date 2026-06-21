import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Post,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { CreateOrUpdateOrganizationParametersUseCase } from '@libs/organization/application/use-cases/organizationParameters/create-or-update.use-case';
import { SelfHostedLicenseService } from '@libs/ee/license/self-hosted-license.service';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TrialExtensionNotifierService } from '../services/trial-extension-notifier.service';

@ApiTags('License')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('license')
export class LicenseController {
    constructor(
        private readonly selfHostedLicenseService: SelfHostedLicenseService,
        private readonly createOrUpdateOrganizationParametersUseCase: CreateOrUpdateOrganizationParametersUseCase,
        private readonly trialExtensionNotifierService: TrialExtensionNotifierService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/activate')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Activate license key',
        description:
            'Save a self-hosted license key and return the validation result.',
    })
    public async activate(@Body() body: { licenseKey: string }) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        // Strip any whitespace that may have been introduced by copy-paste
        const sanitizedKey = body.licenseKey.replace(/\s+/g, '');

        // Persist the key
        await this.createOrUpdateOrganizationParametersUseCase.execute(
            OrganizationParametersKey.LICENSE_KEY,
            { key: sanitizedKey },
            { organizationId },
        );

        // Clear cache so the new key is picked up immediately
        this.selfHostedLicenseService.clearCache();

        // Validate and return the result
        const result =
            await this.selfHostedLicenseService.validateOrganizationLicense({
                organizationId,
            });

        // Decode payload for status details
        const payload =
            this.selfHostedLicenseService.decodePayload(sanitizedKey);

        return {
            ...result,
            ...(payload && {
                plan: payload.plan,
                seats: payload.seats,
                features: payload.features,
                customer: payload.customer,
                expiresAt: new Date(payload.exp * 1000).toISOString(),
            }),
        };
    }

    @Get('/status')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get license status',
        description:
            'Return the current license status without exposing the key.',
    })
    public async status() {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        const result =
            await this.selfHostedLicenseService.validateOrganizationLicense({
                organizationId,
            });

        if (!result.valid) {
            return {
                valid: false,
                subscriptionStatus: result.subscriptionStatus,
            };
        }

        return result;
    }

    @Get('/org-status')
    @UseGuards(PolicyGuard)
    @ApiOperation({
        summary: 'Get organization license status',
        description:
            'Public endpoint for all organization members to check license status.',
    })
    public async orgStatus() {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        const result =
            await this.selfHostedLicenseService.validateOrganizationLicense({
                organizationId,
            });

        if (!result.valid) {
            return {
                valid: false,
                subscriptionStatus: result.subscriptionStatus,
            };
        }

        return result;
    }

    @Get('/users')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get users with license',
        description: 'Return users that have been assigned a license seat.',
    })
    public async usersWithLicense() {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        return this.selfHostedLicenseService.getAllUsersWithLicense({
            organizationId,
        });
    }

    @Post('/assign')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Assign or unassign a license seat',
        description:
            'Toggle license assignment for a user. Uses local DB tracking for self-hosted.',
    })
    public async assignOrUnassign(
        @Body()
        body: {
            teamId?: string;
            users: Array<{
                gitId: string;
                gitTool: string;
                licenseStatus: 'active' | 'inactive';
            }>;
            editedBy?: { userId?: string; email?: string };
            userName?: string;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        const orgData = {
            organizationId,
            teamId: body.teamId,
        };

        const successful: any[] = [];
        const failed: any[] = [];

        for (const user of body.users) {
            let ok: boolean;
            if (user.licenseStatus === 'active') {
                ok = await this.selfHostedLicenseService.assignLicense(
                    orgData,
                    user.gitId,
                    user.gitTool,
                );
            } else {
                ok = await this.selfHostedLicenseService.unassignLicense(
                    orgData,
                    user.gitId,
                );
            }

            if (ok) {
                successful.push(user);
            } else {
                failed.push(user);
            }
        }

        return { successful, failed };
    }

    @Post('/trial-extension-request')
    @UseGuards(PolicyGuard)
    @ApiOperation({
        summary: 'Request more trial PR reviews',
        description:
            'Forwards a trial extension request (team size + message) to our team channel. Available to any authenticated org member.',
    })
    public async requestTrialExtension(
        @Body() body: { teamId?: string; teamSize?: number; message?: string },
    ) {
        const organization = this.request?.user?.organization;

        if (!organization?.uuid) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        return this.trialExtensionNotifierService.notify({
            organizationId: organization.uuid,
            organizationName: organization.name,
            teamId: body.teamId,
            requestedByEmail: this.request?.user?.email,
            teamSize: body.teamSize,
            message: body.message,
        });
    }
}
