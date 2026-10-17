import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * CLI secrets are write-only (#2172). A read replaces every stored
 * ciphertext with this placeholder, and a save that sends the placeholder
 * back keeps the stored value. A new value arrives as `value` and is
 * encrypted before anything is stored.
 */
export const CLI_SECRET_MASK = '••••';

/** A secret as the settings screen sends it on save. */
export type IncomingCliSecret = {
    env: string;
    ciphertext?: string;
    /** Plaintext typed by the user; encrypted on save, never stored. */
    value?: string;
};

type AgentLike = Pick<CustomAgentConfig, 'id'> & {
    tools?: {
        cli?: Array<{
            name: string;
            secrets?: IncomingCliSecret[];
        }>;
    };
};

const secretKey = (agentId: string, cliName: string, env: string) =>
    `${agentId}\u0000${cliName}\u0000${env}`;

/** Every stored ciphertext, keyed by agent id, CLI name and env name. */
const indexStoredSecrets = (stored: AgentLike[] | undefined) => {
    const index = new Map<string, string>();
    for (const agent of stored ?? []) {
        for (const cli of agent?.tools?.cli ?? []) {
            for (const secret of cli?.secrets ?? []) {
                if (
                    secret?.ciphertext &&
                    secret.ciphertext !== CLI_SECRET_MASK
                ) {
                    index.set(
                        secretKey(agent.id, cli.name, secret.env),
                        secret.ciphertext,
                    );
                }
            }
        }
    }
    return index;
};

/** Copy of the agents with every secret ciphertext masked. */
export function maskCustomAgentSecrets<T extends AgentLike>(
    agents: T[] | undefined,
): T[] | undefined {
    if (!Array.isArray(agents)) return agents;
    return agents.map((agent) => {
        const cli = agent?.tools?.cli;
        if (!Array.isArray(cli)) return agent;
        return {
            ...agent,
            tools: {
                ...agent.tools,
                cli: cli.map((tool) =>
                    Array.isArray(tool?.secrets)
                        ? {
                              ...tool,
                              secrets: tool.secrets.map((secret) => ({
                                  env: secret.env,
                                  ciphertext: CLI_SECRET_MASK,
                              })),
                          }
                        : tool,
                ),
            },
        };
    });
}

/**
 * Turns the secrets of agents on their way to storage into ciphertext:
 * a typed `value` is encrypted, the mask placeholder is swapped for the
 * stored ciphertext of the same agent, CLI and env name, and a mask with
 * nothing stored behind it is dropped (there is no value to keep).
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
                    const secrets: Array<{ env: string; ciphertext: string }> =
                        [];
                    for (const secret of tool.secrets) {
                        if (typeof secret?.value === 'string' && secret.value) {
                            secrets.push({
                                env: secret.env,
                                ciphertext: encrypt(secret.value),
                            });
                            continue;
                        }
                        if (secret?.ciphertext === CLI_SECRET_MASK) {
                            const kept = storedSecrets.get(
                                secretKey(agent.id, tool.name, secret.env),
                            );
                            if (kept) {
                                secrets.push({
                                    env: secret.env,
                                    ciphertext: kept,
                                });
                            }
                            continue;
                        }
                        if (secret?.ciphertext) {
                            secrets.push({
                                env: secret.env,
                                ciphertext: secret.ciphertext,
                            });
                        }
                    }
                    return { ...tool, secrets };
                }),
            },
        };
    });
}

// Loose on purpose: stored configs are DeepPartial, so the agents are read
// as whatever shape was stored.
type ConfigsLike = { customAgents?: unknown };

type ScopedConfigs = {
    configs?: ConfigsLike;
    directories?: Array<{ configs?: ConfigsLike }>;
};

type CodeReviewConfigValueLike = {
    configs?: ConfigsLike;
    repositories?: ScopedConfigs[];
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

/**
 * Copy of a stored code review config with every CLI secret masked, at
 * every level, so no read path hands ciphertext to a client.
 */
export function maskCodeReviewConfigSecrets<
    T extends CodeReviewConfigValueLike,
>(configValue: T): T {
    if (!configValue || typeof configValue !== 'object') return configValue;
    const maskConfigs = <C extends ConfigsLike | undefined>(configs: C): C =>
        configs && Array.isArray(configs.customAgents)
            ? {
                  ...configs,
                  customAgents: maskCustomAgentSecrets(
                      configs.customAgents as AgentLike[],
                  ),
              }
            : configs;

    return {
        ...configValue,
        configs: maskConfigs(configValue.configs),
        repositories: Array.isArray(configValue.repositories)
            ? configValue.repositories.map((repository) => ({
                  ...repository,
                  configs: maskConfigs(repository?.configs),
                  directories: Array.isArray(repository?.directories)
                      ? repository.directories.map((directory) => ({
                            ...directory,
                            configs: maskConfigs(directory?.configs),
                        }))
                      : repository?.directories,
              }))
            : configValue.repositories,
    };
}
