export const SANDBOX_INVALIDATE_ROUTING_KEY = 'sandbox.invalidate';

export type SandboxInvalidateReason = 'pr_closed' | 'force_pushed';

export interface SandboxInvalidatePayload {
    prKey: string; // "{organizationId}:{repositoryId}:{prNumber}"
    reason: SandboxInvalidateReason;
}
