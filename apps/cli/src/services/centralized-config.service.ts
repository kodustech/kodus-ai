import { select } from '@inquirer/prompts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api } from './api/index.js';
import { gitService } from './git.service.js';
import type {
    CentralizedConfigActionResponse,
    CentralizedConfigStatus,
    ConfigRepository,
} from '../types/config.js';
import { CommandError } from '../utils/command-errors.js';
import { resolveTeamKeyAccess } from '../utils/team-key-auth.js';

type InitOptions = {
    repository?: string;
    syncOption: 'pr' | 'manual';
};

class CentralizedConfigService {
    async getStatus(): Promise<CentralizedConfigStatus> {
        const teamKey = await this.requireTeamKey();
        return api.config.getCentralizedConfigStatus(teamKey);
    }

    async init(options: InitOptions): Promise<
        CentralizedConfigActionResponse & {
            repository: ConfigRepository;
        }
    > {
        const teamKey = await this.requireTeamKey();
        const repository = await this.resolveRepositoryForInit(
            teamKey,
            options.repository,
        );

        const response = await api.config.initCentralizedConfig(teamKey, {
            repositoryId: repository.id,
            syncOption: options.syncOption,
        });

        return {
            ...response,
            repository,
        };
    }

    async sync(): Promise<CentralizedConfigActionResponse> {
        const teamKey = await this.requireTeamKey();
        return api.config.syncCentralizedConfig(teamKey);
    }

    async disable(): Promise<CentralizedConfigActionResponse> {
        const teamKey = await this.requireTeamKey();
        return api.config.disableCentralizedConfig(teamKey);
    }

    async download(outPath: string): Promise<{
        outputPath: string;
        bytes: number;
    }> {
        if (!outPath?.trim()) {
            throw new CommandError(
                'INVALID_INPUT',
                'Output path is required. Use: --out <path>.',
            );
        }

        const teamKey = await this.requireTeamKey();
        const binary = await api.config.downloadCentralizedConfig(teamKey);

        const outputPath = path.resolve(outPath);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from(binary));

        return {
            outputPath,
            bytes: binary.byteLength,
        };
    }

    private async resolveRepositoryForInit(
        accessToken: string,
        repositoryRef?: string,
    ): Promise<ConfigRepository> {
        const selectedRepositories = (
            await api.config.getSelectedRepositories(accessToken)
        ).filter((repo) => repo.selected !== false);

        if (selectedRepositories.length === 0) {
            throw new CommandError(
                'INVALID_INPUT',
                'No selected repositories found in Kodus. Run `kodus config remote add <owner/repo>` first.',
            );
        }

        if (repositoryRef) {
            const normalized = repositoryRef.trim();
            const resolvedRef =
                normalized === '.'
                    ? await this.resolveCurrentRepositoryReference()
                    : normalized;

            const normalizedLower = resolvedRef.toLowerCase();
            const matched = selectedRepositories.find((repo) => {
                const fullName = this.toRepositoryFullName(repo).toLowerCase();
                return (
                    String(repo.id) === resolvedRef ||
                    repo.name.toLowerCase() === normalizedLower ||
                    fullName === normalizedLower
                );
            });

            if (!matched) {
                throw new CommandError(
                    'INVALID_INPUT',
                    `Repository '${resolvedRef}' is not selected in Kodus. Use kodus config remote list to check selected repositories.`,
                );
            }

            return matched;
        }

        if (!(process.stdin.isTTY && process.stdout.isTTY)) {
            throw new CommandError(
                'INVALID_INPUT',
                'Repository is required in non-interactive mode. Use: `kodus config centralized init <owner/repo> --sync-option <pr|manual>`.',
            );
        }

        const selectedRepositoryId = await select<string>({
            message: 'Select the centralized config repository:',
            choices: selectedRepositories
                .map((repo) => ({
                    name: this.toRepositoryFullName(repo),
                    value: repo.id,
                }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        });

        const selected = selectedRepositories.find(
            (repo) => repo.id === selectedRepositoryId,
        );

        if (!selected) {
            throw new CommandError(
                'INVALID_INPUT',
                'Invalid repository selection.',
            );
        }

        return selected;
    }

    private async resolveCurrentRepositoryReference(): Promise<string> {
        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            throw new CommandError(
                'NOT_IN_GIT_REPO',
                'Current directory is not a git repository. Run this command inside a repository or provide owner/repo explicitly.',
            );
        }

        const remoteUrl = await gitService.getRemoteUrl();
        if (!remoteUrl) {
            throw new CommandError(
                'INVALID_INPUT',
                "No git remote found for this repository. Configure 'origin' or provide owner/repo explicitly.",
            );
        }

        const orgRepo = await gitService.extractOrgRepo();
        if (!orgRepo) {
            throw new CommandError(
                'INVALID_INPUT',
                `Could not resolve repository from git remote '${remoteUrl}'. Provide owner/repo explicitly.`,
            );
        }

        return `${orgRepo.org}/${orgRepo.repo}`;
    }

    private toRepositoryFullName(repository: ConfigRepository): string {
        return (
            repository.full_name ||
            `${repository.organizationName}/${repository.name}`
        );
    }

    private async requireTeamKey(): Promise<string> {
        const { teamKey } = await resolveTeamKeyAccess(
            'Centralized config commands require team-key auth. Run: kodus auth team-key --key <your-key>.',
        );

        return teamKey;
    }
}

export const centralizedConfigService = new CentralizedConfigService();
