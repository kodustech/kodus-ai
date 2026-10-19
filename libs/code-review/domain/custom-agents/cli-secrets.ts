import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * CLI secrets are write-only (#2172). The config stores `{ env, ciphertext }`
 * and a client never sees a ciphertext: every read carries this placeholder
 * instead, and a save that sends it back keeps the value stored for the same
 * agent, CLI and env name at the same config level. A new value arrives as
 * `value` (the settings screen) or as a plaintext `ciphertext` (API and YAML
 * clients) and is encrypted before anything is stored.
 */
export const CLI_SECRET_MASK = '••••';

/** A secret as a client sends it on save. */
export type IncomingCliSecret = {
    env: string;
    ciphertext?: string;
    /** Plaintext typed by the user; encrypted on save, never stored. */
    value?: string;
};

type CliLike = {
    name: string;
    install?: string;
    binary?: string;
    allowedDomains?: string[];
    secrets?: IncomingCliSecret[];
};

type AgentLike = Pick<CustomAgentConfig, 'id'> & {
    tools?: { cli?: CliLike[] };
};

function isSecretLike(value: unknown): value is IncomingCliSecret {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as IncomingCliSecret).env === 'string' &&
        ('ciphertext' in (value as object) || 'value' in (value as object))
    );
}

function containsCliSecret(root: unknown): boolean {
    const seen = new Set<unknown>();
    const walk = (node: unknown): boolean => {
        if (!node || typeof node !== 'object' || seen.has(node)) return false;
        seen.add(node);
        if (isSecretLike(node)) return true;
        return Object.values(node).some(walk);
    };
    return walk(root);
}

/**
 * `value` with every CLI secret replaced by `{ env, ciphertext: mask }`: a
 * JSON-equivalent copy (which is what a response serializes to) when there is
 * a secret to hide, the value itself otherwise. Works at any depth, so it
 * covers a parameter entity, a bare config value, a formatted config or a
 * YAML object alike.
 */
export function maskCliSecrets<T>(value: T): T {
    if (value === undefined || value === null) return value;
    if (!containsCliSecret(value)) return value;
    const copy = JSON.parse(JSON.stringify(value));
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (isSecretLike(node)) {
            const hasValue = !!(node.ciphertext || node.value);
            delete node.value;
            node.ciphertext = hasValue ? CLI_SECRET_MASK : '';
            return;
        }
        Object.values(node).forEach(walk);
    };
    walk(copy);
    return copy;
}

/** Copy of the agents with every secret masked. */
export function maskCustomAgentSecrets<T extends AgentLike>(
    agents: T[] | undefined,
): T[] | undefined {
    return maskCliSecrets(agents);
}

/** Copy of a stored code review config with every CLI secret masked. */
export function maskCodeReviewConfigSecrets<T>(configValue: T): T {
    return maskCliSecrets(configValue);
}

const secretKey = (agentId: string, cliName: string, env: string) =>
    `${agentId}\u0000${cliName}\u0000${env}`;

/**
 * What a stored secret is bound to: the package installed, the binary run and
 * the hosts it may reach. A kept secret only goes back to the same ones.
 */
const cliDestination = (cli: CliLike) =>
    JSON.stringify([
        cli.install ?? '',
        cli.binary ?? '',
        [...new Set(cli.allowedDomains ?? [])].sort(),
    ]);

type StoredSecret = { ciphertext: string; destination: string };

/** Every stored ciphertext, keyed by agent id, CLI name and env name. */
const indexStoredSecrets = (stored: AgentLike[] | undefined) => {
    const index = new Map<string, StoredSecret>();
    for (const agent of stored ?? []) {
        for (const cli of agent?.tools?.cli ?? []) {
            for (const secret of cli?.secrets ?? []) {
                if (
                    secret?.ciphertext &&
                    secret.ciphertext !== CLI_SECRET_MASK
                ) {
                    index.set(secretKey(agent.id, cli.name, secret.env), {
                        ciphertext: secret.ciphertext,
                        destination: cliDestination(cli),
                    });
                }
            }
        }
    }
    return index;
};

export class CliSecretMissingError extends Error {
    constructor(
        readonly env: string,
        readonly cliName: string,
        /** The CLI's install, binary or allowed domains changed since it was stored. */
        readonly cliChanged = false,
    ) {
        super(
            cliChanged
                ? `Secret ${env} of CLI "${cliName}" must be typed again: the CLI's install, binary or allowed domains changed`
                : `Secret ${env} of CLI "${cliName}" has no value at this level: send the value to set it`,
        );
        this.name = 'CliSecretMissingError';
    }
}

/**
 * Turns the secrets of agents on their way to storage into ciphertext.
 * `stored` must be the agents of the SAME config level being saved (see
 * `storedCustomAgentsAtLevel`), never the whole config: a secret set on one
 * repository or level must not be reachable from another one.
 * - a typed `value` is encrypted;
 * - the mask (or an empty ciphertext) keeps the ciphertext stored for the
 *   same agent, CLI and env name, and fails when there is none or when the
 *   CLI's install, binary or allowed domains changed: a new destination
 *   needs the value typed again;
 * - a ciphertext equal to the one stored in that same slot is kept;
 * - any other ciphertext is a plaintext from an API client and is encrypted,
 *   so a client can never plant a ciphertext of its choosing.
 */
