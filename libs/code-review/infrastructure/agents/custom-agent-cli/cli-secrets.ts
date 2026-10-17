/**
 * At-rest handling of custom agent CLI secrets (#2172).
 *
 * The config stores `{ env, ciphertext }`. A client never sees a ciphertext:
 * every response carries the mask instead, and sending the mask back keeps
 * what is stored. Anything else a client puts in `ciphertext` is a new value
 * and is encrypted before it is stored or logged.
 */

export const CLI_SECRET_MASK = '••••••••';

type SecretLike = { env: string; ciphertext: string };

function isSecretLike(value: unknown): value is SecretLike {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as SecretLike).env === 'string' &&
        'ciphertext' in (value as object)
    );
}

/**
 * `value` with every CLI secret's ciphertext replaced by the mask: a
 * JSON-equivalent copy (which is what a response serializes to) when there
 * is a secret to hide, the value itself otherwise.
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
            node.ciphertext = node.ciphertext ? CLI_SECRET_MASK : '';
            return;
        }
        Object.values(node).forEach(walk);
    };
    walk(copy);
    return copy;
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

type CliLike = { name?: string; secrets?: SecretLike[] };
type AgentLike = { id?: string; tools?: { cli?: CliLike[] } };

/** Visit every CLI secret under any `customAgents` array, at any depth
 *  (global config, repositories, directories, formatted wrappers). */
function forEachCliSecret(
    root: unknown,
    visit: (agentId: string, cliName: string, secret: SecretLike) => void,
): void {
    const seen = new Set<unknown>();
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        const agents = (node as { customAgents?: unknown }).customAgents;
        if (Array.isArray(agents)) {
            for (const agent of agents as AgentLike[]) {
                for (const cli of agent?.tools?.cli ?? []) {
                    for (const secret of cli?.secrets ?? []) {
                        if (isSecretLike(secret)) {
                            visit(agent.id ?? '', cli.name ?? '', secret);
                        }
                    }
                }
            }
        }
        Object.values(node).forEach(walk);
    };
    walk(root);
}

const slotKey = (agentId: string, cliName: string, env: string) =>
    `${agentId}\0${cliName}\0${env}`;

export class CliSecretMissingError extends Error {
    constructor(
        readonly env: string,
        readonly cliName: string,
    ) {
        super(
            `Secret ${env} of CLI "${cliName}" has no value: send the value to set it`,
        );
        this.name = 'CliSecretMissingError';
    }
}

/**
 * Encrypt, in place, every CLI secret `incoming` carries.
 * - the mask (or an empty value) keeps the ciphertext stored for the same
 *   agent, CLI and env name, and fails when there is none;
 * - a value that already is one of the org's stored ciphertexts is kept as
 *   is, so internal callers that re-save a stored config do not encrypt twice;
 * - anything else is a new plaintext value and is encrypted.
 */
export function sealCliSecrets(
    incoming: unknown,
    stored: unknown,
    encrypt: (plaintext: string) => string,
): void {
    const priorBySlot = new Map<string, string>();
    const storedCiphertexts = new Set<string>();
    forEachCliSecret(stored, (agentId, cliName, secret) => {
        if (!secret.ciphertext || secret.ciphertext === CLI_SECRET_MASK) {
            return;
        }
        priorBySlot.set(
            slotKey(agentId, cliName, secret.env),
            secret.ciphertext,
        );
        storedCiphertexts.add(secret.ciphertext);
    });

    forEachCliSecret(incoming, (agentId, cliName, secret) => {
        const value = secret.ciphertext;
        if (!value || value === CLI_SECRET_MASK) {
            const prior = priorBySlot.get(
                slotKey(agentId, cliName, secret.env),
            );
            if (!prior) throw new CliSecretMissingError(secret.env, cliName);
            secret.ciphertext = prior;
            return;
        }
        if (storedCiphertexts.has(value)) return;
        secret.ciphertext = encrypt(value);
    });
}
