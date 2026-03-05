import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { asRecord } from './runtime/value-utils';
import { SkillNotFoundError } from './skill.errors';

/** A required external MCP plugin category declared in SKILL.md frontmatter. */
export interface SkillRequiredMcp {
    /** Machine-readable category key, e.g. "task-management" */
    category: string;
    /** Human-readable label, e.g. "Task Management" */
    label: string;
    /** Comma-separated plugin examples shown to the user, e.g. "Jira, Linear, Notion" */
    examples?: string;
}

export type SkillCapabilityResolutionMode = 'fixed_tools' | 'provider_dynamic';

export interface SkillCapabilityDefinition {
    mode: SkillCapabilityResolutionMode;
    tools?: string[];
}

export type SkillToolMode = 'any' | 'all';
export type SkillFailureMode = 'fail' | 'fallback';

export interface SkillExecutionPolicy {
    /** Behavior when no required MCP/tools are available before execution. */
    onMissingMcp?: SkillFailureMode;
    /** Behavior when MCP connection fails during execution setup. */
    onMcpConnectError?: SkillFailureMode;
    /** Fetcher orchestration timeout in milliseconds. */
    fetcherTimeoutMs?: number;
    /** Analyzer orchestration timeout in milliseconds. */
    analyzerTimeoutMs?: number;
    /** Fetcher max iterations for agent planner (when agent fetcher is used). */
    fetcherMaxIterations?: number;
    /** Analyzer max iterations for agent planner. */
    analyzerMaxIterations?: number;
}

export interface SkillContracts {
    input?: {
        /** Dot-paths required in execution context (e.g., "prepareContext.pullRequestDescription"). */
        requiredContextFields?: string[];
    };
    output?: {
        /** Fields required in the final parsed output object. */
        requiredFields?: string[];
    };
}

/** Per-skill fetcher behavior policy for MCP/tool orchestration. */
export interface SkillFetcherPolicy {
    /**
     * How declared allowed-tools must be matched for kodusmcp connections:
     * - any: at least one tool is enough
     * - all: all tools must be available
     */
    toolMode?: SkillToolMode;
    /**
     * If true, skill fetcher may run even when no MCP tools are available.
     * Defaults to false to avoid token waste.
     */
    allowWithoutTools?: boolean;
}

/** Platform-level metadata parsed from SKILL.md frontmatter. Not user-editable. */
export interface SkillMeta {
    name?: string;
    description?: string;
    license?: string;
    compatibility?: unknown;
    version?: string;
    metadata?: Record<string, unknown>;
    /** Abstract capabilities required by the skill. */
    capabilities?: string[];
    /** Optional per-skill capability -> fixed tools map to extend built-in registry. */
    capabilityToolMap?: Record<string, string[]>;
    /** Optional per-skill capability registry extension/override. */
    capabilityDefinitions?: Record<string, SkillCapabilityDefinition>;
    /** MCP tool names the skill's fetcher agent is allowed to use. */
    allowedTools?: string[];
    /** External MCP plugin categories required for this skill to work. */
    requiredMcps?: SkillRequiredMcp[];
    /** Execution behavior policy. */
    executionPolicy?: SkillExecutionPolicy;
    /** MCP/tool behavior policy for fetcher orchestration. */
    fetcherPolicy?: SkillFetcherPolicy;
    /** Optional input/output contracts for runtime validation. */
    contracts?: SkillContracts;
}

export interface SkillInstructionsLoadOptions {
    organizationId?: string;
    teamId?: string;
    customInstructions?: string;
}

const RequiredMcpSchema = z.looseObject({
    category: z.string(),
    label: z.string(),
    examples: z.string().optional(),
});

const ExecutionPolicySchema = z.looseObject({
    'on-missing-mcp': z.enum(['fail', 'fallback']).optional(),
    'on-mcp-connect-error': z.enum(['fail', 'fallback']).optional(),
    'fetcher-timeout-ms': z.number().int().positive().optional(),
    'analyzer-timeout-ms': z.number().int().positive().optional(),
    'fetcher-max-iterations': z.number().int().positive().optional(),
    'analyzer-max-iterations': z.number().int().positive().optional(),
});

const FetcherPolicySchema = z.looseObject({
    'tool-mode': z.enum(['any', 'all']).optional(),
    'allow-without-tools': z.boolean().optional(),
});

const ContractsSchema = z.looseObject({
    input: z
        .looseObject({
            'required-context-fields': z.array(z.string()).optional(),
        })
        .optional(),
    output: z
        .looseObject({
            'required-fields': z.array(z.string()).optional(),
        })
        .optional(),
});

