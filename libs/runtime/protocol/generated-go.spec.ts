import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { RUNTIME_SECRET_NAME_PATTERN, RUNTIME_SECRET_RESERVED_NAMES, RUNTIME_SECRET_RESERVED_PREFIXES } from '@libs/runtime/api/domain/secrets';
import { testValueFor } from '@libs/runtime/blockers/catalog';
import { AUTHORED_FILE_PATH_PATTERN, AUTHORED_FILES_LIMITS } from '@libs/runtime/contracts/authored-files';
import { RECIPE_FILE_PATHS, SECURITY_VIOLATION_SIGNATURE } from '@libs/runtime/contracts/enums';
import { MACHINE_SIZE_LIMITS } from '@libs/runtime/contracts/machine-size';
import { PREVIEW_ID_PATTERN } from '@libs/runtime/contracts/preview';
import { TRACEPARENT_SHAPE } from '@libs/runtime/contracts/trace-context';
import { FALLBACK_REPOSITORY_ALIAS, MAX_RECIPE_NEEDS, MAX_REPOSITORY_FULL_NAME, REPOSITORY_ALIAS_PATTERN, REPOSITORY_FULL_NAME_PATTERN } from '@libs/runtime/contracts/workspace';
import { TELEMETRY_SECRET_SHAPES } from '@libs/runtime/telemetry/telemetry-guard';

import { CELL_FEATURES, HUB_ACCEPTED_FEATURES, MAX_CELL_MEMORY_MB, MAX_CLAIM_SECRETS } from './messages';
import { MAX_HEALTH_TIMEOUT_SECONDS } from './recipe';
import {
    SANDBOX_ENVIRONMENT_ID,
    SANDBOX_EXEC_MAX_ENV,
    SANDBOX_EXEC_STDERR_BYTES,
    SANDBOX_EXEC_STDOUT_BYTES,
    SANDBOX_FILE_CHUNK_BYTES,
    SANDBOX_LIST_MAX_DEPTH,
    SANDBOX_LIST_MAX_ENTRIES,
    SANDBOX_PATH_MAX,
} from './sandbox';
import { GENERATED_FILES, generatedFiles, staleGeneratedFiles, writeGeneratedFiles } from './scripts/dump-json-schema';
import { featureGoName, goPattern } from './scripts/go-constants';
import { RESERVED_JSON_KEYS } from './strict-json';

// The Go cell compiles these values from constants_gen.go, which the schema
// generator writes from the TypeScript exports: a value changed on one side
// only is a stale file, and the drift check below fails on it.

const REPO_ROOT = resolve(__dirname, '../../..');
const goFile = () => generatedFiles()[GENERATED_FILES.constants];

/** A Go literal as its value: a raw string, a quoted string or an integer. */
function goLiteral(lit: string): string | number {
    if (lit.startsWith('`')) return lit.slice(1, -1);
    if (lit.startsWith('"')) return JSON.parse(lit);
    return Number(lit);
}

