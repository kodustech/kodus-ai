import { MCPIntegrationAuthType } from './enums/integration.enum';

/**
 * A per-org static-token credential for a managed (kodusmcp) integration when
 * the user chose a bring-your-own-token auth method instead of OAuth (e.g.
 * Linear/Fireflies bearer token, or Jira `email`+`apiToken`+`cloudId`).
 *
 * Stored encrypted in the `mcp_integration_oauth` table, keyed by
 * (organizationId, integrationId), discriminated from OAuth state by a `kind`
 * marker on the persisted payload.
 */
export interface ManagedTokenCredential {
    /** The selected auth method's id (matches a ManagedAuthMethod.id). */
    authMethodId: string;
    /** Concrete auth type: basic | bearer_token | api_key. */
    authType: MCPIntegrationAuthType;
    /** The secret the user supplied (token / api token / api key). */
    secret: string;
    /**
     * Non-secret extra fields the method requires — e.g. Jira `email` + `cloudId`,
     * or an `apiKeyHeader` name for api_key methods.
     */
    fields?: Record<string, string>;
}
