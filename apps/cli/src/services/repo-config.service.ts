import { api } from './api/index.js';
import { gitService } from './git.service.js';
import type { ConfigRepository } from '../types/config.js';
import { CommandError } from '../utils/command-errors.js';
import { resolveTeamKeyAccess } from '../utils/team-key-auth.js';

type RepoConfigResult =
    | {
          status: 'added';
          repositoryFullName: string;
      }
    | {
          status: 'already-added';
          repositoryFullName: string;
      };

type TeamKeyConfig = {
    teamKey: string;
};

type ListedRepository = {
    id: string;
    fullName: string;
};

class RepoConfigService {
    async addRepository(target: string): Promise<RepoConfigResult> {
        const config = await this.loadTeamKeyConfig();
        const repositoryRef = await this.resolveRepositoryReference(target);
        const availableRepositories = await api.config.getAvailableRepositories(
            config.teamKey,
        );
        const matchedRepository = this.findRepositoryMatch(
            repositoryRef,
            availableRepositories,
        );

        if (!matchedRepository) {
            throw new CommandError(
                'INVALID_INPUT',
                `Repository '${repositoryRef}' was not found in the repositories available to this team. Check the git remote and Kodus provider connection.`,
            );
        }

        const repositoryFullName = this.toRepositoryFullName(matchedRepository);

        if (matchedRepository.selected) {
            return {
                status: 'already-added',
                repositoryFullName,
            };
        }

        const response = await api.config.addRepositories(
            config.teamKey,
            [matchedRepository.id],
        );

        if (
            response.message === 'Repositories already added' ||
            response.alreadyAddedRepositoryIds?.includes(matchedRepository.id)
        ) {
            return {
                status: 'already-added',
                repositoryFullName,
            };
        }

        return {
            status: 'added',
            repositoryFullName,
        };
    }

    async listRepositories(): Promise<ListedRepository[]> {
        const config = await this.loadTeamKeyConfig();
        const repositories = await api.config.getSelectedRepositories(
            config.teamKey,
        );

        return repositories.map((repository) => ({
            id: repository.id,
            fullName: this.toRepositoryFullName(repository),
        }));
    }

    private async loadTeamKeyConfig(): Promise<TeamKeyConfig> {
        return resolveTeamKeyAccess(
            'Repository configuration requires team-key auth. Run: kodus auth team-key --key <your-key>.',
        );
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
            const fullName = this.toRepositoryFullName(repository).toLowerCase();
            return fullName === normalizedTarget;
        });
    }

    private toRepositoryFullName(repository: ConfigRepository): string {
        return (
            repository.full_name ||
            `${repository.organizationName}/${repository.name}`
        );
    }
}

export { RepoConfigService, type RepoConfigResult, type ListedRepository };
export const repoConfigService = new RepoConfigService();
