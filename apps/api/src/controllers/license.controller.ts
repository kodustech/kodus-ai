import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Inject,
    NotFoundException,
    Post,
    Query,
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
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import { SelfHostedLicenseService } from '@libs/ee/license/self-hosted-license.service';
import { ConnectionAccessService } from '@libs/identity/infrastructure/adapters/services/permissions/connection-access.service';
import { assertConnectionReadable } from '@libs/identity/infrastructure/adapters/services/permissions/connection-read';
import { PruneRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/prune-removed-license-seats.use-case';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TrialExtensionNotifierService } from '../services/trial-extension-notifier.service';

@ApiTags('License')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('license')
export class LicenseController {
    constructor(
        private readonly selfHostedLicenseService: SelfHostedLicenseService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly createOrUpdateOrganizationParametersUseCase: CreateOrUpdateOrganizationParametersUseCase,
        private readonly trialExtensionNotifierService: TrialExtensionNotifierService,
        private readonly pruneRemovedLicenseSeatsUseCase: PruneRemovedLicenseSeatsUseCase,
        private readonly telemetry: TelemetryService,
        private readonly connectionAccess: ConnectionAccessService,

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

        void this.telemetry.licenseActivated({
            organizationId,
            userId: this.request?.user?.uuid,
            planType: payload?.plan,
            expiresAt: payload
                ? new Date(payload.exp * 1000).toISOString()
                : undefined,
        });

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
        description:
            'Return all users who have ever been assigned a license seat (active and inactive).',
    })
    public async usersWithLicense(
        @Query('connectionId') connectionId?: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        const seatConnectionId = await this.seatConnection(
            organizationId,
            undefined,
            connectionId,
        );
        return this.licenseService.getAllUsersEverWithLicense({
            organizationId,
            ...(seatConnectionId ? { integrationId: seatConnectionId } : {}),
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
            connectionId?: string;
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

        const seatConnectionId = await this.seatConnection(
            organizationId,
            body.teamId,
            body.connectionId,
        );
        const orgData = {
            organizationId,
            teamId: body.teamId,
            ...(seatConnectionId ? { integrationId: seatConnectionId } : {}),
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
                void this.telemetry.licenseSeatChanged({
                    organizationId,
                    actorUserId: this.request?.user?.uuid,
                    targetGitId: user.gitId,
                    assigned: user.licenseStatus === 'active',
                    source: 'manual',
                });
            } else {
                failed.push(user);
            }
        }

        return { successful, failed };
    }

    @Get('/removable-seats')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Preview reclaimable license seats',
        description:
            'Lists the git ids holding a seat while no longer belonging to the git organization. Returns a "members_unavailable" status when the code platform could not be reached.',
    })
    public async removableSeats(
        @Query('teamId') teamId?: string,
        @Query('connectionId') connectionId?: string,
    ) {
        return this.pruneRemovedLicenseSeatsUseCase.execute({
            organizationAndTeamData: await this.resolveOrganizationAndTeamData(
                teamId,
                connectionId,
            ),
            dryRun: true,
        });
    }

    @Post('/prune-seats')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Reclaim license seats from users removed from the git org',
        description:
            'Releases the seats of users who no longer belong to the git organization. Never runs when the member list could not be confirmed.',
    })
    public async pruneSeats(
        @Body()
        body: {
            teamId?: string;
            connectionId?: string;
            gitIds?: string[];
        },
    ) {
        return this.pruneRemovedLicenseSeatsUseCase.execute({
            organizationAndTeamData: await this.resolveOrganizationAndTeamData(
                body?.teamId,
                body?.connectionId,
            ),
            gitIds: body?.gitIds,
        });
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

    private async resolveOrganizationAndTeamData(
        teamId?: string,
        connectionId?: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }

        const seatConnectionId = await this.seatConnection(
            organizationId,
            teamId,
            connectionId,
        );
        return {
            organizationId,
            teamId,
            ...(seatConnectionId ? { integrationId: seatConnectionId } : {}),
        };
    }

    /**
     * The connection a seat call is on. It may name only a connection of the
     * caller's workspace (or organization, when no workspace is given) that
     * the caller is granted. A member granted only some connections who
     * names none is on the one they are granted there, else refused: the
     * workspace's seats include the other connections'.
     */
    private async seatConnection(
        organizationId: string,
        teamId: string | undefined,
        requested: string | undefined,
    ): Promise<string | undefined> {
        const restriction = await this.connectionAccess.restrictionFor(
            this.request?.user,
        );
        const connectionId =
            requested ??
            (restriction
                ? await this.onlyGrantedConnection(restriction, teamId)
                : undefined);
        if (!connectionId) return undefined;
        assertConnectionReadable(restriction, connectionId);
        const known = teamId
            ? await this.connectionAccess.connectionInWorkspace(
                  organizationId,
                  teamId,
                  connectionId,
              )
            : await this.connectionAccess.connectionInOrganization(
                  organizationId,
                  connectionId,
              );
        if (!known) {
            throw new NotFoundException('Git connection not found.');
        }
        return connectionId;
    }

    private async onlyGrantedConnection(
        restriction: { connectionIds: ReadonlySet<string> },
        teamId: string | undefined,
    ): Promise<string> {
        const candidates = teamId
            ? (
                  await this.connectionAccess.workspaceConnectionIds(teamId)
              ).filter((id) => restriction.connectionIds.has(id))
            : [...restriction.connectionIds];
        if (candidates.length !== 1) {
            throw new ForbiddenException(
                'Name one of your Git connections (connectionId).',
            );
        }
        return candidates[0];
    }
}
