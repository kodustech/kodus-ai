import { modelView, type RepoReader } from './repo-reader';

/**
 * The file a repository's owners write for the planner: what the environment's
 * recipe boots but the code does not show (the path prefix each service is
 * served under, the test login the seed creates, the data it seeds). Read at the
 * base commit, next to the recipe, so a PR cannot rewrite what it is tested with.
 */
export const ENVIRONMENT_NOTES_PATH = '.kodus/runtime-notes.md';

export const ENVIRONMENT_NOTES_LIMITS = {
    /** Bytes read from the file; the rest is not fetched. */
    readBytes: 16_384,
    /** Characters one prompt carries: the notes ride on every round, so they stay short. */
    promptChars: 3_000,
} as const;

/**
 * The notes as the planner's prompt carries them: secret-named values masked
 * and known secret patterns redacted (the same view a file read gets), cut at
 * promptChars. Undefined when the file is absent, empty or unreadable: a
 * Git failure never stops a plan, it plans without the notes.
 */
export async function readEnvironmentNotes(base: RepoReader): Promise<string | undefined> {
    let text: string | null;
    try {
        text = await base.read(ENVIRONMENT_NOTES_PATH, ENVIRONMENT_NOTES_LIMITS.readBytes);
    } catch {
        return undefined;
    }
    if (!text?.trim()) return undefined;
    const view = modelView(ENVIRONMENT_NOTES_PATH, text.trim(), ENVIRONMENT_NOTES_LIMITS.readBytes);
    return view.length > ENVIRONMENT_NOTES_LIMITS.promptChars ? `${view.slice(0, ENVIRONMENT_NOTES_LIMITS.promptChars)}\n[cut at ${ENVIRONMENT_NOTES_LIMITS.promptChars} characters]` : view;
}