/** Every top-level const and every []string var of the generated file, by Go name. */
function goDeclarations(src: string): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const m of src.matchAll(/^(?:const )?\t?(\w+)\s+= (`[^`]*`|"(?:[^"\\]|\\.)*"|-?\d+)$/gm)) out.set(m[1], goLiteral(m[2]));
    for (const m of src.matchAll(/^var (\w+) = \[\]string\{\n([\s\S]*?)\n\}$/gm)) {
        out.set(
            m[1],
            m[2].split('\n').map((l) => {
                const item = l.trim().replace(/,$/, '');
                return item.startsWith('"') ? JSON.parse(item) : out.get(item);
            }),
        );
    }
    return out;
}

describe('generated Go protocol constants', () => {
    it('declares each hello feature under the Go name the cell uses, in CELL_FEATURES order, and the ones a hub accepts', () => {
        const decls = goDeclarations(goFile());
        for (const f of CELL_FEATURES) expect(decls.get(featureGoName(f))).toBe(f);
        expect(decls.get('CellFeatures')).toEqual([...CELL_FEATURES]);
        expect(decls.get('HubAcceptedFeatures')).toEqual([...HUB_ACCEPTED_FEATURES]);
        expect(featureGoName('dbEffects')).toBe('FeatureDBEffects');
        expect(featureGoName('seededSQL')).toBe('FeatureSeededSQL');
        expect(featureGoName('buildStateEvicted')).toBe('FeatureBuildStateEvicted');
    });

    it.each<[string, unknown]>([
        ['SecurityViolationSignaturePattern', SECURITY_VIOLATION_SIGNATURE.source],
        ['TraceparentShapePattern', TRACEPARENT_SHAPE.source],
        ['PreviewIDPattern', PREVIEW_ID_PATTERN.source],
        ['MaxCellMemoryMB', MAX_CELL_MEMORY_MB],
        ['MaxClaimSecrets', MAX_CLAIM_SECRETS],
        ['MaxHealthTimeoutSeconds', MAX_HEALTH_TIMEOUT_SECONDS],
        ['MaxRecipeNeeds', MAX_RECIPE_NEEDS],
        ['RepositoryAliasPattern', REPOSITORY_ALIAS_PATTERN.source],
        ['RepositoryFullNamePattern', REPOSITORY_FULL_NAME_PATTERN.source.replace(/\\\//g, '/')],
        ['MaxRepositoryFullName', MAX_REPOSITORY_FULL_NAME],
        ['FallbackRepositoryAlias', FALLBACK_REPOSITORY_ALIAS],
        ['SandboxFileChunkBytes', SANDBOX_FILE_CHUNK_BYTES],
        ['SandboxExecStdoutBytes', SANDBOX_EXEC_STDOUT_BYTES],
        ['SandboxExecStderrBytes', SANDBOX_EXEC_STDERR_BYTES],
        ['SandboxListMaxEntries', SANDBOX_LIST_MAX_ENTRIES],
        ['SandboxListMaxDepth', SANDBOX_LIST_MAX_DEPTH],
        ['SandboxExecMaxEnv', SANDBOX_EXEC_MAX_ENV],
        ['SandboxPathMax', SANDBOX_PATH_MAX],
        ['SandboxEnvironmentID', SANDBOX_ENVIRONMENT_ID],
        ['MinMachineMemoryMB', MACHINE_SIZE_LIMITS.memoryMb.min],
        ['MaxMachineMemoryMB', MACHINE_SIZE_LIMITS.memoryMb.max],
        ['MinMachineCPUs', MACHINE_SIZE_LIMITS.cpus.min],
        ['MaxMachineCPUs', MACHINE_SIZE_LIMITS.cpus.max],
        ['MaxAuthoredFiles', AUTHORED_FILES_LIMITS.files],
        ['MaxAuthoredFileBytes', AUTHORED_FILES_LIMITS.fileBytes],
        ['MaxAuthoredFilesBytes', AUTHORED_FILES_LIMITS.totalBytes],
        ['AuthoredFilePathPattern', AUTHORED_FILE_PATH_PATTERN],
        ['RecipeFilePaths', [...RECIPE_FILE_PATHS]],
        ['ReservedJSONKeys', [...RESERVED_JSON_KEYS]],
        ['RuntimeSecretNamePattern', RUNTIME_SECRET_NAME_PATTERN.source],
        ['ReservedSecretNames', [...RUNTIME_SECRET_RESERVED_NAMES]],
        ['ReservedSecretPrefixes', [...RUNTIME_SECRET_RESERVED_PREFIXES]],
        ['TestValue', testValueFor('SESSION_SECRET')],
        ['TestURLValue', testValueFor('PAYMENTS_URL')],
    ])('declares %s with the value of its TypeScript export', (name, value) => {
        expect(goDeclarations(goFile()).get(name)).toEqual(value);
    });

    it('declares each telemetry secret shape with its id, case-insensitive where the TS pattern is', () => {
        const src = goFile();
        for (const s of TELEMETRY_SECRET_SHAPES) {
            const pattern = (s.pattern.flags.includes('i') ? '(?i)' : '') + s.pattern.source.replace(/\\\//g, '/');
            expect(src).toContain(`{ID: ${JSON.stringify(s.id)}, Pattern: \`${pattern}\`}`);
        }
    });

    it('starts with the header Go tools read as generated', () => {
        expect(goFile()).toMatch(/^\/\/ Code generated .* DO NOT EDIT\.\n\npackage protocol\n/);
    });

    it('refuses a pattern Go would read differently or not compile', () => {
        expect(() => goPattern(/^(?=a)b$/)).toThrow(/lookaround/);
        expect(() => goPattern(/(?<!a)b/)).toThrow(/lookaround/);
        expect(() => goPattern(/^a$/m)).toThrow(/flags m/);
        expect(goPattern(/^a\/b$/gi)).toBe('(?i)^a/b$');
        expect(goPattern('^\\\\/x$')).toBe('^\\\\/x$');
    });
});

describe('generated Go drift check', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'runtime-protocol-gen-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('finds the checked-in schema dump and constants_gen.go current', () => {
        // Stale: run libs/runtime/protocol/scripts/dump-json-schema.ts, then go generate ./internal/protocol.
        expect(staleGeneratedFiles(REPO_ROOT)).toEqual([]);
    });

    it('fails on a generated file edited by hand or missing', () => {
        writeGeneratedFiles(dir);
        expect(staleGeneratedFiles(dir)).toEqual([]);

        writeFileSync(join(dir, GENERATED_FILES.constants), goFile().replace(`MaxCellMemoryMB = ${MAX_CELL_MEMORY_MB}`, 'MaxCellMemoryMB = 1024'));
        unlinkSync(join(dir, GENERATED_FILES.schema));

        expect(staleGeneratedFiles(dir).sort()).toEqual([GENERATED_FILES.constants, GENERATED_FILES.schema].sort());
    });
});
