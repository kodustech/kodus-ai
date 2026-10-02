import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    ITeamCliKeyConfig,
    TEAM_CLI_KEY_CAPABILITIES,
} from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';

type ManageTeamCliKeysInput =
    | {
          action: 'generate';
          teamId: string;
          body: { name: string; config?: ITeamCliKeyConfig };
      }
    | { action: 'list'; teamId: string }
    | {
          action: 'update';
          teamId: string;
          keyId: string;
          body: { config?: ITeamCliKeyConfig };
      }
    | { action: 'revoke'; teamId: string; keyId: string };

@Injectable()
export class ManageTeamCliKeysUseCase {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly eventEmitter: EventEmitter2,
        private readonly telemetry: TelemetryService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    async execute(input: ManageTeamCliKeysInput) {
        await this.assertTeamInCallerOrganization(input.teamId);
        switch (input.action) {
            case 'generate':
                return this.generateKey(input.teamId, input.body);
            case 'list':
                return this.listKeys(input.teamId);
            case 'update':
                return this.updateKeyConfig(
                    input.teamId,
                    input.keyId,
                    input.body,
                );
            case 'revoke':
                return this.revokeKey(input.teamId, input.keyId);
        }
    }

    /**
     * `teamId` comes from the path and the policy only checks the caller's
     * role, so every route must confirm the team is in the caller's
     * organization. Without it an owner could mint a key for another
     * organization's team — and the key authenticates as that team's
     * organization — or list, edit and revoke its keys.
     */
    private async assertTeamInCallerOrganization(teamId: string) {
        const teamOrganizationId =
            await this.teamService.findOneOrganizationIdByTeamId(teamId);

        if (
            !teamOrganizationId ||
            teamOrganizationId !== this.request.user?.organization?.uuid
        ) {
            throw new HttpException('Team not found', HttpStatus.NOT_FOUND);
        }
    }

    /**
     * Generate a new CLI key for the team
     */
    private async generateKey(
        teamId: string,
        body: { name: string; config?: ITeamCliKeyConfig },
    ) {
        const userId = this.request.user?.uuid;

        if (!userId) {
            throw new HttpException(
                'User not found in request',
                HttpStatus.UNAUTHORIZED,
            );
        }

        if (!body.name || body.name.trim().length === 0) {
            throw new HttpException(
                'Key name is required',
                HttpStatus.BAD_REQUEST,
            );
        }

        const key = await this.teamCliKeyService.generateKey(
            teamId,
            body.name,
            userId,
            body.config,
        );

        this.eventEmitter.emit(AuditLogEvents.CLI_KEY, {
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
            userInfo: {
                userId: this.request.user?.uuid,
                userEmail: this.request.user?.email,
            },
            actionType: ActionType.CREATE,
            keyName: body.name,
        });

        void this.telemetry.cliKeyChanged({
            organizationId: this.request.user?.organization?.uuid,
            teamId,
            actorUserId: userId,
            created: true,
        });

        return {
            key,
            message: 'Save this key securely. It will not be shown again.',
        };
    }

    /**
     * List all CLI keys for the team
     */
    private async listKeys(teamId: string) {
        const keys = await this.teamCliKeyService.findByTeamId(teamId);

        // Don't return the actual key hash, only metadata
        return (keys ?? []).map((key) => ({
            uuid: key.uuid,
            name: key.name,
            active: key.active,
            config: this.formatConfig(key.config),
            lastUsedAt: key.lastUsedAt,
            createdAt: key.createdAt,
            createdBy: key.createdBy
                ? {
                      uuid: key.createdBy.uuid,
                  }
                : null,
        }));
    }

    private async updateKeyConfig(
        teamId: string,
        keyId: string,
        body: { config?: ITeamCliKeyConfig },
    ) {
        const key = await this.teamCliKeyService.findById(keyId);

        if (!key || key.team?.uuid !== teamId) {
            throw new HttpException('CLI key not found', HttpStatus.NOT_FOUND);
        }

        if (!body.config) {
            throw new HttpException(
                'CLI key config is required',
                HttpStatus.BAD_REQUEST,
            );
        }

        const updatedKey = await this.teamCliKeyService.update(
            { uuid: keyId },
            { config: body.config },
        );

        if (!updatedKey) {
            throw new HttpException(
                'CLI key could not be updated',
                HttpStatus.BAD_REQUEST,
            );
        }

        return {
            uuid: updatedKey.uuid,
            name: updatedKey.name,
            active: updatedKey.active,
            config: this.formatConfig(updatedKey.config),
            lastUsedAt: updatedKey.lastUsedAt,
            createdAt: updatedKey.createdAt,
            createdBy: updatedKey.createdBy
                ? {
                      uuid: updatedKey.createdBy.uuid,
                  }
                : null,
        };
    }

    /**
     * Revoke a CLI key
     */
    private async revokeKey(teamId: string, keyId: string) {
        // Verify key belongs to this team
        const key = await this.teamCliKeyService.findById(keyId);

        if (!key || key.team?.uuid !== teamId) {
            throw new HttpException('CLI key not found', HttpStatus.NOT_FOUND);
        }

        await this.teamCliKeyService.revokeKey(keyId);

        this.eventEmitter.emit(AuditLogEvents.CLI_KEY, {
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
            userInfo: {
                userId: this.request.user?.uuid,
                userEmail: this.request.user?.email,
            },
            actionType: ActionType.DELETE,
            keyName: key.name,
        });

        void this.telemetry.cliKeyChanged({
            organizationId: this.request.user?.organization?.uuid,
            teamId,
            actorUserId: this.request.user?.uuid,
            created: false,
        });

        return {
            message: 'CLI key revoked successfully',
        };
    }

    private formatConfig(config?: ITeamCliKeyConfig) {
        const legacyConfig = config as
            | (ITeamCliKeyConfig & {
                  permissions?: {
                      configureRepositories?: boolean;
                  };
              })
            | undefined;

        const capabilities = new Set(config?.capabilities ?? []);

        if (legacyConfig?.permissions?.configureRepositories) {
            capabilities.add(TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE);
        }

        return {
            capabilities: Array.from(capabilities),
        };
    }
}
