/**
 * agent-harness — ConversationStore (L1 domain-agnostic primitive).
 *
 * Persists the running conversation of an agent, keyed by a caller-supplied
 * `threadId`. This is the CONTINUITY/RECORD seam — deliberately NOT the legacy
 * flow session engine: no snapshots, no optimistic-lock `version`, no replan
 * journal, no `state.phase`, no entity store. Just the messages plus light
 * tenancy metadata, so the record survives across turns and stays queryable
 * for support/BI.
 *
 * Generic on purpose: any agent (chat, business-rules, review) can persist by
 * threadId. The harness must not depend on any domain shape — `meta` is opaque
 * tenancy, never a review/PR type.
 */

/** One persisted turn. Mirrors `AgentRunInput.seedMessages` so a loaded
 *  history feeds straight back into a run as seed context. */
export interface ConversationMessage {
    readonly role: 'user' | 'assistant';
    readonly content: string;
}

/** Light tenancy/correlation metadata attached to a thread's record. Every
 *  field optional — the store persists whatever the caller knows. */
export interface ConversationAppendMeta {
    /** Logical tenant of the session (legacy flow used `kodus-agent-conversation`). */
    readonly tenantId?: string;
    readonly organizationId?: string;
    readonly teamId?: string;
    readonly repositoryId?: string;
    /** Origin channel of the conversation (e.g. 'pr', 'chat'). */
    readonly channel?: string;
    /** Correlation id of the current turn (appended to the thread's history). */
    readonly correlationId?: string;
}

/** Read/append persistence for a thread's conversation. Implementations are
 *  infra (Mongo, in-memory for tests); the harness only knows this seam. */
export interface ConversationStore {
    /** Prior turns for `threadId`, oldest first. Empty array if none. */
    load(threadId: string): Promise<readonly ConversationMessage[]>;

    /** Append `turns` to `threadId` (upsert by thread), refreshing activity
     *  timestamps and `meta`. Never throws on a persistence error in a way that
     *  should abort the agent — callers treat the record as best-effort. */
    append(
        threadId: string,
        turns: readonly ConversationMessage[],
        meta?: ConversationAppendMeta,
    ): Promise<void>;
}
