/**
 * Whether a save is entitled to speak for its credential's settings.
 *
 * The server REPLACES a credential's `settings` with whatever it receives, so
 * sending an object is an instruction, not a description. Silence — omitting the
 * key — is what means "keep what is stored".
 *
 * The Models screen only knows a credential's settings when it could look one up
 * at mount, which needs a provider known up front: editing a model, or an
 * "Add a model to <provider>" preset. Open it with no preset and the user picks
 * the provider inside the form, so the fields were never seeded from the stored
 * credential — the form genuinely has nothing to say about them.
 *
 * Sending the form's object anyway is how a fix for "settings never save" grew a
 * path that ERASES them: the collapsed object is empty, an empty object is still
 * an object, and the builder replaces on any object it is given. Adding a model
 * to an already-connected provider through the unlocked flow would have wiped
 * that credential's pin, base URL and region.
 *
 * This lives in its own module rather than inline in the page because the last
 * version of this decision was three words inside a component, which is exactly
 * why nobody — including its author — noticed it was wrong.
 */
export const credentialSettingsOverride = ({
    isEditing,
    lockedProvider,
    settings,
}: {
    /** Editing an existing model: the credential is known, the form was seeded. */
    isEditing: boolean;
    /** Provider fixed at mount (edit, or `?provider=`); undefined when the user
     *  picks it inside the form and nothing could be seeded. */
    lockedProvider: string | undefined;
    /** What the form built. Only meaningful when the form was seeded. */
    settings: Record<string, unknown>;
}): Record<string, unknown> | undefined =>
    isEditing || lockedProvider ? settings : undefined;
