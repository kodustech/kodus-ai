/**
 * Deterministic thread-id generator — a flow-free port of the legacy flow engine's
 * `createThreadId`. Produces a stable `TR-[prefix-]hash` id (≤ 32 chars) from
 * 1–5 identifiers, so the same PR / user / issue always maps to the same thread
 * for log/trace correlation. The agents that consume the thread now run on the
 * harness (no flow engine), so the id only needs to be stable — this keeps
 * the exact format/behavior of the legacy helper.
 */

export type ThreadIdentifiers = Record<string, string | number | undefined>;

export interface GeneratedThread {
    id: string;
    metadata: Record<string, unknown>;
}

const simpleHash = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
};

const sortIdentifiers = (identifiers: ThreadIdentifiers): string =>
    Object.entries(identifiers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}-${value}`)
        .join('-');

const validatePrefix = (prefix?: string): string => {
    if (!prefix) {
        return '';
    }
    if (prefix.length > 3) {
        throw new Error(
            `Prefix "${prefix}" excede 3 caracteres. Máximo permitido: 3 caracteres.`,
        );
    }
    return prefix;
};

const validateIdentifiers = (identifiers: ThreadIdentifiers): void => {
    const count = Object.keys(identifiers).length;
    if (count === 0) {
        throw new Error('Pelo menos 1 identificador é obrigatório.');
    }
    if (count > 5) {
        throw new Error(
            `Máximo 5 identificadores permitidos. Fornecidos: ${count}`,
        );
    }
    for (const [key, value] of Object.entries(identifiers)) {
        if (value === null || value === undefined || value === '') {
            throw new Error(
                `Identificador "${key}" não pode ser vazio, null ou undefined.`,
            );
        }
    }
};

const generateThreadId = (
    identifiers: ThreadIdentifiers,
    prefix?: string,
): string => {
    validateIdentifiers(identifiers);
    const validPrefix = validatePrefix(prefix);
    const sortedString = sortIdentifiers(identifiers);
    const hash = simpleHash(sortedString);

    const baseThreadId = validPrefix ? `TR-${validPrefix}-${hash}` : `TR-${hash}`;
    if (baseThreadId.length <= 32) {
        return baseThreadId;
    }

    const prefixPart = validPrefix ? `TR-${validPrefix}-` : 'TR-';
    const availableSpace = 32 - prefixPart.length;
    if (availableSpace <= 0) {
        return validPrefix ? `TR-${validPrefix}` : 'TR';
    }
    return `${prefixPart}${hash.substring(0, availableSpace)}`;
};

/**
 * Create a deterministic thread from 1–5 identifiers.
 * Format: `TR-[prefix-]hash` (≤ 32 chars). Throws if validations fail (same as
 * the legacy helper: 1–5 non-empty identifiers, prefix ≤ 3 chars).
 */
export function createThreadId(
    identifiers: ThreadIdentifiers,
    options: { prefix?: string; description?: string; type?: string } = {},
): GeneratedThread {
    const { prefix, description, type = 'thread' } = options;
    const threadId = generateThreadId(identifiers, prefix);
    return {
        id: threadId,
        metadata: {
            description: description || `Thread ${threadId}`,
            type,
            ...identifiers,
        },
    };
}
