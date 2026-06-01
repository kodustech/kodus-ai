import { Inject, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { createLogger } from '@kodus/flow';

import {
    ITeamCliKeyRepository,
    TEAM_CLI_KEY_REPOSITORY_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.repository.contract';
import {
    ITeamCliKeyService,
    ValidateKeyResult,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import { TeamCliKeyEntity } from '@libs/organization/domain/team-cli-key/entities/team-cli-key.entity';
import {
    ITeamCliKey,
    ITeamCliKeyConfig,
    TEAM_CLI_KEY_CAPABILITIES,
    TeamCliKeyCapability,
} from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';

@Injectable()
export class TeamCliKeyService implements ITeamCliKeyService {
    private readonly logger = createLogger(TeamCliKeyService.name);

    constructor(
        @Inject(TEAM_CLI_KEY_REPOSITORY_TOKEN)
        private readonly teamCliKeyRepository: ITeamCliKeyRepository,
    ) {}

    async generateKey(
        teamId: string,
        name: string,
        createdByUserId: string,
        config?: ITeamCliKeyConfig,
    ): Promise<string> {
        // Generate random key
        const rawKey = crypto.randomBytes(32).toString('base64url');

        // Create a prefix for fast lookup (first 8 chars of SHA256 hash)
        const keyPrefix = crypto
            .createHash('sha256')
            .update(rawKey)
            .digest('hex')
            .substring(0, 8);

        // Hash the key before storing
        const keyHash = await bcrypt.hash(rawKey, 10);

        // Save to database
        await this.teamCliKeyRepository.create({
            name,
            keyHash,
            keyPrefix,
            active: true,
            config: this.normalizeConfig(config),
            team: { uuid: teamId },
            createdBy: { uuid: createdByUserId },
        });

        // Return the raw key with prefix (only time it's shown)
        return `kodus_${rawKey}`;
    }

    async validateKey(key: string): Promise<ValidateKeyResult | null> {
        try {
            // Remove prefix
            const rawKey = key.replace(/^kodus_/, '');

            // Calculate keyPrefix for fast lookup
            const keyPrefix = crypto
                .createHash('sha256')
                .update(rawKey)
                .digest('hex')
                .substring(0, 8);

            // Direct lookup by keyPrefix (O(1) instead of O(n))
            const keyRecord = await this.teamCliKeyRepository.findOne({
                keyPrefix,
                active: true,
            });

            // If no key found with this prefix, return early
            if (!keyRecord) {
                return null;
            }

            // Verify the key hash matches
            const match = await bcrypt.compare(rawKey, keyRecord.keyHash);

            if (!match) {
                return null;
            }

            // Update last used timestamp asynchronously (don't wait)
            this.teamCliKeyRepository
                .update({ uuid: keyRecord.uuid }, { lastUsedAt: new Date() })
                .catch((err) => {
                    this.logger.error({
                        message: 'Error updating lastUsedAt for CLI key',
                        error: err,
                        context: TeamCliKeyService.name,
                        metadata: { keyId: keyRecord.uuid },
                    });
                });

            if (!keyRecord.team || !keyRecord.team.organization) {
                return null;
            }

            return {
                keyId: keyRecord.uuid,
                keyName: keyRecord.name,
                team: keyRecord.team,
                organization: keyRecord.team.organization,
                config: this.normalizeConfig(keyRecord.config),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error validating CLI key',
                error,
                context: TeamCliKeyService.name,
            });
            return null;
        }
    }

    async revokeKey(keyId: string): Promise<void> {
        await this.teamCliKeyRepository.update(
            { uuid: keyId },
            { active: false },
        );
    }

    // Repository methods delegation
    find(filter?: Partial<ITeamCliKey>): Promise<TeamCliKeyEntity[]> {
        return this.teamCliKeyRepository.find(filter);
    }

    findOne(
        filter: Partial<ITeamCliKey>,
    ): Promise<TeamCliKeyEntity | undefined> {
        return this.teamCliKeyRepository.findOne(filter);
    }

    findById(uuid: string): Promise<TeamCliKeyEntity | undefined> {
        return this.teamCliKeyRepository.findById(uuid);
    }

    findByTeamId(teamId: string): Promise<TeamCliKeyEntity[]> {
        return this.teamCliKeyRepository.findByTeamId(teamId);
    }

    create(data: Partial<ITeamCliKey>): Promise<TeamCliKeyEntity | undefined> {
        return this.teamCliKeyRepository.create(data);
    }

    update(
        filter: Partial<ITeamCliKey>,
        data: Partial<ITeamCliKey>,
    ): Promise<TeamCliKeyEntity | undefined> {
        const normalizedData: Partial<ITeamCliKey> = {
            ...data,
        };

        if (data.config !== undefined) {
            normalizedData.config = this.normalizeConfig(data.config);
        }

        return this.teamCliKeyRepository.update(filter, normalizedData);
    }

    delete(uuid: string): Promise<void> {
        return this.teamCliKeyRepository.delete(uuid);
    }

    private normalizeConfig(config?: ITeamCliKeyConfig): ITeamCliKeyConfig {
        const legacyConfig = config as
            | (ITeamCliKeyConfig & {
                  permissions?: {
                      configureRepositories?: boolean;
                  };
              })
            | undefined;

        const capabilities = new Set<TeamCliKeyCapability>(
            config?.capabilities ?? [],
        );

        if (legacyConfig?.permissions?.configureRepositories) {
            capabilities.add(TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE);
        }

        return {
            capabilities: Array.from(capabilities),
        };
    }
}
