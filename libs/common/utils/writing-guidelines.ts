import { convertTiptapJSONToText } from './tiptap-json';
import { getDefaultKodusConfigFile } from './validateCodeReviewConfigFile';

/**
 * Writing guidelines Kody shipped as defaults or presets. The settings page
 * pre-fills the default and saving any field on the page used to store it as
 * the team's own text, so teams hold frozen copies of these.
 */
const PREVIOUS_DEFAULTS: Array<{ name: string; text: string }> = [
    // default-kodus-config.yml, 2025-10 to 2026-02
    { name: 'default-2025', text: 'Detailed and verifiable issue description' },
    // default-kodus-config.yml, 2026-02 (5737722ed)
    {
        name: 'default-2026-02',
        text: `Detailed and verifiable issue description
- **No conversational filler**: Avoid phrases like "I noticed that," "It seems like," or "You should consider."
- **Execute "Brevity First"**: Eliminate all introductory pleasantries. Start descriptions with the noun of the error (e.g., "Memory leak," "Null pointer dereference," "Timing attack").
- **Direct addressing**: State the problem immediately, followed by the technical cause.
- **Strictly technical**: Use only domain-specific terminology. If a bug is a race condition, start with "Race condition identified in..."
- **Use Active Voice**: "The function leaks memory" instead of "Memory is leaked by the function."
- **Sentence cap**: Limit the description to 1-2 high-impact sentences.`,
    },
    // Onboarding "coach" preset, removed in 2c59658f4
    {
        name: 'preset-coach',
        text: 'Adopt a coaching tone: - Explain briefly the why behind each issue. - Suggest how to validate (tests/checks). - Prefer concise examples. - Avoid nitpicks and group by priority.',
    },
];

/** Letters and digits only: markup, bullets and spacing differ between the yml and the editor's JSON. */
const fingerprint = (text: string): string =>
    text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The plain text of a stored prompt value: a string, editor (Tiptap) JSON, or a `{ value }` form wrapper. */
export const promptText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'value' in (value as object)) {
        return promptText((value as { value?: unknown }).value);
    }
    return convertTiptapJSONToText(value as string | object).trim();
};

/** True when two prompt values carry the same words, whatever markup or serialisation each uses. */
export function samePromptText(a: unknown, b: unknown): boolean {
    return fingerprint(promptText(a)) === fingerprint(promptText(b));
}

let currentDefault: string | undefined;

/** The default shipped in default-kodus-config.yml, read once. */
export function currentDefaultWritingGuidelines(): string {
    if (currentDefault === undefined) {
        currentDefault = promptText(
            getDefaultKodusConfigFile()?.v2PromptOverrides?.generation?.main,
        );
    }
    return currentDefault;
}

/** Every text Kody has shipped as a default or preset, current default first. */
export function knownWritingGuidelines(): Array<{ name: string; text: string }> {
    return [
        { name: 'default-current', text: currentDefaultWritingGuidelines() },
        ...PREVIOUS_DEFAULTS,
    ];
}

/** Which shipped default or preset the value is, in any serialisation; null for anything else. */
export function matchKnownWritingGuidelines(value: unknown): string | null {
    const print = fingerprint(promptText(value));
    if (!print) return null;
    return (
        knownWritingGuidelines().find((known) => fingerprint(known.text) === print)
            ?.name ?? null
    );
}

/** True when the value is the current default, a previous default or a preset, in any serialisation. */
export function isDefaultWritingGuidelines(value: unknown): boolean {
    return matchKnownWritingGuidelines(value) !== null;
}

/**
 * The guidelines a review should use. A frozen copy of any default or preset
 * reads as the current default, so a change to the default reaches every team
 * that never wrote their own.
 */
export function resolveWritingGuidelines(value: unknown): {
    text: string;
    isCustom: boolean;
} {
    const text = promptText(value);
    if (!text || isDefaultWritingGuidelines(text)) {
        return { text: currentDefaultWritingGuidelines(), isCustom: false };
    }
    return { text, isCustom: true };
}
