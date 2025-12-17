import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { BadRequestException, Injectable } from '@nestjs/common';

type CurrentUserParams = {
    organizationId: string;
    teamId?: string;
};

type NormalizedUser = {
    id: string;
    name?: string;
    username?: string;
    email?: string;
    avatarUrl?: string;
    raw?: any;
};

@Injectable()
export class GetCurrentCodeManagementUserUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(params: CurrentUserParams): Promise<{ user: NormalizedUser | null }> {
        const { organizationId, teamId } = params;

        if (!organizationId) {
            throw new BadRequestException('organizationId is required');
        }

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId,
        };

        try {
            const user = await this.codeManagementService.getCurrentUser({
                organizationAndTeamData,
            });

            if (!user) {
                return { user: null };
            }

            return { user: this.normalizeUser(user) };
        } catch (error) {
            this.logger.error({
                message: 'Failed to retrieve current code-management user',
                context: GetCurrentCodeManagementUserUseCase.name,
                error,
                metadata: { organizationId, teamId },
            });
            return { user: null };
        }
    }

    private normalizeUser(user: any): NormalizedUser {
        const id =
            user?.id ??
            user?.uuid ??
            user?.originId ??
            user?.descriptor ??
            user?.login ??
            user?.username ??
            user?.email;

        const avatarUrl =
            user?.avatarUrl ||
            user?.avatar_url ||
            user?.avatar ||
            user?.picture ||
            user?.image ||
            user?.links?.avatar?.href;

        return {
            id: id ? String(id) : '',
            name: user?.name || user?.displayName || user?.fullName,
            username: user?.username || user?.login,
            email: user?.email || user?.publicEmail,
            avatarUrl,
            raw: user,
        };
    }
}
