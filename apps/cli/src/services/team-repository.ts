import { CommandError } from '../utils/command-errors.js';
import { cockpitApi, type TeamRepository } from './api/cockpit.api.js';
import type { UserContext } from './user-context.service.js';

export function repositoryFullName(repository: TeamRepository): string {
    return (
        repository.full_name ||
        (repository.organizationName
            ? `${repository.organizationName}/${repository.name}`
            : repository.name)
    );
}

/**
 * Which of the team's repositories a reference names: its id, its
 * `owner/repo`, or a bare name that only one of them has. An `owner/repo`
 * that does not match is never guessed from its last segment: it can be
 * another owner's repository with the same name, and the commands that take
 * a repository write to it.
 */
export function matchTeamRepository(
    reference: string,
    repositories: TeamRepository[],
    teamName: string,
): TeamRepository {
    const wanted = reference.trim().toLowerCase();

    const byId = repositories.find(
        (repository) => repository.id.toLowerCase() === wanted,
    );
    if (byId) {
        return byId;
    }

    const byFullName = repositories.filter(
        (repository) => repositoryFullName(repository).toLowerCase() === wanted,
    );
    const matches =
        byFullName.length > 0 || wanted.includes('/')
            ? byFullName
            : repositories.filter(
                  (repository) => repository.name.toLowerCase() === wanted,
              );

    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        throw new CommandError(
            'INVALID_INPUT',
            `'${reference}' matches more than one repository (${matches.map((repository) => `${repositoryFullName(repository)} [${repository.id}]`).join(', ')}). Pass owner/repo or the repository id.`,
        );
    }
    throw new CommandError(
        'INVALID_INPUT',
        `Repository '${reference}' is not selected for team '${teamName}'. Selected: ${repositories.map(repositoryFullName).join(', ') || 'none'}.`,
    );
}

export async function resolveTeamRepository(
    context: UserContext,
    reference: string,
): Promise<TeamRepository> {
    const repositories = await cockpitApi.listSelectedRepositories(
        context.accessToken,
        context.teamId,
    );
    return matchTeamRepository(reference, repositories ?? [], context.teamName);
}
