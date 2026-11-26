/**
 * A reproduction test with nothing to run: a body of a few characters
 * ("PLACEHOLDER", "REPLACE_ME", empty) or a command that is one placeholder
 * word. The model leaves these when it could not write the test; shipped,
 * they read as evidence.
 */
export function isPlaceholderTest(
    content: string | undefined,
    command?: string,
): boolean {
    const body = (content ?? '').replace(/\s+/g, '');
    const run = (command ?? '').trim();
    return (
        body.length < 40 ||
        (command !== undefined &&
            (run.length < 4 ||
                // A bare placeholder word: shouting case ("TODO", "RUN_ME")
                // or "placeholder" in any case. A real runner ("pytest",
                // "jest") is lowercase and passes.
                /^[A-Z_]+$/.test(run) ||
                /^placeholder$/i.test(run)))
    );
}
