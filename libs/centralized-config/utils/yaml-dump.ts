import * as yaml from 'js-yaml';

/**
 * `yaml.dump` for payloads that may have come off an HTTP request.
 *
 * js-yaml only dumps plain Objects — a class instance throws
 * "unacceptable kind of an object to dump" and surfaces as a 500. Nest's
 * `ValidationPipe` combined with `@Type(() => SomeDto)` produces exactly
 * that: nested DTO instances rather than plain objects.
 *
 * Everything written into a centralized-config pull request starts life as a
 * request body, so every dump on that path goes through here. The JSON round
 * trip is the cheap way to strip prototypes; it also drops `undefined`
 * values, which `yaml.dump` already skipped, so output is unchanged for
 * payloads that were plain to begin with.
 *
 * Not needed for values read back from the database — those are already
 * plain JSON — but harmless there, and one rule is easier to keep than a
 * per-call-site judgment about where a value came from.
 */
export function dumpCentralizedYaml(content: unknown): string {
    return yaml.dump(toPlainObject(content));
}

function toPlainObject(content: unknown): unknown {
    // Circular structures cannot reach here (request bodies are parsed from
    // JSON), but a throw from JSON.stringify would be far more confusing than
    // the YAMLException it replaces — so fall back to the original value and
    // let yaml.dump report the real problem.
    try {
        return JSON.parse(JSON.stringify(content));
    } catch {
        return content;
    }
}
