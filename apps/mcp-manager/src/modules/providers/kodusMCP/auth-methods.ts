import { MCPIntegrationAuthType } from '../../integrations/enums/integration.enum';

/**
 * A field the end user must supply when connecting with a non-OAuth (static
 * token) auth method — e.g. Jira's `email` + `apiToken` + `cloudId`. Rendered
 * by the web onboarding form and validated on submit.
 */
export interface ManagedAuthUserField {
    name: string;
    label?: string;
    required?: boolean;
    /** Mask in the UI and treat as a secret at rest. */
    secret?: boolean;
}

/**
 * One selectable authentication mechanism for a managed (kodusmcp) integration.
 * An integration may expose several (e.g. Jira: OAuth *or* API token); the end
 * user picks one per connection.
 */
export interface ManagedAuthMethod {
    /** Stable id used by onboarding to select this method. */
    id: string;
    label?: string;
    type: MCPIntegrationAuthType;
    /** Exactly one method per integration is the default (the first when unset). */
    default?: boolean;

    // OAuth2 (static client or dynamic client registration).
    oauthScopes?: string[];
    dynamicRegistration?: boolean;
    clientId?: string;
    clientSecret?: string;
    // For non-DCR providers (e.g. ClickUp): name the env vars that hold the
    // OAuth app's client id/secret, so secrets never live in committed config.
    clientIdEnv?: string;
    clientSecretEnv?: string;

    // Static-token methods (bearer_token / basic / api_key): the fields the
    // user supplies at onboarding. The actual secret is stored per-org, never
    // in the static config.
    userFields?: ManagedAuthUserField[];
    /** Header name for api_key methods (e.g. `X-Api-Key`). */
    apiKeyHeader?: string;
}

/**
 * The raw auth shape as it may appear in `managed-mcp-servers.json`: either the
 * legacy single `auth` block, or the new `authMethods` array.
 */
export interface RawManagedAuthEntry {
    auth?: { type: MCPIntegrationAuthType } & Record<string, unknown>;
    authMethods?: Array<{ type: MCPIntegrationAuthType } & Record<string, unknown>>;
}

/**
 * Normalize a managed-server entry's auth declaration into a uniform list of
 * {@link ManagedAuthMethod}, regardless of whether it used the legacy single
 * `auth` block or the new `authMethods` array. Guarantees a stable `id` on each
 * method and exactly one `default`.
 */
export function normalizeAuthMethods(
    entry: RawManagedAuthEntry,
): ManagedAuthMethod[] {
    if (entry.authMethods?.length) {
        const methods = entry.authMethods.map((raw) => {
            const { type, id, default: isDefault, ...rest } = raw as {
                type: MCPIntegrationAuthType;
                id?: string;
                default?: boolean;
            } & Record<string, unknown>;

            return {
                ...rest,
                id: id ?? type,
                type,
                ...(isDefault ? { default: true } : {}),
            } as ManagedAuthMethod;
        });

        if (!methods.some((m) => m.default)) {
            methods[0].default = true;
        }

        return methods;
    }

    const auth = entry.auth ?? { type: MCPIntegrationAuthType.NONE };
    const { type, ...rest } = auth;

    return [
        {
            ...rest,
            id: type,
            type,
            default: true,
        } as ManagedAuthMethod,
    ];
}

/**
 * Select a method by id, or the default method when no id is given. Returns
 * `undefined` if the requested id is not present.
 */
export function getAuthMethod(
    methods: ManagedAuthMethod[],
    id?: string,
): ManagedAuthMethod | undefined {
    if (id) {
        return methods.find((m) => m.id === id);
    }

    return methods.find((m) => m.default) ?? methods[0];
}

/**
 * Resolve a method's OAuth client credentials from the environment when it names
 * `clientIdEnv` / `clientSecretEnv` (non-DCR providers). Keeps real secrets out
 * of committed config. Methods without env refs pass through unchanged.
 */
export function resolveAuthMethodEnv(
    method: ManagedAuthMethod,
    env: NodeJS.ProcessEnv,
): ManagedAuthMethod {
    if (!method.clientIdEnv && !method.clientSecretEnv) {
        return method;
    }

    return {
        ...method,
        ...(method.clientIdEnv
            ? { clientId: env[method.clientIdEnv] ?? method.clientId }
            : {}),
        ...(method.clientSecretEnv
            ? { clientSecret: env[method.clientSecretEnv] ?? method.clientSecret }
            : {}),
    };
}

/**
 * A UI-safe projection of an auth method: only what the frontend needs to render
 * the picker and token form. Strips OAuth client secrets/ids/scopes — never
 * expose those.
 */
export interface PublicAuthMethod {
    id: string;
    label?: string;
    type: MCPIntegrationAuthType;
    default?: boolean;
    userFields?: ManagedAuthUserField[];
}

/**
 * Project methods to their UI-safe shape for the integration API response.
 */
export function toPublicAuthMethods(
    methods: ManagedAuthMethod[],
): PublicAuthMethod[] {
    return methods.map((method) => ({
        id: method.id,
        ...(method.label ? { label: method.label } : {}),
        type: method.type,
        ...(method.default ? { default: true } : {}),
        ...(method.userFields ? { userFields: method.userFields } : {}),
    }));
}

/**
 * Collapse the default method back into the legacy single-`auth` block shape
 * (`{ type, ...typeSpecificFields }`). The provider's server-side tool-listing /
 * OAuth-refresh paths still read this; deriving it here keeps `authMethods` the
 * single source of truth in config (no duplicated `auth` property).
 */
export function defaultAuthBlock(
    methods: ManagedAuthMethod[],
): { type: MCPIntegrationAuthType } & Record<string, unknown> {
    const method = getAuthMethod(methods) ?? methods[0];
    const {
        id: _id,
        label: _label,
        default: _default,
        userFields: _userFields,
        type,
        ...rest
    } = method;

    return { ...rest, type };
}
