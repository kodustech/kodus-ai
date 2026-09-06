/**
 * Suggestion subdocument ids are written as Mongo ObjectIds
 * (`newSubDocumentId`) and historically also as RFC-4122 UUIDs.
 * Fine-tuning ingest and issue-sync aggregations must accept both.
 */
export const SUGGESTION_ID_PATTERN =
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-' +
    '[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$|^[0-9a-fA-F]{24}$';

export const SUGGESTION_ID_REGEX = new RegExp(SUGGESTION_ID_PATTERN);

export function isSuggestionId(id: unknown): id is string {
    return typeof id === 'string' && SUGGESTION_ID_REGEX.test(id);
}
