import { nonSecretStoredSettings } from "./_modals/edit-key/credential-config";

/**
 * What a save is entitled to say about its credential's settings.
 *
 * The server REPLACES this object rather than merging it, so sending one is an
 * instruction and omitting it is the only way to say "keep what is stored".
 * Which of those is right depends on something the object itself cannot show:
 * whether the form ever SAW the stored settings.
 *
 * The screen seeds them when it can look the credential up at mount, which needs
 * a provider known up front — editing a model, or "?provider=". Opened with no
 * preset, the user picks the provider inside the form and nothing was seeded.
 *
 * Both halves of that have already gone wrong here, in opposite directions:
 *
 *   - sending the form's object unconditionally erased a credential's pin, base
 *     URL and region when the unseeded form had nothing to send but `{}` — an
 *     empty object is still an object, and the builder replaces on any object;
 *   - then staying silent whenever unseeded discarded settings the user had
 *     just typed and watched "Test" validate, which is the original defect this
 *     branch exists to fix, reintroduced one flow over.
 *
 * Neither is a matter of degree, so the rule is not a threshold:
 *
 *   SEEDED — the form is authoritative. It opened with the stored values, so an
 *   absent field means the user removed it, and unpinning has to work.
 *
 *   UNSEEDED — the form is additive. It never saw the stored values, so absence
 *   proves nothing: what the user typed is layered ON TOP of what is stored,
 *   and a field they never saw is carried through rather than deleted. With
 *   nothing typed there is nothing to say, and the write stays silent.
 */
export const credentialSettingsOverride = ({
    seeded,
    storedSettings,
    formSettings,
}: {
    /** The form opened with this credential's settings in its fields. */
    seeded: boolean;
    /** What the credential being written to actually holds. */
    storedSettings: Record<string, unknown> | undefined;
    /** What the form produced. */
    formSettings: Record<string, unknown>;
}): Record<string, unknown> | undefined => {
    if (seeded) return formSettings;

    if (Object.keys(formSettings).length === 0) return undefined;

    // Secrets are excluded on the way back: the browser holds only their mask,
    // and the server keeps its own ciphertext when they are absent.
    return { ...nonSecretStoredSettings(storedSettings), ...formSettings };
};
