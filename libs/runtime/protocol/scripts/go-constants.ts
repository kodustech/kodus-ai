// The protocol constants the Go cell compiles in, rendered as
// apps/runtime-cell/internal/protocol/constants_gen.go. Each value is read
// from the TypeScript export that owns it, so the cell never keeps a hand
// copy that can drift (the zod schemas reach Go through the JSON Schema dump;
// these are the rules and bounds that dump does not carry). Logic the cell
// mirrors (needs resolution, strict JSON) stays covered by the shared fixtures
// in protocol/fixtures.
import { AUTHORED_FILE_PATH_PATTERN, AUTHORED_FILES_LIMITS } from '@libs/runtime/contracts/authored-files';
import { RECIPE_FILE_PATHS, SECURITY_VIOLATION_SIGNATURE } from '@libs/runtime/contracts/enums';
import { MACHINE_SIZE_LIMITS } from '@libs/runtime/contracts/machine-size';
import { PREVIEW_ID_PATTERN, PREVIEW_LIMITS, PREVIEW_STREAM_HEADERS, PREVIEW_TUNNEL_AUTH_SCHEME } from '@libs/runtime/contracts/preview';
import { TRACEPARENT_SHAPE } from '@libs/runtime/contracts/trace-context';
import {
    FALLBACK_REPOSITORY_ALIAS,
    MAX_RECIPE_NEEDS,
    MAX_REPOSITORY_FULL_NAME,
    REPOSITORY_ALIAS_PATTERN,
    REPOSITORY_FULL_NAME_PATTERN,
} from '@libs/runtime/contracts/workspace';
import { RUNTIME_SECRET_NAME_PATTERN, RUNTIME_SECRET_RESERVED_NAMES, RUNTIME_SECRET_RESERVED_PREFIXES } from '@libs/runtime/api/domain/secrets';
import { testValueFor } from '@libs/runtime/blockers/catalog';
import { PROBE_LOG_TAIL_TEXT_MAX } from '@libs/runtime/probe/probe.schema';
import { TELEMETRY_SECRET_SHAPES } from '@libs/runtime/telemetry/telemetry-guard';

import {
    BLOCKED_MESSAGE_MAX,
    CELL_FEATURES,
    CLAIM_FAILED_REASON_MAX,
    HUB_ACCEPTED_FEATURES,
    LOG_LINE_MAX,
    MAX_CELL_MEMORY_MB,
    MAX_CLAIM_SECRETS,
    STEP_EXEC_OUTPUT_MAX,
    STEP_STREAM_CHUNK_MAX,
} from '../messages';
import { MAX_HEALTH_TIMEOUT_SECONDS } from '../recipe';
import {
    SANDBOX_ENVIRONMENT_ID,
    SANDBOX_EXEC_MAX_ENV,
    SANDBOX_EXEC_STDERR_BYTES,
    SANDBOX_EXEC_STDOUT_BYTES,
    SANDBOX_FILE_CHUNK_BYTES,
    SANDBOX_LIST_MAX_DEPTH,
    SANDBOX_LIST_MAX_ENTRIES,
    SANDBOX_PATH_MAX,
} from '../sandbox';
import { RESERVED_JSON_KEYS } from '../strict-json';

/** One Go declaration: a const (number or string), a pattern (a string const for regexp.MustCompile) or a []string. */
export type GoConstant =
    | { go: string; from: string; doc: string; value: number | string }
    | { go: string; from: string; doc: string; pattern: RegExp | string }
    | { go: string; from: string; doc: string; strings: readonly string[] };

