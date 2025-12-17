import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { BadRequestException, Injectable } from '@nestjs/common';

type SearchParams = {
    organizationId: string;
    teamId?: string;
    query?: string; // username, name or email fragment
    userId?: string; // provider user id
    limit?: number;
};

type NormalizedUser = {
    id: string;
    name?: string;
    username?: string;
    email?: string;
    avatarUrl?: string;
    source: 'id' | 'username' | 'emailOrName' | 'member';
};

@Injectable()
export class SearchCodeManagementUsersUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(params: SearchParams): Promise<{ users: NormalizedUser[] }> {
        const { organizationId, teamId, query, userId } = params;

        if (!organizationId) {
            throw new BadRequestException('organizationId is required');
        }

        const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId,
        };

        const results: NormalizedUser[] = [];
        const seen = new Set<string>();

        const addUser = (user: any, source: NormalizedUser['source']) => {
            const normalized = this.normalizeUser(user, source);
            if (!normalized) return;

            if (seen.has(normalized.id)) return;
            seen.add(normalized.id);
            results.push(normalized);
        };

        if (userId) {
            try {
                const byId = await this.codeManagementService.getUserById({
                    userId,
                    organizationAndTeamData,
                });
                addUser(byId, 'id');
            } catch (error) {
                this.logger.warn({
                    message: 'Failed to fetch user by id from code management',
                    context: SearchCodeManagementUsersUseCase.name,
                    metadata: { organizationId, teamId, userId },
                    error,
                });
            }
        }

        if (query) {
            try {
                const byUsername =
                    await this.codeManagementService.getUserByUsername({
                        organizationAndTeamData,
                        username: query,
                    });
                addUser(byUsername, 'username');
            } catch (error) {
                this.logger.warn({
                    message:
                        'Failed to fetch user by username from code management',
                    context: SearchCodeManagementUsersUseCase.name,
                    metadata: { organizationId, teamId, query },
                    error,
                });
            }

            try {
                const byEmailOrName =
                    await this.codeManagementService.getUserByEmailOrName({
                        organizationAndTeamData,
                        email: query.includes('@') ? query : '',
                        userName: query,
                    });
                addUser(byEmailOrName, 'emailOrName');
            } catch (error) {
                this.logger.warn({
                    message:
                        'Failed to fetch user by email or name from code management',
                    context: SearchCodeManagementUsersUseCase.name,
                    metadata: { organizationId, teamId, query },
                    error,
                });
            }
        }

        if (results.length < limit) {
            try {
                const members =
                    await this.codeManagementService.getListMembers({
                        organizationAndTeamData,
                        determineBots: true,
                    });

                for (const member of members ?? []) {
                    const matchesId =
                        !!userId &&
                        String(member?.id ?? member?.uuid ?? '') ===
                            String(userId);

                    const matchesQuery = query
                        ? this.matchesQuery(member, query)
                        : false;

                    if (userId || query) {
                        if (!matchesId && !matchesQuery) {
                            continue;
                        }
                    }

                    addUser(member, 'member');

                    if (results.length >= limit) break;
                }
            } catch (error) {
                this.logger.warn({
                    message: 'Failed to fetch members for user search fallback',
                    context: SearchCodeManagementUsersUseCase.name,
                    metadata: { organizationId, teamId, query, userId },
                    error,
                });
            }
        }

        return { users: results.slice(0, limit) };
    }

    private normalizeUser(
        user: any,
        source: NormalizedUser['source'],
    ): NormalizedUser | null {
        if (!user) return null;

        const id =
            user?.id ??
            user?.uuid ??
            user?.originId ??
            user?.descriptor ??
            user?.login ??
            user?.username ??
            user?.email;

        if (!id) return null;

        const avatarUrl =
            user?.avatarUrl ||
            user?.avatar_url ||
            user?.avatar ||
            user?.picture ||
            user?.image;

        return {
            id: String(id),
            name: user?.name || user?.displayName || user?.fullName,
            username: user?.username || user?.login,
            email: user?.email || user?.publicEmail,
            avatarUrl,
            source,
        };
    }

    private matchesQuery(member: any, query: string): boolean {
        const normalizedQuery = query.toLowerCase();
        const fields = [
            member?.name,
            member?.displayName,
            member?.login,
            member?.username,
            member?.email,
            member?.publicEmail,
            member?.fullName,
        ]
            .filter(Boolean)
            .map((v: string) => v.toLowerCase());

        return fields.some((value) => value.includes(normalizedQuery));
    }
}
