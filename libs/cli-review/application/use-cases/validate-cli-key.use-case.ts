import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    CLI_DEVICE_SERVICE_TOKEN,
    ICliDeviceService,
} from '@libs/organization/domain/cli-device/contracts/cli-device.service.contract';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { JWT } from '@libs/core/infrastructure/config/types/jwt/jwt';

export interface ValidateCliKeyInput {
    teamKey?: string;
    authHeader?: string;
    queryTeamId?: string;
    /** When provided, the use case also performs device tracking and
     *  embeds the resulting deviceToken into the response payload.
     *  Mirrors the GET/POST validate-key endpoint behavior. */
    deviceId?: string;
    deviceToken?: string;
    userAgent?: string;
}

/**
 * The validate-key response shape. Kept loose (`any`-shaped fields under
 * `data`) to stay byte-identical to the previous in-controller helper —
 * the CLI consumes this contract today and we don't want to risk a
 * surprise on the wire.
 */
export type ValidateCliKeyResult = {
    valid: boolean;
    teamId?: string | null;
    organizationId?: string | null;
    teamName?: string;
    organizationName?: string;
    team?: { id: string | null; name: string };
    organization?: { id: string | null; name: string };
    user?: { email: string; name: string };
    email?: string;
    userEmail?: string;
    error?: string;
    code?: string;
    details?: unknown;
    /** Echoed back to the CLI so it can persist the token between runs. */
    deviceToken?: string;
    data?: Record<string, unknown>;
};

/**
 * Validates a CLI request (team key OR JWT) and, when device headers
 * are provided, validates or registers the device. Replaces the
 * `validateKeyInternal` helper that used to live inside
 * CliReviewController — controller stays thin per the Kody rule.
 *
 * Returns a payload that is wire-compatible with the existing
 * /cli/validate-key endpoints; the controller only deals with HTTP
 * concerns (status code, response header).
 */
@Injectable()
export class ValidateCliKeyUseCase {
    private readonly jwtConfig: JWT;

    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(CLI_DEVICE_SERVICE_TOKEN)
        private readonly cliDeviceService: ICliDeviceService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {
        this.jwtConfig = this.configService.get<JWT>('jwtConfig') as JWT;
    }

    async execute(input: ValidateCliKeyInput): Promise<ValidateCliKeyResult> {
        const payload = await this.validateAuth(input);

        const { deviceId, deviceToken, userAgent } = input;
        const shouldTrackDevice =
            !!deviceId && payload.valid && !!payload.organizationId;
        if (!shouldTrackDevice) return payload;

        try {
            const deviceResult =
                await this.cliDeviceService.validateOrRegisterDevice({
                    deviceId: deviceId!,
                    deviceToken,
                    organizationId: payload.organizationId!,
                    userAgent,
                });
            if (deviceResult.deviceToken) {
                payload.deviceToken = deviceResult.deviceToken;
                if (payload.data) {
                    payload.data.deviceToken = deviceResult.deviceToken;
                }
            }
            return payload;
        } catch (error: any) {
            // Device tracking failures down-grade the response to
            // invalid + carry the error code/details so the CLI can
            // surface a clear "device rejected" message instead of a
            // generic 401.
            const response = error.getResponse?.();
            return {
                ...payload,
                valid: false,
                error: error.message,
                ...(response?.code ? { code: response.code } : {}),
                ...(response?.details ? { details: response.details } : {}),
            };
        }
    }

