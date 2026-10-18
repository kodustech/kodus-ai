/**
 * The custom agents and knowledge are saved as whole lists, so a save made
 * from a copy someone else replaced since would drop their changes. The
 * server sends, beside each scope's settings, the revision of each list it
 * read; a save of a list sends back the revision the edit started from, and
 * the server refuses it (409) if the list changed since.
 */

/** The server refused the save; nothing was written. */
export class CodeReviewSettingsConflictError extends Error {
    constructor() {
        super("The settings changed since this page loaded them.");
        this.name = "CodeReviewSettingsConflictError";
    }
}

export const STALE_CUSTOM_AGENTS_MESSAGE =
    "Someone else changed these agents since you opened them. Reload the page to see their changes; your edits stay here until you leave, so copy what you need first.";

/** The toast text for a failed save that may have written the lists. */
export const customAgentsSaveErrorMessage = (
    error: unknown,
    fallback: string,
) =>
    error instanceof CodeReviewSettingsConflictError
        ? STALE_CUSTOM_AGENTS_MESSAGE
        : fallback;

export type ExpectedCustomAgentsRevisions = {
    customAgents?: string;
    knowledge?: string;
};

export const LIST_REVISION_KEY = {
    customAgents: "customAgentsRevision",
    knowledge: "knowledgeRevision",
} as const;
export type RevisionedListField = keyof typeof LIST_REVISION_KEY;
const LIST_FIELDS = Object.keys(LIST_REVISION_KEY) as RevisionedListField[];

type ListNode = { revision?: string } | undefined;
type FormValues = object | undefined;

/**
 * The revision of the list on screen: the one its draft started from once
 * edited (kept on the field, so a refetch that keeps the draft keeps it too),
 * else the one the server sent with the list.
 */
export const loadedListRevision = (
    values: FormValues,
    field: RevisionedListField,
): string | undefined => {
    const record = values as Record<string, unknown> | undefined;
    return (
        (record?.[field] as ListNode)?.revision ??
        (record?.[LIST_REVISION_KEY[field]] as string | undefined)
    );
};

/** The revisions to send for the lists a save writes; none if it writes none. */
export const expectedCustomAgentsRevisions = (
    values: FormValues,
    changedConfig: object,
): ExpectedCustomAgentsRevisions | undefined => {
    const written = LIST_FIELDS.filter((field) => field in changedConfig);
    if (written.length === 0) return undefined;
    return Object.fromEntries(
        written.map((field) => [field, loadedListRevision(values, field)]),
    );
};

/** Once saved, the lists are no longer a draft of an older revision. */
export const withoutListRevisions = <T extends object>(values: T): T => {
    const next = { ...values } as Record<string, unknown>;
    for (const field of LIST_FIELDS) {
        const node = next[field];
        if (node && typeof node === "object" && "revision" in node) {
            const { revision: _revision, ...rest } = node as Record<
                string,
                unknown
            >;
            next[field] = rest;
        }
    }
    return next as T;
};