const KodusExtensionsSchema = z.looseObject({
    'capabilities': z.array(z.string()).optional(),
    'capability-tool-map': z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .optional(),
    'capability-definitions': z
        .record(
            z.string(),
            z.looseObject({
                mode: z.enum(['fixed_tools', 'provider_dynamic']).optional(),
                tools: z.union([z.string(), z.array(z.string())]).optional(),
            }),
        )
        .optional(),
    'required-mcps': z.array(RequiredMcpSchema).optional(),
    'execution-policy': ExecutionPolicySchema.optional(),
    'fetcher-policy': FetcherPolicySchema.optional(),
    'contracts': ContractsSchema.optional(),
});

const SkillFrontmatterSchema = z.looseObject({
    'name': z.string().optional(),
    'description': z.string().optional(),
    'license': z.string().optional(),
    'compatibility': z.unknown().optional(),
    'metadata': z.record(z.string(), z.unknown()).optional(),
    // Agent Skills spec marks allowed-tools as experimental.
    // We support both text list and YAML array for compatibility.
    'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),

    // Legacy Kodus top-level extension keys (kept for backwards compatibility).
    'capabilities': z.array(z.string()).optional(),
    'capability-definitions': z
        .record(
            z.string(),
            z.looseObject({
                mode: z.enum(['fixed_tools', 'provider_dynamic']).optional(),
                tools: z.union([z.string(), z.array(z.string())]).optional(),
            }),
        )
        .optional(),
    'required-mcps': z.array(RequiredMcpSchema).optional(),
    'execution-policy': ExecutionPolicySchema.optional(),
    'fetcher-policy': FetcherPolicySchema.optional(),
    'contracts': ContractsSchema.optional(),
});

@Injectable()
export class SkillLoaderService {
    private readonly logger = new Logger(SkillLoaderService.name);

    /**
     * Runtime instructions for the analyzer.
     * Loads SKILL.md body plus optional overlays.
     */
    loadInstructions(
        skillName: string,
        options?: SkillInstructionsLoadOptions,
    ): string {
        const baseInstructions = this.loadFromFilesystem(skillName);
        const overlays = this.loadInstructionOverlays(skillName, options);
        if (!overlays.length) {
            return baseInstructions;
        }

        const renderedOverlays = overlays
            .map(
                (overlay) =>
                    `### ${overlay.label}\n\n${overlay.content.trim()}`,
            )
            .join('\n\n');

        return `${baseInstructions}\n\n---\n\n## Custom Instructions\n\n${renderedOverlays}`;
    }