export function sealCustomAgentSecrets<T extends AgentLike>(
    incoming: T[] | undefined,
    stored: AgentLike[] | undefined,
    encrypt: (plaintext: string) => string,
): T[] | undefined {
    if (!Array.isArray(incoming)) return incoming;
    const storedSecrets = indexStoredSecrets(stored);

    return incoming.map((agent) => {
        const cli = agent?.tools?.cli;
        if (!Array.isArray(cli)) return agent;
        return {
            ...agent,
            tools: {
                ...agent.tools,
                cli: cli.map((tool) => {
                    if (!Array.isArray(tool?.secrets)) return tool;
                    const secrets = tool.secrets.map((secret) => {
                        if (typeof secret?.value === 'string' && secret.value) {
                            return {
                                env: secret.env,
                                ciphertext: encrypt(secret.value),
                            };
                        }
                        const stored = storedSecrets.get(
                            secretKey(agent.id, tool.name, secret?.env),
                        );
                        const kept =
                            stored?.destination === cliDestination(tool)
                                ? stored.ciphertext
                                : undefined;
                        const sent = secret?.ciphertext;
                        if (!sent || sent === CLI_SECRET_MASK) {
                            if (!kept) {
                                throw new CliSecretMissingError(
                                    secret?.env,
                                    tool.name,
                                    !!stored,
                                );
                            }
                            return { env: secret.env, ciphertext: kept };
                        }
                        if (sent === kept) {
                            return { env: secret.env, ciphertext: kept };
                        }
                        return { env: secret.env, ciphertext: encrypt(sent) };
                    });
                    return { ...tool, secrets };
                }),
            },
        };
    });
}

// Loose on purpose: stored configs are DeepPartial, so the agents are read
// as whatever shape was stored.
type ConfigsLike = { customAgents?: unknown };

type DirectoryLike = {
    id?: string;
    folders?: Array<{ path?: string }>;
    configs?: ConfigsLike;
};

type RepositoryLike = {
    id?: string;
    configs?: ConfigsLike;
    directories?: DirectoryLike[];
};

type CodeReviewConfigValueLike = {
    configs?: ConfigsLike;
    repositories?: RepositoryLike[];
};

const agentsOf = (configs: ConfigsLike | undefined): AgentLike[] =>
    Array.isArray(configs?.customAgents)
        ? (configs.customAgents as AgentLike[])
        : [];

/** Every agent stored anywhere in a code review config (global, repos, dirs). */
export function collectStoredCustomAgents(
    configValue: CodeReviewConfigValueLike | undefined,
): AgentLike[] {
    const agents: AgentLike[] = [...agentsOf(configValue?.configs)];
    for (const repository of configValue?.repositories ?? []) {
        agents.push(...agentsOf(repository?.configs));
        for (const directory of repository?.directories ?? []) {
            agents.push(...agentsOf(directory?.configs));
        }
    }
    return agents;
}

export type CustomAgentConfigLevel = {
    repositoryId?: string;
    directoryId?: string;
    /** A directory group named by its folder paths (create-or-match save). */
    directoryPaths?: string[];
};

/**
 * The agents stored at exactly one config level: the global config when no
 * repository is named, the repository's own config, or one directory group's
 * config. Nothing is inherited from a parent level.
 */
export function storedCustomAgentsAtLevel(
    configValue: CodeReviewConfigValueLike | undefined,
    level: CustomAgentConfigLevel,
): AgentLike[] {
    const repositoryId =
        level.repositoryId && level.repositoryId !== 'global'
            ? level.repositoryId
            : undefined;
    if (!repositoryId) return agentsOf(configValue?.configs);

    const repository = configValue?.repositories?.find(
        (repo) => repo?.id === repositoryId,
    );
    if (!repository) return [];

    if (level.directoryId) {
        return agentsOf(
            repository.directories?.find((dir) => dir?.id === level.directoryId)
                ?.configs,
        );
    }

    const paths = level.directoryPaths?.filter(Boolean) ?? [];
    if (paths.length > 0) {
        const group = repository.directories?.find((dir) => {
            const folders = (dir?.folders ?? []).map((f) => f?.path);
            return (
                folders.length === paths.length &&
                paths.every((path) => folders.includes(path))
            );
        });
        return agentsOf(group?.configs);
    }

    return agentsOf(repository.configs);
}

/**
 * The stored agents that can lend a kept secret to a Try it run: those of the
 * level the caller edits, as a save there would use. At a directory, an agent
 * the directory does not define is edited at its repository, so that is where
 * its secret comes from. Never the global config: a global agent tried from a
 * repository needs its secrets typed again.
 */
export function storedCustomAgentsForTry(
    configValue: CodeReviewConfigValueLike | undefined,
    level: { repositoryId: string; directoryId?: string },
): AgentLike[] {
    const own = storedCustomAgentsAtLevel(configValue, level);
    if (!level.directoryId) return own;
    const ownIds = new Set(own.map((agent) => agent?.id));
    return [
        ...own,
        ...storedCustomAgentsAtLevel(configValue, {
            repositoryId: level.repositoryId,
        }).filter((agent) => !ownIds.has(agent?.id)),
    ];
}

/**
 * The agents a review at this level runs: the most specific level that
 * defines `customAgents` (directory, then repository, then global) wins,
 * as a list there replaces its parent's. Never another repository's agents.
 */
export function effectiveStoredCustomAgents(
    configValue: CodeReviewConfigValueLike | undefined,
    level: CustomAgentConfigLevel,
): AgentLike[] {
    const repositoryId =
        level.repositoryId && level.repositoryId !== 'global'
            ? level.repositoryId
            : undefined;
    const repository = repositoryId
        ? configValue?.repositories?.find((repo) => repo?.id === repositoryId)
        : undefined;
    const directory = level.directoryId
        ? repository?.directories?.find((dir) => dir?.id === level.directoryId)
        : undefined;

    for (const configs of [
        directory?.configs,
        repository?.configs,
        configValue?.configs,
    ]) {
        if (Array.isArray(configs?.customAgents)) return agentsOf(configs);
    }
    return [];
}