/** The Go name of a hello feature: Feature + its name, Go initialisms upper case (dbEffects: FeatureDBEffects). */
export function featureGoName(feature: string): string {
    const initialisms = new Set(['db', 'sql', 'id', 'url', 'json', 'http', 'cpu', 'mb']);
    const words = feature.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? [];
    return 'Feature' + words.map((w) => (initialisms.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join('');
}

/**
 * A JavaScript pattern as Go's regexp (RE2) reads it. Only the flags both
 * engines share are carried (i as (?i); g is how JS iterates, not what
 * matches). A lookaround compiles in JS only, so it is refused here. The
 * `\/` a JS literal or RegExp.source needs is written as `/`, the same match.
 */
export function goPattern(re: RegExp | string): string {
    const source = typeof re === 'string' ? re : re.source;
    const flags = typeof re === 'string' ? '' : re.flags.replace('g', '');
    if (/\(\?<?[=!]/.test(source)) throw new Error(`pattern ${source} uses a lookaround, which RE2 does not have`);
    if (flags && flags !== 'i') throw new Error(`pattern ${source} has flags ${flags} that Go does not share`);
    return (flags === 'i' ? '(?i)' : '') + source.replace(/\\(.)/g, (escape, c: string) => (c === '/' ? '/' : escape));
}

const MESSAGES = 'libs/runtime/protocol/messages.ts';
const SANDBOX = 'libs/runtime/protocol/sandbox.ts';
const WORKSPACE = 'libs/runtime/contracts/workspace.ts';
const SECRETS = 'libs/runtime/api/domain/secrets.ts';

/** Everything constants_gen.go declares besides the hello features, in file order. */
export function goConstants(): GoConstant[] {
    return [
        { go: 'SecurityViolationSignaturePattern', from: 'SECURITY_VIOLATION_SIGNATURE (libs/runtime/contracts/enums.ts)', doc: 'the signature of a security_violation blocker', pattern: SECURITY_VIOLATION_SIGNATURE },
        { go: 'TraceparentShapePattern', from: 'TRACEPARENT_SHAPE (libs/runtime/contracts/trace-context.ts)', doc: 'a W3C traceparent of version 00, without the all-zero rule', pattern: TRACEPARENT_SHAPE },
        { go: 'PreviewIDPattern', from: 'PREVIEW_ID_PATTERN (libs/runtime/contracts/preview.ts)', doc: 'a preview id', pattern: PREVIEW_ID_PATTERN },
        { go: 'PreviewTunnelAuthScheme', from: 'PREVIEW_TUNNEL_AUTH_SCHEME (libs/runtime/contracts/preview.ts)', doc: 'the Authorization scheme the preview tunnel ticket rides in', value: PREVIEW_TUNNEL_AUTH_SCHEME },
        { go: 'PreviewStreamHeaderPreviewID', from: 'PREVIEW_STREAM_HEADERS.previewId (libs/runtime/contracts/preview.ts)', doc: 'the header the edge names a preview stream in', value: PREVIEW_STREAM_HEADERS.previewId },
        { go: 'PreviewStreamHeaderSession', from: 'PREVIEW_STREAM_HEADERS.session (libs/runtime/contracts/preview.ts)', doc: "the header the edge names the viewer's session in", value: PREVIEW_STREAM_HEADERS.session },
        { go: 'PreviewMaxStreams', from: 'PREVIEW_LIMITS.concurrentStreams (libs/runtime/contracts/preview.ts)', doc: 'the most concurrent streams of one preview', value: PREVIEW_LIMITS.concurrentStreams },
        { go: 'PreviewMaxRequestBodyBytes', from: 'PREVIEW_LIMITS.requestBodyBytes (libs/runtime/contracts/preview.ts)', doc: 'the largest request body of one preview stream', value: PREVIEW_LIMITS.requestBodyBytes },
        { go: 'PreviewRequestTimeoutMs', from: 'PREVIEW_LIMITS.requestTimeoutMs (libs/runtime/contracts/preview.ts)', doc: 'how long one preview request may take, in ms', value: PREVIEW_LIMITS.requestTimeoutMs },
        { go: 'MaxStepExecOutput', from: `STEP_EXEC_OUTPUT_MAX (${MESSAGES})`, doc: 'the longest stdout or stderr a step.result exec carries', value: STEP_EXEC_OUTPUT_MAX },
        { go: 'MaxStepStreamChunk', from: `STEP_STREAM_CHUNK_MAX (${MESSAGES})`, doc: 'the longest chunk one step.stream carries', value: STEP_STREAM_CHUNK_MAX },
        { go: 'MaxClaimFailedReason', from: `CLAIM_FAILED_REASON_MAX (${MESSAGES})`, doc: 'the longest reason a claim.failed carries', value: CLAIM_FAILED_REASON_MAX },
        { go: 'MaxBlockedMessage', from: `BLOCKED_MESSAGE_MAX (${MESSAGES})`, doc: 'the longest message a blocked carries', value: BLOCKED_MESSAGE_MAX },
        { go: 'MaxLogLine', from: `LOG_LINE_MAX (${MESSAGES})`, doc: 'the longest log line a failure bundle or a claim.progress carries', value: LOG_LINE_MAX },
        { go: 'MaxProbeLogTailText', from: 'PROBE_LOG_TAIL_TEXT_MAX (libs/runtime/probe/probe.schema.ts)', doc: 'the longest text of one evidence log line', value: PROBE_LOG_TAIL_TEXT_MAX },
        { go: 'MaxCellMemoryMB', from: `MAX_CELL_MEMORY_MB (${MESSAGES})`, doc: 'the most memory a heartbeat may name, in MB', value: MAX_CELL_MEMORY_MB },
        { go: 'MaxClaimSecrets', from: `MAX_CLAIM_SECRETS (${MESSAGES})`, doc: 'the most org secrets one claim carries', value: MAX_CLAIM_SECRETS },
        { go: 'MaxHealthTimeoutSeconds', from: 'MAX_HEALTH_TIMEOUT_SECONDS (libs/runtime/protocol/recipe.ts)', doc: 'the most a boot waits for the app, in seconds', value: MAX_HEALTH_TIMEOUT_SECONDS },
        { go: 'MaxRecipeNeeds', from: `MAX_RECIPE_NEEDS (${WORKSPACE})`, doc: 'the other repositories one recipe may boot beside its own (services.needs)', value: MAX_RECIPE_NEEDS },
        { go: 'RepositoryAliasPattern', from: `REPOSITORY_ALIAS_PATTERN (${WORKSPACE})`, doc: "a repository's directory in the workspace", pattern: REPOSITORY_ALIAS_PATTERN },
        { go: 'RepositoryFullNamePattern', from: `REPOSITORY_FULL_NAME_PATTERN (${WORKSPACE})`, doc: 'owner/name, or group/subgroup/name', pattern: REPOSITORY_FULL_NAME_PATTERN },
        { go: 'MaxRepositoryFullName', from: `MAX_REPOSITORY_FULL_NAME (${WORKSPACE})`, doc: "the longest repository full name", value: MAX_REPOSITORY_FULL_NAME },
        { go: 'FallbackRepositoryAlias', from: `FALLBACK_REPOSITORY_ALIAS (${WORKSPACE})`, doc: 'the alias of a repository whose name leaves none', value: FALLBACK_REPOSITORY_ALIAS },
        { go: 'SandboxFileChunkBytes', from: `SANDBOX_FILE_CHUNK_BYTES (${SANDBOX})`, doc: 'the most bytes one sandbox read returns and one write takes', value: SANDBOX_FILE_CHUNK_BYTES },
        { go: 'SandboxExecStdoutBytes', from: `SANDBOX_EXEC_STDOUT_BYTES (${SANDBOX})`, doc: 'what a sandbox exec keeps of stdout', value: SANDBOX_EXEC_STDOUT_BYTES },
        { go: 'SandboxExecStderrBytes', from: `SANDBOX_EXEC_STDERR_BYTES (${SANDBOX})`, doc: 'what a sandbox exec keeps of stderr', value: SANDBOX_EXEC_STDERR_BYTES },
        { go: 'SandboxListMaxEntries', from: `SANDBOX_LIST_MAX_ENTRIES (${SANDBOX})`, doc: 'the most entries one sandbox list returns', value: SANDBOX_LIST_MAX_ENTRIES },
        { go: 'SandboxListMaxDepth', from: `SANDBOX_LIST_MAX_DEPTH (${SANDBOX})`, doc: 'the deepest one sandbox list goes', value: SANDBOX_LIST_MAX_DEPTH },
        { go: 'SandboxExecMaxEnv', from: `SANDBOX_EXEC_MAX_ENV (${SANDBOX})`, doc: "the most env entries a sandbox exec's caller may set", value: SANDBOX_EXEC_MAX_ENV },
        { go: 'SandboxPathMax', from: `SANDBOX_PATH_MAX (${SANDBOX})`, doc: 'the longest sandbox path', value: SANDBOX_PATH_MAX },
        { go: 'SandboxEnvironmentID', from: `SANDBOX_ENVIRONMENT_ID (${SANDBOX})`, doc: 'the environment a sandbox claim names', value: SANDBOX_ENVIRONMENT_ID },
        { go: 'MinMachineMemoryMB', from: 'MACHINE_SIZE_LIMITS.memoryMb.min (libs/runtime/contracts/machine-size.ts)', doc: 'the least memory a claim may ask, in MB', value: MACHINE_SIZE_LIMITS.memoryMb.min },
        { go: 'MaxMachineMemoryMB', from: 'MACHINE_SIZE_LIMITS.memoryMb.max (libs/runtime/contracts/machine-size.ts)', doc: 'the most memory a claim may ask, in MB', value: MACHINE_SIZE_LIMITS.memoryMb.max },
        { go: 'MinMachineCPUs', from: 'MACHINE_SIZE_LIMITS.cpus.min (libs/runtime/contracts/machine-size.ts)', doc: 'the fewest CPUs a claim may ask', value: MACHINE_SIZE_LIMITS.cpus.min },
        { go: 'MaxMachineCPUs', from: 'MACHINE_SIZE_LIMITS.cpus.max (libs/runtime/contracts/machine-size.ts)', doc: 'the most CPUs a claim may ask', value: MACHINE_SIZE_LIMITS.cpus.max },
        { go: 'MaxAuthoredFiles', from: 'AUTHORED_FILES_LIMITS.files (libs/runtime/contracts/authored-files.ts)', doc: 'the authored files one recipe may carry', value: AUTHORED_FILES_LIMITS.files },
        { go: 'MaxAuthoredFileBytes', from: 'AUTHORED_FILES_LIMITS.fileBytes (libs/runtime/contracts/authored-files.ts)', doc: 'the UTF-8 bytes of one authored file', value: AUTHORED_FILES_LIMITS.fileBytes },
        { go: 'MaxAuthoredFilesBytes', from: 'AUTHORED_FILES_LIMITS.totalBytes (libs/runtime/contracts/authored-files.ts)', doc: 'the UTF-8 bytes of all authored files together', value: AUTHORED_FILES_LIMITS.totalBytes },
        { go: 'AuthoredFilePathPattern', from: 'AUTHORED_FILE_PATH_PATTERN (libs/runtime/contracts/authored-files.ts)', doc: 'an authored file: directly under .kodus/, its name starting with a letter or a digit', pattern: AUTHORED_FILE_PATH_PATTERN },
        { go: 'RecipeFilePaths', from: 'RECIPE_FILE_PATHS (libs/runtime/contracts/enums.ts)', doc: 'the paths a recipe is read from, which no authored file may take', strings: RECIPE_FILE_PATHS },
        { go: 'ReservedJSONKeys', from: 'RESERVED_JSON_KEYS (libs/runtime/protocol/strict-json.ts)', doc: 'the keys refused anywhere in a frame', strings: [...RESERVED_JSON_KEYS] },
        { go: 'RuntimeSecretNamePattern', from: `RUNTIME_SECRET_NAME_PATTERN (${SECRETS})`, doc: "an org secret's name, the env var its placeholder is set in", pattern: RUNTIME_SECRET_NAME_PATTERN },
        { go: 'ReservedSecretNames', from: `RUNTIME_SECRET_RESERVED_NAMES (${SECRETS})`, doc: "the names a machine's own tooling owns, which no secret may take", strings: [...RUNTIME_SECRET_RESERVED_NAMES] },
        { go: 'ReservedSecretPrefixes', from: `RUNTIME_SECRET_RESERVED_PREFIXES (${SECRETS})`, doc: 'the prefixes no secret name may start with', strings: RUNTIME_SECRET_RESERVED_PREFIXES },
        { go: 'TestValue', from: "testValueFor('NAME') (libs/runtime/blockers/catalog.ts)", doc: 'the value Kodus gives a variable as a test value', value: testValueFor('NAME') },
        { go: 'TestURLValue', from: "testValueFor('NAME_URL') (libs/runtime/blockers/catalog.ts)", doc: 'the test value of a variable named like a URL or a host', value: testValueFor('NAME_URL') },
    ];
}

/** A Go string literal: raw when it can be, so a pattern reads as written. */
function goString(s: string): string {
    return !s.includes('`') && !/[\r\n]/.test(s) ? '`' + s + '`' : JSON.stringify(s);
}

function declaration(c: GoConstant): string {
    const doc = `// ${c.go} is ${c.from}: ${c.doc}.\n`;
    if ('strings' in c) return `${doc}var ${c.go} = []string{\n${c.strings.map((s) => `\t${JSON.stringify(s)},\n`).join('')}}\n`;
    if ('pattern' in c) return `${doc}const ${c.go} = ${goString(goPattern(c.pattern))}\n`;
    if (typeof c.value === 'number') {
        if (!Number.isSafeInteger(c.value)) throw new Error(`${c.go}: ${c.value} is not an integer`);
        return `${doc}const ${c.go} = ${c.value}\n`;
    }
    return `${doc}const ${c.go} = ${JSON.stringify(c.value)}\n`;
}

/** constants_gen.go, gofmt-formatted. */
export function renderGoConstants(): string {
    const names = new Map(CELL_FEATURES.map((f) => [f, featureGoName(f)]));
    const parts: string[] = [
        '// Code generated by libs/runtime/protocol/scripts/dump-json-schema.ts from the TypeScript protocol constants. DO NOT EDIT.\n\npackage protocol\n',
        `// The hello features: CELL_FEATURES (${MESSAGES}, where each one is\n// described), the optional fields and recipe semantics a cell may name.\nconst (\n${CELL_FEATURES.map((f) => `\t${names.get(f)} = ${JSON.stringify(f)}\n`).join('')})\n`,
        `// CellFeatures is CELL_FEATURES (${MESSAGES}), in order.\nvar CellFeatures = []string{\n${CELL_FEATURES.map((f) => `\t${names.get(f)},\n`).join('')}}\n`,
        `// HubAcceptedFeatures is HUB_ACCEPTED_FEATURES (${MESSAGES}):\n// the fields a cell sends only to a hub whose hello ack accepts them.\nvar HubAcceptedFeatures = []string{\n${HUB_ACCEPTED_FEATURES.map((f) => `\t${names.get(f)},\n`).join('')}}\n`,
        ...goConstants().map(declaration),
        '// SecretShape is one telemetry redaction rule: the id it is reported as and\n// its pattern.\ntype SecretShape struct {\n\tID      string\n\tPattern string\n}\n',
        `// TelemetrySecretShapes is TELEMETRY_SECRET_SHAPES\n// (libs/runtime/telemetry/telemetry-guard.ts): values secret by shape, which\n// no log line or span carries.\nvar TelemetrySecretShapes = []SecretShape{\n${TELEMETRY_SECRET_SHAPES.map((s) => `\t{ID: ${JSON.stringify(s.id)}, Pattern: ${goString(goPattern(s.pattern))}},\n`).join('')}}\n`,
    ];
    return alignConstBlock(parts.join('\n'));
}

/** gofmt aligns the = of a const block's lines; the feature block is the only one. */
function alignConstBlock(src: string): string {
    return src.replace(/const \(\n([\s\S]*?)\n\)/, (_m, body: string) => {
        const lines = body.split('\n').map((l) => l.match(/^\t(\S+) = (.*)$/)!);
        const width = Math.max(...lines.map((l) => l[1].length));
        return `const (\n${lines.map((l) => `\t${l[1].padEnd(width)} = ${l[2]}`).join('\n')}\n)`;
    });
}