    /**
     * Read platform metadata (allowed-tools, name, description, version, required-mcps)
     * from filesystem SKILL.md frontmatter.
     */
    loadSkillMetaFromFilesystem(skillName: string): SkillMeta {
        const skillPath = this.resolveSkillFilePath(skillName, 'SKILL.md');
        if (!skillPath) {
            return {};
        }
        const raw = fs.readFileSync(skillPath, 'utf-8');
        return this.parseFrontmatter(raw).meta;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Load SKILL.md from filesystem and strip frontmatter.
     */
    private loadFromFilesystem(skillName: string): string {
        const skillPath = this.resolveSkillFilePath(skillName, 'SKILL.md');
        if (!skillPath) {
            throw new SkillNotFoundError(skillName);
        }

        this.logger.log(
            `[SkillLoader] loaded filesystem SKILL.md for skill '${skillName}'`,
        );

        const raw = fs.readFileSync(skillPath, 'utf-8');
        const { body } = this.parseFrontmatter(raw);
        return body;
    }

    /**
     * List all reference markdown files in references/ sorted alphabetically.
     */
    listReferences(skillName: string): string[] {
        const refsDir = this.resolveSkillDirectoryPath(skillName, 'references');
        if (!refsDir) {
            return [];
        }

        return fs
            .readdirSync(refsDir)
            .filter((f) => f.endsWith('.md'))
            .sort();
    }

    /**
     * Load a specific reference markdown file content.
     * Returns null when file does not exist or is not resolvable.
     */
    loadReference(skillName: string, fileName: string): string | null {
        const referencePath = this.resolveSkillFilePath(
            skillName,
            path.join('references', fileName),
        );
        if (!referencePath) {
            return null;
        }

        return fs.readFileSync(referencePath, 'utf-8');
    }

    private loadInstructionOverlays(
        skillName: string,
        options?: SkillInstructionsLoadOptions,
    ): Array<{ label: string; content: string }> {
        const overlays: Array<{ label: string; content: string }> = [];
        const teamId = options?.teamId?.trim();
        const organizationId = options?.organizationId?.trim();

        if (teamId) {
            const relativePaths = [
                organizationId
                    ? path.join(
                          'overrides',
                          'organizations',
                          organizationId,
                          'teams',
                          `${teamId}.md`,
                      )
                    : undefined,
                path.join('overrides', 'teams', `${teamId}.md`),
                path.join('overrides', `${teamId}.md`),
            ].filter((value): value is string => Boolean(value));

            for (const relativePath of relativePaths) {
                const overlayPath = this.resolveSkillFilePath(
                    skillName,
                    relativePath,
                );
                if (!overlayPath) {
                    continue;
                }

                const content = fs.readFileSync(overlayPath, 'utf-8').trim();
                if (!content.length) {
                    continue;
                }

                overlays.push({
                    label: `Team Overlay (${relativePath})`,
                    content,
                });
            }
        }

        const customInstructions = options?.customInstructions?.trim();
        if (customInstructions) {
            overlays.push({
                label: 'Runtime Custom Instructions',
                content: customInstructions,
            });
        }

        return overlays;
    }

    /** Parse YAML frontmatter from a SKILL.md string (Agent Skills spec-first). */
    private parseFrontmatter(raw: string): { body: string; meta: SkillMeta } {
        const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) {
            return { body: raw, meta: {} };
        }

        const yamlStr = match[1];
        const body = match[2].trimStart();
        let frontmatter: unknown;
        try {
            frontmatter = yaml.load(yamlStr) ?? {};
        } catch {
            this.logger.warn(
                `[SkillLoader] invalid YAML frontmatter detected. Falling back to empty metadata.`,
            );
            return { body, meta: {} };
        }

        const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
        if (!parsed.success) {
            this.logger.warn(
                `[SkillLoader] frontmatter schema validation failed. Falling back to empty metadata.`,
            );
            return { body, meta: {} };
        }

        const metadata = asRecord(parsed.data.metadata);
        const kodusMetadata = KodusExtensionsSchema.safeParse(
            asRecord(metadata.kodus),
        );
        if (!kodusMetadata.success && metadata.kodus !== undefined) {
            this.logger.warn(
                `[SkillLoader] invalid metadata.kodus schema. Ignoring Kodus extensions for this skill.`,
            );
        }
        const kodus = kodusMetadata.success ? kodusMetadata.data : {};
        const legacyExtensionsUsed =
            parsed.data.capabilities !== undefined ||
            parsed.data['capability-definitions'] !== undefined ||
            parsed.data['required-mcps'] !== undefined ||
            parsed.data['execution-policy'] !== undefined ||
            parsed.data['fetcher-policy'] !== undefined ||
            parsed.data.contracts !== undefined;

        if (legacyExtensionsUsed) {
            this.logger.warn(
                `[SkillLoader] legacy Kodus top-level keys detected. Move extensions to metadata.kodus for spec-first compatibility.`,
            );
        }

        const fetcherPolicy = this.mapFetcherPolicy(
            kodus['fetcher-policy'] ?? parsed.data['fetcher-policy'],
        );
        const executionPolicy = this.mapExecutionPolicy(
            kodus['execution-policy'] ?? parsed.data['execution-policy'],
        );
        const contracts = this.mapContracts(
            kodus.contracts ?? parsed.data.contracts,
        );
        const requiredMcps =
            kodus['required-mcps'] ?? parsed.data['required-mcps'];
        const capabilities = kodus.capabilities ?? parsed.data.capabilities;
        const capabilityToolMap = this.normalizeCapabilityToolMap(
            kodus['capability-tool-map'],
        );
        const capabilityDefinitions = this.normalizeCapabilityDefinitions(
            kodus['capability-definitions'] ??
                parsed.data['capability-definitions'],
        );
        const allowedTools = this.normalizeAllowedTools(
            parsed.data['allowed-tools'],
        );
        const version =
            typeof metadata.version === 'string' ||
            typeof metadata.version === 'number'
                ? String(metadata.version)
                : undefined;

        return {
            body,
            meta: {
                name: parsed.data.name,
                description: parsed.data.description,
                license: parsed.data.license,
                compatibility: parsed.data.compatibility,
                version,
                metadata,
                capabilities,
                capabilityToolMap,
                capabilityDefinitions,
                allowedTools,
                requiredMcps,
                executionPolicy,
                fetcherPolicy,
                contracts,
            },
        };
    }

    private mapFetcherPolicy(value: unknown): SkillFetcherPolicy | undefined {
        const parsed = FetcherPolicySchema.safeParse(value);
        if (!parsed.success) {
            return undefined;
        }

        return {
            toolMode: parsed.data['tool-mode'],
            allowWithoutTools: parsed.data['allow-without-tools'],
        };
    }

