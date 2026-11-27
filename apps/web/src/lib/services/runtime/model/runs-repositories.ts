import type { RuntimeEnvironment } from "../contracts";
import { environmentStatus, type EnvironmentStatus } from "./environment";

/** A repository as the Runs screen offers it: with the state of its environment, when it has one. */
export interface RunsRepositoryOption {
    id: string;
    name: string;
    status?: EnvironmentStatus;
}

export interface RunsRepositories {
    /** Repositories with an environment: the ones a Run can boot. Most recently changed first. */
    withEnvironment: RunsRepositoryOption[];
    /** Connected repositories with no environment yet, by name. */
    others: RunsRepositoryOption[];
    /** Where the screen opens when it names no repository: the first with an environment, else the first at all. */
    preferred?: string;
}

/**
 * The Runs screen's repositories, split by whether they have an environment. Before, the list opened on the first
 * repository by name, usually one with no environment and so no Run, and the one with Runs sat somewhere below.
 */
export const runsRepositories = (
    repositories: ReadonlyArray<{ id: string; name: string }>,
    environments: ReadonlyArray<
        Pick<RuntimeEnvironment, "environmentId" | "repositoryId" | "state"> & {
            updatedAt?: string;
        }
    >,
): RunsRepositories => {
    const byRepository = new Map(environments.map((e) => [e.repositoryId, e]));
    const withEnvironment: Array<RunsRepositoryOption & { at: string }> = [];
    const others: RunsRepositoryOption[] = [];
    for (const r of repositories) {
        const env = byRepository.get(r.id);
        if (env) {
            withEnvironment.push({
                id: r.id,
                name: r.name,
                status: environmentStatus(
                    env as RuntimeEnvironment,
                    environments,
                ),
                at: env.updatedAt ?? "",
            });
        } else {
            others.push({ id: r.id, name: r.name });
        }
    }
    withEnvironment.sort(
        (a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name),
    );
    others.sort((a, b) => a.name.localeCompare(b.name));
    const options = withEnvironment.map(({ at: _at, ...o }) => o);
    return {
        withEnvironment: options,
        others,
        preferred: options[0]?.id ?? others[0]?.id,
    };
};
