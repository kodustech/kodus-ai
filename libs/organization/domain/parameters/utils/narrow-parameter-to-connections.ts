import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

type Restriction = {
    connectionIds: ReadonlySet<string>;
    allowsRepository(repository: { id?: unknown; name?: unknown }): boolean;
};

type StoredParameter = { configValue?: any } | null | undefined;

/**
 * A team parameter as a member granted only some Git connections may read
 * it: the review settings of their repositories and the centralized configs
 * of their connections. A copy; the stored (and cached) value is untouched.
 */
export const narrowParameterToConnections = <P extends StoredParameter>(
    key: ParametersKey,
    parameter: P,
    restriction: Restriction | null | undefined,
): P => {
    const value = parameter?.configValue;
    if (!restriction || !value) return parameter;

    if (
        key === ParametersKey.CODE_REVIEW_CONFIG &&
        Array.isArray(value.repositories)
    ) {
        return {
            ...parameter,
            configValue: {
                ...value,
                repositories: value.repositories.filter(
                    (repository: { id?: unknown; name?: unknown }) =>
                        restriction.allowsRepository({
                            id: repository?.id,
                        }),
                ),
            },
        };
    }

    if (
        key === ParametersKey.CENTRALIZED_CONFIG &&
        value.connections &&
        typeof value.connections === 'object'
    ) {
        return {
            ...parameter,
            configValue: {
                ...value,
                connections: Object.fromEntries(
                    Object.entries(value.connections).filter(([connectionId]) =>
                        restriction.connectionIds.has(connectionId),
                    ),
                ),
            },
        };
    }

    return parameter;
};