    private async validateAuth(
        input: ValidateCliKeyInput,
    ): Promise<ValidateCliKeyResult> {
        const { teamKey, authHeader, queryTeamId } = input;
        const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

        const buildPayload = (
            base: ValidateCliKeyResult,
        ): ValidateCliKeyResult => ({
            ...base,
            data: { ...base } as Record<string, unknown>,
        });

        const buildInvalidPayload = (error: string): ValidateCliKeyResult =>
            buildPayload({
                valid: false,
                error,
                team: { id: null, name: '' },
                organization: { id: null, name: '' },
                user: { email: '', name: '' },
            });

        // Route 1: Team CLI key (via X-Team-Key or Bearer with kodus_ prefix)
        if (teamKey || bearerToken?.startsWith('kodus_')) {
            const key = teamKey || bearerToken;
            if (!key) {
                return buildInvalidPayload(
                    'Team API key required. Provide via X-Team-Key or Authorization: Bearer header.',
                );
            }

            const teamData = await this.teamCliKeyService.validateKey(key);
            if (!teamData) {
                return buildInvalidPayload('Invalid or revoked team API key');
            }

            const { team, organization } = teamData;
            const safeTeam: any = team ?? {};
            const safeOrg: any = organization ?? {};
            const safeTeamName =
                typeof safeTeam.name === 'string' ? safeTeam.name : '';
            const safeOrgName =
                typeof safeOrg.name === 'string' ? safeOrg.name : '';

            const result: ValidateCliKeyResult = {
                valid: !!(safeTeam.uuid && safeOrg.uuid),
                teamId: safeTeam.uuid ?? null,
                organizationId: safeOrg.uuid ?? null,
                teamName: safeTeamName,
                organizationName: safeOrgName,
                team: { id: safeTeam.uuid ?? null, name: safeTeamName },
                organization: { id: safeOrg.uuid ?? null, name: safeOrgName },
                user: { email: '', name: '' },
                email: '',
                userEmail: '',
            };
            if (!result.valid) {
                result.error = 'Invalid or incomplete team API key';
            }
            return buildPayload(result);
        }

        // Route 2: JWT Bearer token
        if (bearerToken) {
            let jwtPayload: any;
            try {
                jwtPayload = this.jwtService.verify(bearerToken, {
                    secret: this.jwtConfig.secret,
                });
            } catch {
                return buildInvalidPayload('Invalid or expired JWT token');
            }

            const user = await this.authService.validateUser({
                email: jwtPayload.email,
            });
            if (
                !user ||
                user.role !== jwtPayload.role ||
                user.status !== jwtPayload.status ||
                user.status === STATUS.REMOVED
            ) {
                return buildInvalidPayload(
                    'User account is inactive or removed',
                );
            }

            // Resolve team: prefer queryTeamId lookup, fall back to first
            // team for the org (CLI compat: CLI sends orgId as teamId).
            let team = queryTeamId
                ? await this.teamService.findById(queryTeamId)
                : null;

            if (
                !team &&
                queryTeamId &&
                queryTeamId !== jwtPayload.organizationId
            ) {
                return buildInvalidPayload(
                    `Team not found for the provided teamId: ${queryTeamId}`,
                );
            }

            if (!team) {
                team = await this.teamService.findFirstCreatedTeam(
                    jwtPayload.organizationId,
                );
            }
            if (!team) {
                return buildInvalidPayload(
                    'No active team found for the authenticated user',
                );
            }
            if (team.organization?.uuid !== jwtPayload.organizationId) {
                return buildInvalidPayload(
                    'Team does not belong to the authenticated organization',
                );
            }

            const safeTeamName =
                typeof team.name === 'string' ? team.name : '';
            const safeOrgName =
                typeof team.organization?.name === 'string'
                    ? team.organization.name
                    : '';

            return buildPayload({
                valid: true,
                teamId: team.uuid,
                organizationId: jwtPayload.organizationId,
                teamName: safeTeamName,
                organizationName: safeOrgName,
                team: { id: team.uuid, name: safeTeamName },
                organization: {
                    id: jwtPayload.organizationId,
                    name: safeOrgName,
                },
                user: { email: jwtPayload.email ?? '', name: '' },
                email: jwtPayload.email ?? '',
                userEmail: jwtPayload.email ?? '',
            });
        }

        return buildInvalidPayload(
            'Authentication required. Provide a team API key via X-Team-Key header, or a JWT via Authorization: Bearer header.',
        );
    }
}
