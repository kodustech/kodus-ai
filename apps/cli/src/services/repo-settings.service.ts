import { api } from './api/index.js';
import { authService } from './auth.service.js';
import { gitService } from './git.service.js';
import type { ConfigRepository } from '../types/config.js';
import type { CentralizedPrMetadata } from '../types/config.js';
import type { RepositorySettings } from '../types/repo-config.js';
import { CommandError } from '../utils/command-errors.js';

export type RepositorySettingsResult = {
    repositoryId: string;
    repositoryFullName: string;
    settings: RepositorySettings;
};

export type RepositorySettingsCentralizedPrResult = {
    repositoryId: string;
    repositoryFullName: string;
    centralized: CentralizedPrMetadata & { mode: 'centralized-pr' };
};

export type RepositorySettingsMutationResult =
    | RepositorySettingsResult
    | RepositorySettingsCentralizedPrResult;

class RepositorySettingsService {
    async getRepositorySettings(
        target: string,
    ): Promise<RepositorySettingsResult> {
        const teamKey = await this.requireTeamKey();
        return this.getRepositorySettingsWithTeamKey(target, teamKey);
    }

    async updateRepositorySettings(
        target: string,
        settings: RepositorySettings,
    ): Promise<RepositorySettingsMutationResult> {
        const teamKey = await this.requireTeamKey();
        return this.updateRepositorySettingsWithTeamKey(
            target,
            teamKey,
            settings,
        );
    }

    private async resolveConfiguredRepository(
        target: string,
        accessToken: string,
    ): Promise<{
        matchedRepository: ConfigRepository;
    }> {
        const repositoryRef = await this.resolveRepositoryReference(target);
        const repositories =
            await api.config.getSelectedRepositories(accessToken);
        const matchedRepository = this.findRepositoryMatch(
            repositoryRef,
            repositories,
        );

        if (!matchedRepository) {
            throw new CommandError(
                'INVALID_INPUT',
                `Repository '${repositoryRef}' is not configured in Kodus yet. Run 'kodus config add -r ${target}' first.`,
            );
        }

        return {
            matchedRepository,
        };
    }

    private async requireTeamKey(): Promise<string> {
        const accessToken = await authService.getValidToken();

        if (accessToken.startsWith('kodus_')) {
            return accessToken;
        }

        throw new CommandError(
            'AUTH_REQUIRED',
            'Repository settings require team-key auth. Run: kodus auth team-key --key <your-key>.',
        );
    }

    private async getRepositorySettingsWithTeamKey(
        target: string,
        teamKey: string,
    ): Promise<RepositorySettingsResult> {
        const { matchedRepository } = await this.resolveConfiguredRepository(
            target,
            teamKey,
        );
        const settings = await api.config.getRepositorySettings(
            teamKey,
            matchedRepository.id,
        );

        return {
            repositoryId: matchedRepository.id,
            repositoryFullName: this.toRepositoryFullName(matchedRepository),
            settings,
        };
    }

    private async updateRepositorySettingsWithTeamKey(
        target: string,
        teamKey: string,
        settings: RepositorySettings,
    ): Promise<RepositorySettingsMutationResult> {
        const { matchedRepository } = await this.resolveConfiguredRepository(
            target,
            teamKey,
        );
        const updatedSettings = await api.config.updateRepositorySettings(
            teamKey,
            matchedRepository.id,
            settings,
        );

        if (this.isCentralizedPrMetadata(updatedSettings)) {
            return {
                repositoryId: matchedRepository.id,
                repositoryFullName:
                    this.toRepositoryFullName(matchedRepository),
                centralized: updatedSettings,
            };
        }

        return {
            repositoryId: matchedRepository.id,
            repositoryFullName: this.toRepositoryFullName(matchedRepository),
            settings: updatedSettings,
        };
    }

    private async resolveRepositoryReference(target: string): Promise<string> {
        if (target !== '.') {
            const normalized = target.trim().replace(/^\/+|\/+$/g, '');
            if (!normalized || !normalized.includes('/')) {
                throw new CommandError(
                    'INVALID_INPUT',
                    "Pass '.' for the current repository or use 'owner/repo'.",
                );
            }
            return normalized.toLowerCase();
        }

        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            throw new CommandError(
                'NOT_IN_GIT_REPO',
                'Current directory is not a git repository. Run this command inside a repository or pass owner/repo explicitly.',
            );
        }

        const remoteUrl = await gitService.getRemoteUrl();
        if (!remoteUrl) {
            throw new CommandError(
                'INVALID_INPUT',
                "No git remote found for this repository. Configure 'origin' or pass owner/repo explicitly.",
            );
        }

        const orgRepo = await gitService.extractOrgRepo();
        if (!orgRepo) {
            throw new CommandError(
                'INVALID_INPUT',
                `Could not resolve repository from git remote '${remoteUrl}'. Pass owner/repo explicitly.`,
            );
        }

        return `${orgRepo.org}/${orgRepo.repo}`.toLowerCase();
    }

    private findRepositoryMatch(
        repositoryRef: string,
        repositories: ConfigRepository[],
    ): ConfigRepository | undefined {
        const normalizedTarget = repositoryRef.toLowerCase();
        return repositories.find((repository) => {
            const fullName =
                this.toRepositoryFullName(repository).toLowerCase();
            return fullName === normalizedTarget;
        });
    }

    private toRepositoryFullName(repository: ConfigRepository): string {
        return (
            repository.full_name ||
            `${repository.organizationName}/${repository.name}`
        );
    }

    private isCentralizedPrMetadata(
        value:
            | RepositorySettings
            | (CentralizedPrMetadata & { mode: 'centralized-pr' }),
    ): value is CentralizedPrMetadata & { mode: 'centralized-pr' } {
        return (
            typeof value === 'object' &&
            value !== null &&
            'mode' in value &&
            (value as { mode?: string }).mode === 'centralized-pr'
        );
    }
}

export { RepositorySettingsService };
export const repositorySettingsService = new RepositorySettingsService();
