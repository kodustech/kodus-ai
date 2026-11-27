import type { ProductEnvironment, ProductEnvironmentStore, RuntimeSettingsStore } from '../domain/ports';
import type { RuntimeEnvironmentMembers } from './environment-members.service';

export interface EnvironmentProvisioningDeps {
    environments: Pick<ProductEnvironmentStore, 'findByRepository' | 'create'>;
    /** Absent (older tests): no membership row is written. */
    members?: Pick<RuntimeEnvironmentMembers, 'ensurePrimary'>;
    /** Absent (older tests): the repository's Runtime mode is left alone. */
    settings?: Pick<RuntimeSettingsStore, 'listRepositories' | 'upsertRepository'>;
}

export interface EnvironmentProvisioningInput {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
}

/**
 * The environment of a connected repository, made when there is none (idempotent): the row, its primary membership,
 * and the repository turned On request when it has no Runtime settings of its own. It asks for no setup: Set up asks
 * for Kody's, a recipe sent from the developer's coding agent asks for one that boots it.
 */
export async function ensureEnvironment(
    deps: EnvironmentProvisioningDeps,
    input: EnvironmentProvisioningInput,
): Promise<{ env: ProductEnvironment; created: boolean }> {
    const existing = await deps.environments.findByRepository(input.organizationId, input.repositoryId);
    if (existing) {
        // An environment whose primary row is missing gets it here.
        await deps.members?.ensurePrimary(existing);
        return { env: existing, created: false };
    }
    const env = await deps.environments.create(input);
    // The environment's own repository is its primary, in membership as everywhere else.
    await deps.members?.ensurePrimary(env);
    await turnOnIfUnset(deps, input.organizationId, input.repositoryId);
    return { env, created: true };
}

/**
 * Setting an environment up is the opt-in: a repository with no Runtime settings of its own starts On request (it runs
 * only when someone asks), so the first `@kody runtime` after a ready setup runs instead of answering "off". A
 * repository someone turned off keeps its row and stays off.
 */
async function turnOnIfUnset(deps: EnvironmentProvisioningDeps, organizationId: string, repositoryId: string): Promise<void> {
    if (!deps.settings) return;
    const rows = await deps.settings.listRepositories(organizationId);
    if (rows.some((r) => r.repositoryId === repositoryId)) return;
    // 'writers': DEFAULT_WHO_CAN_ASK (settings.use-cases.ts imports the use cases, so it is not imported here).
    await deps.settings.upsertRepository(organizationId, { repositoryId, pilot: true, whoCanAsk: 'writers', mode: 'on_request' });
}