    private mapExecutionPolicy(
        value: unknown,
    ): SkillExecutionPolicy | undefined {
        const parsed = ExecutionPolicySchema.safeParse(value);
        if (!parsed.success) {
            return undefined;
        }

        return {
            onMissingMcp: parsed.data['on-missing-mcp'],
            onMcpConnectError: parsed.data['on-mcp-connect-error'],
            fetcherTimeoutMs: parsed.data['fetcher-timeout-ms'],
            analyzerTimeoutMs: parsed.data['analyzer-timeout-ms'],
            fetcherMaxIterations: parsed.data['fetcher-max-iterations'],
            analyzerMaxIterations: parsed.data['analyzer-max-iterations'],
        };
    }

    private mapContracts(value: unknown): SkillContracts | undefined {
        const parsed = ContractsSchema.safeParse(value);
        if (!parsed.success) {
            return undefined;
        }

        return {
            input: parsed.data.input
                ? {
                      requiredContextFields:
                          parsed.data.input['required-context-fields'],
                  }
                : undefined,
            output: parsed.data.output
                ? {
                      requiredFields: parsed.data.output['required-fields'],
                  }
                : undefined,
        };
    }

    private normalizeAllowedTools(value: unknown): string[] | undefined {
        if (Array.isArray(value)) {
            return value.filter(
                (item): item is string =>
                    typeof item === 'string' && item.trim().length > 0,
            );
        }

        if (typeof value === 'string') {
            const tools = value
                .split(/\s+/)
                .map((tool) => tool.trim())
                .filter((tool) => tool.length > 0);
            return tools.length ? tools : undefined;
        }

        return undefined;
    }

    private normalizeCapabilityToolMap(
        value: unknown,
    ): Record<string, string[]> | undefined {
        const record = asRecord(value);
        if (!Object.keys(record).length) {
            return undefined;
        }

        const normalized: Record<string, string[]> = {};
        for (const [capability, rawTools] of Object.entries(record)) {
            if (!capability.trim()) {
                continue;
            }

            const tools = this.normalizeAllowedTools(rawTools);
            if (!tools?.length) {
                continue;
            }

            normalized[capability] = tools;
        }

        return Object.keys(normalized).length ? normalized : undefined;
    }

    private normalizeCapabilityDefinitions(
        value: unknown,
    ): Record<string, SkillCapabilityDefinition> | undefined {
        const record = asRecord(value);
        if (!Object.keys(record).length) {
            return undefined;
        }

        const normalized: Record<string, SkillCapabilityDefinition> = {};
        for (const [capability, rawDefinition] of Object.entries(record)) {
            const trimmedCapability = capability.trim();
            if (!trimmedCapability) {
                continue;
            }

            const definition = asRecord(rawDefinition);
            const modeValue = definition.mode;
            const parsedMode =
                modeValue === 'fixed_tools' || modeValue === 'provider_dynamic'
                    ? modeValue
                    : undefined;
            const tools = this.normalizeAllowedTools(definition.tools);
            const mode =
                parsedMode ?? (tools?.length ? 'fixed_tools' : undefined);

            if (!mode) {
                continue;
            }
            if (mode === 'fixed_tools' && !tools?.length) {
                continue;
            }

            normalized[trimmedCapability] =
                mode === 'provider_dynamic' ? { mode } : { mode, tools };
        }

        return Object.keys(normalized).length ? normalized : undefined;
    }

    private resolveSkillFilePath(
        skillName: string,
        fileName: string,
    ): string | null {
        if (
            skillName.includes('..') ||
            skillName.includes('/') ||
            skillName.includes('\\')
        ) {
            this.logger.warn(
                `[SkillLoader] potential path traversal attempt for skill '${skillName}'.`,
            );
            return null;
        }

        for (const baseDir of this.getSkillsBaseDirCandidates()) {
            const candidate = path.join(baseDir, skillName, fileName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        this.logger.warn(
            `[SkillLoader] could not resolve file '${fileName}' for skill '${skillName}'.`,
        );

        return null;
    }

    private resolveSkillDirectoryPath(
        skillName: string,
        directoryName: string,
    ): string | null {
        if (
            skillName.includes('..') ||
            skillName.includes('/') ||
            skillName.includes('\\')
        ) {
            this.logger.warn(
                `[SkillLoader] potential path traversal attempt for skill '${skillName}'.`,
            );
            return null;
        }

        for (const baseDir of this.getSkillsBaseDirCandidates()) {
            const candidate = path.join(baseDir, skillName, directoryName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private getSkillsBaseDirCandidates(): string[] {
        const candidates = [
            // Development runtime (docker volume mounted source)
            path.join(process.cwd(), 'libs', 'agents', 'skills'),
            // ts-node / direct source execution
            __dirname,
            // Built runtime fallback
            path.join(__dirname, '..', '..', 'skills'),
        ];

        return [...new Set(candidates)];
    }
}
