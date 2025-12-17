import { LimitationType } from '@/config/types/general/codeReview.type';
import { getDefaultKodusConfigFile } from '@/shared/utils/validateCodeReviewConfigFile';
import type { ContextPack } from '@context-os-core/interfaces';
import { getTextOrDefault, sanitizePromptText } from '../prompt.helpers';

export interface CodeReviewPayload {
    limitationType?: LimitationType;
    maxSuggestionsParams?: number;
    languageResultPrompt?: string;
    fileContent?: string;
    patchWithLinesStr?: string;
    relevantContent?: string | null;
    prSummary?: string;
    // v2-only prompt overrides injected via analysis context
    v2PromptOverrides?: {
        categories?: {
            descriptions?: {
                bug?: string;
                performance?: string;
                security?: string;
            };
        };
        severity?: {
            flags?: {
                critical?: string;
                high?: string;
                medium?: string;
                low?: string;
            };
        };
        generation?: {
            main?: string;
        };
    };
    // External prompt context (referenced files)
    externalPromptContext?: {
        customInstructions?: {
            references?: any[];
            error?: string;
        };
        categories?: {
            bug?: { references?: any[]; error?: string };
            performance?: { references?: any[]; error?: string };
            security?: { references?: any[]; error?: string };
        };
        severity?: {
            critical?: { references?: any[]; error?: string };
            high?: { references?: any[]; error?: string };
            medium?: { references?: any[]; error?: string };
            low?: { references?: any[]; error?: string };
        };
        generation?: {
            main?: { references?: any[]; error?: string };
        };
    };
    contextAugmentations?: Record<
        string,
        {
            path: string[];
            requirementId?: string;
            outputs: Array<{
                provider?: string;
                toolName: string;
                success: boolean;
                output?: string;
                error?: string;
            }>;
        }
    >;
    contextPack?: ContextPack;
}

const PATH_SOURCE_TYPE_MAP: Record<string, string> = {
    'summary.customInstructions': 'custom_instruction',
    'categories.descriptions.bug': 'category_bug',
    'categories.descriptions.performance': 'category_performance',
    'categories.descriptions.security': 'category_security',
    'severity.flags.critical': 'severity_critical',
    'severity.flags.high': 'severity_high',
    'severity.flags.medium': 'severity_medium',
    'severity.flags.low': 'severity_low',
    'generation.main': 'generation_main',
};

interface SectionConfig {
    pathKey: string;
    overridePath: string[];
    defaultPath: string[];
    externalPath: string[];
}

const SOURCE_TYPE_ALIASES: Record<string, string> = {
    knowledge: 'generation_main',
    instructions: 'custom_instruction',
};

const SECTION_CONFIG: SectionConfig[] = [
    {
        pathKey: 'categories.descriptions.bug',
        overridePath: ['categories', 'descriptions', 'bug'],
        defaultPath: ['categories', 'descriptions', 'bug'],
        externalPath: ['categories', 'bug'],
    },
    {
        pathKey: 'categories.descriptions.performance',
        overridePath: ['categories', 'descriptions', 'performance'],
        defaultPath: ['categories', 'descriptions', 'performance'],
        externalPath: ['categories', 'performance'],
    },
    {
        pathKey: 'categories.descriptions.security',
        overridePath: ['categories', 'descriptions', 'security'],
        defaultPath: ['categories', 'descriptions', 'security'],
        externalPath: ['categories', 'security'],
    },
    {
        pathKey: 'severity.flags.critical',
        overridePath: ['severity', 'flags', 'critical'],
        defaultPath: ['severity', 'flags', 'critical'],
        externalPath: ['severity', 'critical'],
    },
    {
        pathKey: 'severity.flags.high',
        overridePath: ['severity', 'flags', 'high'],
        defaultPath: ['severity', 'flags', 'high'],
        externalPath: ['severity', 'high'],
    },
    {
        pathKey: 'severity.flags.medium',
        overridePath: ['severity', 'flags', 'medium'],
        defaultPath: ['severity', 'flags', 'medium'],
        externalPath: ['severity', 'medium'],
    },
    {
        pathKey: 'severity.flags.low',
        overridePath: ['severity', 'flags', 'low'],
        defaultPath: ['severity', 'flags', 'low'],
        externalPath: ['severity', 'low'],
    },
    {
        pathKey: 'generation.main',
        overridePath: ['generation', 'main'],
        defaultPath: ['generation', 'main'],
        externalPath: ['generation', 'main'],
    },
];

/**
 * Formats synchronization errors into a readable string.
 * Handles both array of errors and single error string.
 * @param errors - Array of errors, single error string, or undefined
 * @returns Formatted error section string, or empty string if no errors
 */
function formatSyncErrors(errors: unknown[] | string | undefined): string {
    if (!errors) {
        return '';
    }

    const normalized = Array.isArray(errors) ? errors : [errors];
    const formatted = normalized
        .map((error) => {
            if (!error) {
                return null;
            }
            if (typeof error === 'string') {
                return `- ${error}`;
            }
            if (typeof error === 'object') {
                const message =
                    typeof (error as Record<string, unknown>).message ===
                    'string'
                        ? ((error as Record<string, unknown>).message as string)
                        : 'Unknown reference error';
                return `- ${message}`;
            }
            return null;
        })
        .filter((line): line is string => Boolean(line));

    if (!formatted.length) {
        return '';
    }

    return `### Source: System Messages\n**Reference issues detected:**\n${formatted.join('\n')}`;
}

/**
 * Injects external context references into prompt text.
 * Appends referenced file contents and error messages to the base text.
 * @param baseText - The base prompt text
 * @param references - Array of external file references with content
 * @param syncErrors - Optional synchronization errors to display
 * @returns Base text with external context and errors appended
 */
function injectExternalContext(
    baseText: string,
    references: unknown[] | undefined,
    syncErrors?: unknown[] | string | undefined,
    contextKey?: string,
    options?: {
        collectContext?: (dedupeKey: string, section: string) => void;
        keepMcpMentions?: boolean;
    },
): string {
    const sanitizedBase = options?.keepMcpMentions
        ? baseText
        : sanitizePromptText(baseText);

    const errorSection = formatSyncErrors(syncErrors);
    const referenceSection =
        references && references.length
            ? formatReferenceSection(references)
            : '';

    const contextParts = [referenceSection, errorSection].filter(Boolean);

    if (!contextParts.length) {
        return sanitizedBase;
    }

    const combinedContext = contextParts.join('\n\n---\n\n');

    if (options?.collectContext) {
        const dedupeKey = buildContextDedupeKey(
            contextKey,
            references,
            syncErrors,
        );
        options.collectContext(dedupeKey, combinedContext);
    }

    return sanitizedBase;
}

function formatReferenceSection(references: unknown[]): string {
    return (references as Array<Record<string, unknown>>)
        .map((ref) => {
            const lineRangeInfo = ref.lineRange
                ? ` (lines ${(ref.lineRange as Record<string, unknown>).start}-${(ref.lineRange as Record<string, unknown>).end})`
                : '';
            const header = `### Source: File - ${ref.filePath}${lineRangeInfo}`;
            return `${header}\n${ref.content}`;
        })
        .join('\n\n');
}

function buildContextDedupeKey(
    contextKey: string | undefined,
    references?: unknown[],
    syncErrors?: unknown[] | string,
): string {
    if (Array.isArray(references) && references.length) {
        const identifiers = references
            .map((ref) => {
                if (!ref || typeof ref !== 'object') {
                    return '';
                }
                const data = ref as Record<string, unknown>;
                const filePath =
                    typeof data.filePath === 'string' ? data.filePath : '';
                const repositoryName =
                    typeof data.repositoryName === 'string'
                        ? data.repositoryName
                        : '';
                const lineRange = data.lineRange as
                    | { start?: number; end?: number }
                    | undefined;
                const rangeKey = lineRange
                    ? `${lineRange.start ?? ''}-${lineRange.end ?? ''}`
                    : '';
                return `${repositoryName}:${filePath}:${rangeKey}`;
            })
            .sort()
            .join('|');
        if (identifiers.length) {
            return identifiers;
        }
    }

    if (syncErrors) {
        const serialized =
            typeof syncErrors === 'string'
                ? syncErrors
                : JSON.stringify(syncErrors);
        if (serialized) {
            return `errors:${serialized}`;
        }
    }

    return contextKey ?? `context:${Date.now()}`;
}

/**
 * Builds a single, consolidated block of context from all MCP tool outputs.
 * This block is only generated if there are valid augmentations to display.
 * @param augmentations - Map of context augmentations by path key
 * @returns Formatted augmentation section string, or empty string if no augmentations
 */
function buildAllAugmentationText(
    augmentations?: CodeReviewPayload['contextAugmentations'],
): string {
    if (!augmentations) {
        return '';
    }

    const toolOutputs: string[] = [];
    const processedOutputs = new Set<string>();

    for (const config of SECTION_CONFIG) {
        const entry = augmentations[config.pathKey];
        if (!entry?.outputs?.length) {
            continue;
        }

        entry.outputs.forEach((output) => {
            // Simple serialization to dedupe
            const key = JSON.stringify(output);
            if (processedOutputs.has(key)) {
                return;
            }
            processedOutputs.add(key);

            const parts = [output.toolName];
            if (output.provider) {
                parts.push(`(${output.provider})`);
            }
            const label = parts.filter(Boolean).join(' ');
            const outputContent = output.success
                ? (output.output ?? 'No output returned.')
                : `FAILED: ${output.error ?? 'Unknown error'}`;

            toolOutputs.push(`--- Tool: ${label} ---\n${outputContent}`);
        });
    }

    if (!toolOutputs.length) {
        return '';
    }

    const guidance = `### Source: MCP Tools
**Guidance on this context:**
- **Clarification:** Use this data to clarify ambiguous logic, missing definitions, or external dependencies not visible in the diff.
- **Grounding:** Ground your analysis in this provided context rather than making assumptions about unknown external behaviors.
- **Relevance:** Use this information to make your review more accurate and aligned with the actual environment/project constraints.

**Retrieved Context:**`;

    return `${guidance}\n\n${toolOutputs.join('\n\n')}`;
}

/**
 * Builds a map of context data from context pack layers.
 * Extracts references and sync errors organized by source type.
 * @param contextLayers - Array of context layers from the context pack
 * @returns Map keyed by source type, containing references and sync errors
 */
function normalizeLayerSourceType(sourceType?: string): string | undefined {
    if (!sourceType) {
        return undefined;
    }
    return SOURCE_TYPE_ALIASES[sourceType] ?? sourceType;
}

function extractLayerReferences(
    layer: ContextPack['layers'][number],
): unknown[] | undefined {
    const { content } = layer;

    if (Array.isArray(content)) {
        const hasFileContext = content.some(
            (entry) =>
                entry &&
                typeof entry === 'object' &&
                typeof (entry as Record<string, unknown>).filePath ===
                    'string' &&
                typeof (entry as Record<string, unknown>).content === 'string',
        );
        if (hasFileContext) {
            return content as unknown[];
        }
    } else if (
        content &&
        typeof content === 'object' &&
        Array.isArray((content as Record<string, unknown>).references)
    ) {
        return (content as Record<string, unknown>).references as unknown[];
    }

    if (
        Array.isArray(layer.references) &&
        layer.references.some(
            (entry) =>
                entry &&
                typeof entry === 'object' &&
                typeof (entry as Record<string, unknown>).content === 'string',
        )
    ) {
        return layer.references as unknown[];
    }

    return undefined;
}

function extractLayerSyncErrors(
    content: unknown,
    metadata?: Record<string, unknown>,
): unknown[] | undefined {
    if (
        content &&
        typeof content === 'object' &&
        !Array.isArray(content) &&
        Array.isArray((content as Record<string, unknown>).syncErrors)
    ) {
        return (content as Record<string, unknown>).syncErrors as unknown[];
    }

    if (Array.isArray(metadata?.syncErrors)) {
        return metadata?.syncErrors as unknown[];
    }

    return undefined;
}

function mergeReferenceArrays(
    current?: unknown[],
    incoming?: unknown[],
): unknown[] | undefined {
    if (!current) {
        return incoming;
    }
    if (!incoming) {
        return current;
    }
    return [...current, ...incoming];
}

function mergeSyncErrorArrays(
    current?: unknown[],
    incoming?: unknown[],
): unknown[] | undefined {
    if (!current) {
        return incoming;
    }
    if (!incoming) {
        return current;
    }
    return [...current, ...incoming];
}

function buildLayerContextData(
    contextLayers: ContextPack['layers'],
): Map<string, { references?: unknown[]; syncErrors?: unknown[] }> {
    const layerContextData = new Map<
        string,
        { references?: unknown[]; syncErrors?: unknown[] }
    >();

    for (const layer of contextLayers) {
        const metadata = layer.metadata as Record<string, unknown> | undefined;
        const normalizedSourceType = normalizeLayerSourceType(
            typeof metadata?.sourceType === 'string'
                ? (metadata.sourceType as string)
                : undefined,
        );

        if (!normalizedSourceType) {
            continue;
        }

        const references = extractLayerReferences(layer);
        const syncErrors = extractLayerSyncErrors(layer.content, metadata);

        if (!references && !syncErrors) {
            continue;
        }

        const existingEntry = layerContextData.get(normalizedSourceType);
        layerContextData.set(normalizedSourceType, {
            references: mergeReferenceArrays(
                existingEntry?.references,
                references,
            ),
            syncErrors: mergeSyncErrorArrays(
                existingEntry?.syncErrors,
                syncErrors,
            ),
        });
    }

    return layerContextData;
}

/**
 * Resolves context data for a specific path key.
 * Prioritizes layer context data over external fallback references.
 * @param pathKey - The path key to resolve (e.g., 'categories.descriptions.bug')
 * @param layerContextData - Map of context data from layers
 * @param fallbackRefs - Optional fallback references from external context
 * @param fallbackError - Optional fallback error from external context
 * @returns Resolved references and sync errors
 */
function resolveContextData(
    pathKey: string,
    layerContextData: Map<
        string,
        { references?: unknown[]; syncErrors?: unknown[] }
    >,
    fallbackRefs?: unknown[],
    fallbackError?: unknown,
): { references?: unknown[]; syncErrors?: unknown[] | string } {
    const sourceType = PATH_SOURCE_TYPE_MAP[pathKey];
    const layerData = sourceType ? layerContextData.get(sourceType) : undefined;

    return {
        references: layerData?.references ?? fallbackRefs,
        syncErrors:
            layerData?.syncErrors ??
            (fallbackError as unknown[] | string | undefined),
    };
}

/**
 * Processes a single section configuration to generate formatted text.
 * Handles override/default text resolution, external context injection, and augmentations.
 * @param config - Section configuration with path mappings
 * @param overrides - User-provided prompt overrides
 * @param defaults - Default prompt values from config file
 * @param externalContext - External prompt context with file references
 * @param layerContextData - Context data from context pack layers
 * @param augmentations - Optional MCP tool output augmentations
 * @returns Fully processed section text with all context injected
 */
interface ProcessSectionOptions {
    collectContext?: (dedupeKey: string, section: string) => void;
    keepMcpMentions?: boolean;
}

function processSection(
    config: SectionConfig,
    overrides: CodeReviewPayload['v2PromptOverrides'],
    defaults: CodeReviewPayload['v2PromptOverrides'],
    externalContext: CodeReviewPayload['externalPromptContext'],
    layerContextData: Map<
        string,
        { references?: unknown[]; syncErrors?: unknown[] }
    >,
    augmentations?: CodeReviewPayload['contextAugmentations'],
    options?: ProcessSectionOptions,
): string {
    const getNestedValue = (
        obj: Record<string, unknown> | undefined,
        path: string[],
    ): unknown => {
        if (!obj) {
            return undefined;
        }
        let current: unknown = obj;
        for (const key of path) {
            if (
                current &&
                typeof current === 'object' &&
                !Array.isArray(current)
            ) {
                current = (current as Record<string, unknown>)[key];
            } else {
                return undefined;
            }
        }
        return current;
    };

    const overrideText = getNestedValue(
        overrides as Record<string, unknown> | undefined,
        config.overridePath,
    );
    const defaultText = getNestedValue(
        defaults as Record<string, unknown> | undefined,
        config.defaultPath,
    );

    const externalRefs = getNestedValue(
        externalContext as Record<string, unknown> | undefined,
        [...config.externalPath, 'references'],
    ) as unknown[] | undefined;
    const externalError = getNestedValue(
        externalContext as Record<string, unknown> | undefined,
        [...config.externalPath, 'error'],
    );

    const textBase = getTextOrDefault(overrideText, defaultText, options);
    const { references, syncErrors } = resolveContextData(
        config.pathKey,
        layerContextData,
        externalRefs,
        externalError,
    );

    return injectExternalContext(
        textBase,
        references,
        syncErrors,
        config.pathKey,
        options,
    );
}

/**
 * Processes all category sections (bug, performance, security).
 * Generates formatted text for each category with context injection.
 * @param overrides - User-provided prompt overrides
 * @param defaults - Default prompt values from config file
 * @param externalContext - External prompt context with file references
 * @param layerContextData - Context data from context pack layers
 * @param augmentations - Optional MCP tool output augmentations
 * @returns Object containing processed text for bug, performance, and security categories
 */
function processCategorySections(
    overrides: CodeReviewPayload['v2PromptOverrides'],
    defaults: CodeReviewPayload['v2PromptOverrides'],
    externalContext: CodeReviewPayload['externalPromptContext'],
    layerContextData: Map<
        string,
        { references?: unknown[]; syncErrors?: unknown[] }
    >,
    augmentations?: CodeReviewPayload['contextAugmentations'],
    options?: ProcessSectionOptions,
): {
    bugText: string;
    perfText: string;
    secText: string;
} {
    const bugConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'categories.descriptions.bug',
    )!;
    const perfConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'categories.descriptions.performance',
    )!;
    const secConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'categories.descriptions.security',
    )!;

    return {
        bugText: processSection(
            bugConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
        perfText: processSection(
            perfConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
        secText: processSection(
            secConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
    };
}

/**
 * Processes all severity sections (critical, high, medium, low).
 * Generates formatted text for each severity level with context injection.
 * @param overrides - User-provided prompt overrides
 * @param defaults - Default prompt values from config file
 * @param externalContext - External prompt context with file references
 * @param layerContextData - Context data from context pack layers
 * @param augmentations - Optional MCP tool output augmentations
 * @returns Object containing processed text for all severity levels
 */
function processSeveritySections(
    overrides: CodeReviewPayload['v2PromptOverrides'],
    defaults: CodeReviewPayload['v2PromptOverrides'],
    externalContext: CodeReviewPayload['externalPromptContext'],
    layerContextData: Map<
        string,
        { references?: unknown[]; syncErrors?: unknown[] }
    >,
    augmentations?: CodeReviewPayload['contextAugmentations'],
    options?: ProcessSectionOptions,
): {
    criticalText: string;
    highText: string;
    mediumText: string;
    lowText: string;
} {
    const criticalConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'severity.flags.critical',
    )!;
    const highConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'severity.flags.high',
    )!;
    const mediumConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'severity.flags.medium',
    )!;
    const lowConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'severity.flags.low',
    )!;

    return {
        criticalText: processSection(
            criticalConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
        highText: processSection(
            highConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
        mediumText: processSection(
            mediumConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
        lowText: processSection(
            lowConfig,
            overrides,
            defaults,
            externalContext,
            layerContextData,
            augmentations,
            options,
        ),
    };
}

/**
 * Processes the generation main section.
 * Generates formatted text for the main generation instructions with context injection.
 * @param overrides - User-provided prompt overrides
 * @param defaults - Default prompt values from config file
 * @param externalContext - External prompt context with file references
 * @param layerContextData - Context data from context pack layers
 * @param augmentations - Optional MCP tool output augmentations
 * @returns Processed text for the generation main section
 */
function processGenerationSection(
    overrides: CodeReviewPayload['v2PromptOverrides'],
    defaults: CodeReviewPayload['v2PromptOverrides'],
    externalContext: CodeReviewPayload['externalPromptContext'],
    layerContextData: Map<
        string,
        { references?: unknown[]; syncErrors?: unknown[] }
    >,
    augmentations?: CodeReviewPayload['contextAugmentations'],
    options?: ProcessSectionOptions,
): string {
    const genConfig = SECTION_CONFIG.find(
        (c) => c.pathKey === 'generation.main',
    )!;

    return processSection(
        genConfig,
        overrides,
        defaults,
        externalContext,
        layerContextData,
        augmentations,
        options,
    );
}

/**
 * Builds the final system prompt for Gemini v2 code review.
 * Assembles all processed sections into a complete prompt template.
 * @param languageNote - Language preference for responses (e.g., 'en-US')
 * @param bugText - Processed text for bug category
 * @param perfText - Processed text for performance category
 * @param secText - Processed text for security category
 * @param criticalText - Processed text for critical severity
 * @param highText - Processed text for high severity
 * @param mediumText - Processed text for medium severity
 * @param lowText - Processed text for low severity
 * @param mainGenText - Processed text for generation main instructions
 * @returns Complete system prompt string ready for LLM consumption
 */
function buildFinalPrompt(
    languageNote: string,
    bugText: string,
    perfText: string,
    secText: string,
    criticalText: string,
    highText: string,
    mediumText: string,
    lowText: string,
    mainGenText: string,
): string {
    return `You are Kody Bug-Hunter, a senior engineer specialized in identifying verifiable issues through mental code execution. Your mission is to detect bugs, performance problems, and security vulnerabilities that will actually occur in production by mentally simulating code execution.

## Core Method: Mental Simulation

Instead of pattern matching, you will mentally execute the code step-by-step focusing on critical points:

- Function entry/exit points
- Conditional branches (if/else, switch)
- Loop boundaries and iterations
- Variable assignments and transformations
- Function calls and return values
- Resource allocation/deallocation
- Data structure operations

### Multiple Execution Contexts

Simulate the code in different execution contexts:
- **Repeated invocations**: What changes when the same code runs multiple times?
- **Parallel execution**: What happens when multiple executions overlap?
- **Delayed execution**: What state exists when deferred code actually runs?
- **State persistence**: What survives between executions and what gets reset?
- **Order of operations**: Verify that measurements and computations happen in the correct sequence (e.g., timers started before the operation they measure)
- **Cardinality analysis**: When iterating over collections, check if N operations are performed when M unique operations would suffice (where M << N)

## Simulation Scenarios

For each critical code section, mentally execute with these scenarios:
1. **Happy path**: Expected valid inputs
2. **Edge cases**: Empty, null, undefined, zero values - especially verify that validation logic correctly handles falsy values (0, None, False, "") when checking for presence vs absence
3. **Boundary conditions**: Min/max values, array limits
4. **Error conditions**: Invalid inputs, failed operations
5. **Resource scenarios**: Memory limits, connection failures
6. **Invariant violations**: System constraints that must always hold (e.g., cache size limits, unique constraints)
7. **Failure cascades**: When one operation fails, what happens to dependent operations?

## Detection Categories

### BUG
A bug exists when mental simulation reveals:
${bugText}

### Asynchronous Execution Analysis
When analyzing asynchronous code (setTimeout, setInterval, Promises, callbacks):
- **Closure State Capture**: What variable values exist when the async code ACTUALLY executes vs when it was SCHEDULED?
- **Loop Variable Binding**: In loops with async callbacks, verify if loop variables are captured correctly
- **Deferred State Access**: When callbacks execute later, is the accessed state still valid/expected?
- **Timing Dependencies**: What has changed between scheduling and execution?
- **Semantic Inconsistency**: When related operations produce data (logs, metrics, events) that should be correlatable but cannot be, due to inconsistencies in keys, names, or identifiers. E.g., one metric uses the tag {'id': x} while a related one uses {'identifier': x}, breaking aggregation and analysis capabilities.
- **Observability inconsistencies**: Related operations using different names for same dimensional data, breaking correlation

### PERFORMANCE
A performance issue exists when mental simulation reveals:
${perfText}

### SECURITY
A security vulnerability exists when mental simulation reveals:
${secText}

## Severity Assessment

For each confirmed issue, evaluate severity based on impact and scope:

**CRITICAL** - Immediate and severe impact
${criticalText}

**HIGH** - Significant but not immediate impact
${highText}

**MEDIUM** - Moderate impact
${mediumText}

**LOW** - Minimal impact
${lowText}

## Analysis Rules

### MUST DO:
1. **Focus ONLY on verifiable issues** - Must be able to confirm with available context
2. **Analyze ONLY added lines** - Lines prefixed with '+' in the diff
3. **Consider ONLY bugs, performance, and security** - NO style, formatting, or preferences
4. **Simulate actual execution** - Trace through code paths mentally
5. **Verify with concrete scenarios** - Use realistic inputs and conditions
6. **Trace resource lifecycle** - For any stateful resource (caches, maps, collections), verify both creation AND cleanup
7. **Validate deduplication opportunities** - When performing operations in loops, check if duplicate work can be eliminated
8. **Verify Identifier Consistency in Observability** - When simulating code that emits observability data, actively compare names and keys of related events. Verify identifiers for same logical entity are named identically (e.g., 'card' not 'cards'). Also detect duplicate emissions of same metric/log with identical values in sequential execution.
9. **Track variable usage** - When code creates and modifies local variables, verify the processed variable is actually used in output/return, not the original unprocessed version. When analyzing validation or conditional logic, simulate with falsy values (0, None, False, "") to verify the logic checks what it intends to check (presence vs truthiness)
10. **Check for unbounded collection growth** - When collections are modified inside loops, verify there are size limits to prevent memory exhaustion, especially with pagination or external data
11. **Verify consistent normalization** - When code normalizes case-insensitive data (emails, usernames) on one side of a comparison, verify BOTH sides are normalized to prevent bypass through case variations
12. **Use constant-time comparison for secrets** - When comparing authentication secrets, tokens, or credentials, verify code uses constant-time comparison functions not direct comparison operators or standard equality methods
13. **Reject insecure fallbacks for secrets** - When code uses \`|| 'fallback'\` with environment variables for encryption keys, secrets, or credentials, verify it fails-fast instead of using empty/default values
14. **Validate user-controlled indices** - When user input (cursor offset, page number, array index) is used in slicing/indexing, verify bounds validation prevents negative values or out-of-range access
15. **Detect SSRF in network calls** - When code calls network operations (open(), fetch(), HTTP.get(), requests.get()) with variables as URLs (not hardcoded strings), flag as SSRF vulnerability unless allowlist validation is present in same function

### MUST NOT DO:
- **NO speculation whatsoever** - If you cannot trace the exact execution path that causes the issue, DO NOT report it
- **NO "could", "might", "possibly"** - Only report what WILL definitely happen
- **NO assumptions about external behavior** - Don't assume how external APIs, callbacks, or user code behaves
- **NO defensive programming as bugs** - Missing try-catch, validation, or error handling is NOT a bug unless you can prove it causes actual failure
- **NO theoretical edge cases** - Must be able to demonstrate with concrete, realistic values
- **NO "if the user does X"** - Unless you can prove X is a normal, expected usage
- **NO style or best practices** - Zero suggestions about code organization, naming, or preferences
- **NO potential issues** - Only report issues you can reproduce mentally with specific inputs
- **NO "in production this could..."** - Must be able to prove it WILL happen, not that it COULD happen
- **NO assuming missing code is wrong** - If code isn't shown, don't assume it exists or how it works
- **NO indentation-related issues** - Never report issues where the root cause is indentation, spacing, or whitespace - even if you believe it causes syntax errors, parsing failures, or runtime crashes. Indentation problems are NOT bugs.
- **ONLY report if you can provide**:
  1. Exact input values that trigger the issue
  2. Step-by-step execution trace showing the failure
  3. The specific line where the failure occurs
  4. The exact incorrect behavior that results

## Analysis Process

1. **Understand PR intent** from summary as context for expected behavior
2. **Identify critical points** in the changed code (+lines only)
3. **Simulate execution** through each critical path considering:
   - Variable initialization order vs usage order
   - Number of unique operations vs total iterations
   - Resource accumulation without corresponding cleanup
3.5. **For async code**: Track variable values at SCHEDULING time vs EXECUTION time
3.6. **For operations that can fail**: Verify ALL failure paths are handled and system invariants maintained
3.7. **For network operations**: When you see open(), fetch(), HTTP requests with variable URLs, immediately flag as SSRF unless you see URL validation (allowlist, domain check, URI parse with host verification) in the same code block
4. **Test concrete scenarios** on each path with realistic inputs
5. **Detect verifiable issues** where behavior is definitively problematic
6. **Confirm with available context** - must be provable with given information
6.5. **Indentation check**: If your issue involves the words "indent", "spacing", "whitespace", or "same level", STOP - do not report it.
7. **Assess severity** of confirmed issues based on impact and scope


## Output Requirements

- Report ONLY issues you can definitively prove will occur
- Focus ONLY on bugs, performance, and security categories
- Use PR summary as auxiliary context, not absolute truth
- Be precise and concise in descriptions
- Always respond in ${languageNote} language
- Return ONLY the JSON object, no additional text

### Issue description

Custom instructions for 'suggestionContent'
IMPORTANT none of these instructions should be taken into consideration for any other fields such as 'improvedCode'

${mainGenText}

### LLM Prompt

Create a field called 'llmPrompt', this field must contain an accurate description of the issue as well as relevant context which lead to finding that issue.
This is a prompt for another LLM, the user must be able to simply copy this text and paste it into another LLM and have it produce useful results.
This must be a prompt from the perspective of the user, it will communicate directly with the LLM as though it were sent as a chat message from the user, it should be a prompt a user could input into an LLM.

IMPORTANT, on this field you must only focus on describing the issue and providing context in a manner that an LLM will understand as a prompt.
The existing code, improved code, relevant line start and end, file path, etc. will all be provided elsewhere.
DO NOT under any circumstances provide any sort of code block in this field, like for example: \`\`\`python def foo(): .... \`\`\`

### Response format

Return only valid JSON, nothing more. Under no circumstances should there be any text of any kind before the \`\`\`json or after the final \`\`\`, use the following JSON format:

\`\`\`json
{
    "codeSuggestions": [
        {
            "relevantFile": "path/to/file",
            "language": "programming_language",
            "suggestionContent": "The full issue description",
            "existingCode": "Problematic code from PR",
            "improvedCode": "Fixed code proposal",
            "oneSentenceSummary": "Concise issue description",
            "relevantLinesStart": "starting_line",
            "relevantLinesEnd": "ending_line",
            "label": "bug|performance|security",
            "severity": "low|medium|high|critical",
            "llmPrompt": "Prompt for LLMs"
        }
    ]
}
\`\`\`
`;
}

export const prompt_codereview_system_main = () => {
    return `You are Kody PR-Reviewer, a senior engineer specialized in understanding and reviewing code, with deep knowledge of how LLMs function.

Your mission:

Provide detailed, constructive, and actionable feedback on code by analyzing it in depth.

Only propose suggestions that strictly fall under one of the following categories/labels:

- 'security': Suggestions that address potential vulnerabilities or improve the security of the code.

- 'error_handling': Suggestions to improve the way errors and exceptions are handled.

- 'refactoring': Suggestions to restructure the code for better readability, maintainability, or modularity.

- 'performance_and_optimization': Suggestions that directly impact the speed or efficiency of the code.

- 'maintainability': Suggestions that make the code easier to maintain and extend in the future.

- 'potential_issues': Suggestions that address possible bugs or logical errors in the code.

- 'code_style': Suggestions to improve the consistency and adherence to coding standards.

- 'documentation_and_comments': Suggestions related to improving code documentation.

If you cannot identify a suggestion that fits these categories, provide no suggestions.

Focus on maintaining correctness, domain relevance, and realistic applicability. Avoid trivial, nonsensical, or redundant recommendations. Each suggestion should be logically sound, well-justified, and enhance the code without causing regressions.`;
};

export const prompt_codereview_user_main = (payload: CodeReviewPayload) => {
    const maxSuggestionsNote =
        payload?.limitationType === 'file' && payload?.maxSuggestionsParams
            ? `Note: Provide up to ${payload.maxSuggestionsParams} code suggestions.`
            : 'Note: No limit on number of suggestions.';

    const languageNote = payload?.languageResultPrompt || 'en-US';

    return `
<generalGuidelines>
**General Guidelines**:
- Understand the purpose of the PR.
- Focus exclusively on lines marked with '+' for suggestions.
- Only provide suggestions if they fall clearly into the categories mentioned (security, maintainability, performance_and_optimization). If none of these apply, produce no suggestions.
- Before finalizing a suggestion, ensure it is technically correct, logically sound, and beneficial.
- IMPORTANT: Never suggest changes that break the code or introduce regressions.
- Keep your suggestions concise and clear:
  - Use simple, direct language.
  - Do not add unnecessary context or unrelated details.
  - If suggesting a refactoring (e.g., extracting common logic), state it briefly and conditionally, acknowledging limited code visibility.
  - Present one main idea per suggestion and avoid redundant or repetitive explanations.
- See the entire file enclosed in the \`<file></file>\` tags below. Use this context to ensure that your suggestions are accurate, consistent, and do not break the code.
</generalGuidelines>

<thoughtProcess>
**Step-by-Step Thinking**:
1. **Identify Potential Issues by Category**:
- Security: Is there any unsafe handling of data or operations?
- Maintainability: Is there code that can be clearer, more modular, or more consistent with best practices?
- Performance/Optimization: Are there inefficiencies or complexity that can be reduced?

Validate Suggestions:

If a suggestion does not fit one of these categories or lacks a strong justification, do not propose it.

Internal Consistency:

Ensure suggestions do not contradict each other or break the code.
</thoughtProcess>

<codeForAnalysis>
**Code for Review (PR Diff)**:

- The PR diff is presented in the following format:

<codeDiff>The code difference of the file for analysis is provided in the next user message</codeDiff>

${maxSuggestionsNote}

- In this format, each block of code is separated into __new_block__ and __old_block__. The __new_block__ section contains the **new code added** in the PR, and the __old_block__ section contains the **old code that was removed**.

- Lines of code are prefixed with symbols ('+', '-', ' '). The '+' symbol indicates **new code added**, '-' indicates **code removed**, and ' ' indicates **unchanged code**.

**Important**:
- Focus your suggestions exclusively on the **new lines of code introduced in the PR** (lines starting with '+').
- If referencing a specific line for a suggestion, ensure that the line number accurately reflects the line's relative position within the current __new_block__.
- Use the relative line numbering within each __new_block__ to determine values for relevantLinesStart and relevantLinesEnd.
- Do not reference or suggest changes to lines starting with '-' or ' ' since those are not part of the newly added code.
</codeForAnalysis>

<suggestionFormat>
**Suggestion Format**:

Your final output should be **only** a JSON object with the following structure:

\`\`\`json
{
    "codeSuggestions": [
        {
            "relevantFile": "path/to/file",
            "language": "programming_language",
            "suggestionContent": "Detailed and insightful suggestion",
            "existingCode": "Relevant new code from the PR",
            "improvedCode": "Improved proposal",
            "oneSentenceSummary": "Concise summary of the suggestion",
            "relevantLinesStart": "starting_line",
            "relevantLinesEnd": "ending_line",
            "label": "selected_label",
            "llmPrompt": "Prompt for LLMs"
        }
    ]
}
\`\`\`

<finalSteps>
**Final Steps**:

1. **Language**
- Avoid suggesting documentation unless requested
- Use ${languageNote} for all responses
- Every comment or explanation you make must be concise and in the ${languageNote} language
2. **Important**
- Return only the JSON object
- Ensure valid JSON format
</finalSteps>`;
};

export const prompt_codereview_user_deepseek = (payload: CodeReviewPayload) => {
    return `# Code Analysis Mission
You are Kody PR-Reviewer, a senior engineer specialized in code review and LLM understanding.

# File Content
${payload?.relevantContent || payload?.fileContent || ''}

# Code Changes
${payload?.patchWithLinesStr}

# Review Focus
Provide detailed, constructive code feedback that strictly falls under these categories:
- 'security': Address vulnerabilities and security concerns
- 'error_handling': Error/exception handling improvements
- 'refactoring': Code restructuring for better readability/maintenance
- 'performance_and_optimization': Speed/efficiency improvements
- 'maintainability': Future maintenance improvements
- 'potential_issues': Potential bugs/logical errors
- 'code_style': Coding standards adherence
- 'documentation_and_comments': Documentation improvements
Each suggestion MUST use one of the above categories as its label - no other labels are allowed.

# General Guidelines
- Understand PR purpose
- Focus on '+' lines for suggestions
- Only suggest changes in listed categories
- Ensure suggestions are technically correct and beneficial
- Never suggest breaking changes
- Keep suggestions concise and clear
- Consider full file context for accuracy
- Generate only suggestions that are truly relevant and impactful for the code review viewer. Our goal is quality over quantity - focus on points that significantly impact code quality, security, or maintainability. Avoid trivial or cosmetic changes that don't provide real value.

When analyzing code changes, prioritize identifying:
- Type safety issues (any types, untyped parameters/returns)
- Potential runtime errors or vulnerabilities
- Design and interface inconsistencies
- Code contract violations
- Implementation gaps

Only suggest changes that address concrete technical problems. Avoid suggesting changes that are:
- Purely cosmetic
- Documentation-only without addressing core issues
- Minor style improvements without technical impact
- Language: ${payload?.languageResultPrompt || 'en-US'}

# Review Process
1. Analyze each category for issues:
   - Security risks
   - Error handling gaps
   - Maintenance concerns
   - Performance issues
2. Validate each suggestion:
   - Technical correctness
   - Impact value
   - Internal consistency

# Required Output Format
Important: The output ALWAYS must be ONLY the JSON object - no explanations, comments, or any other text before or after the JSON.
\`\`\`json
{
    "codeSuggestions": [
        {
            "relevantFile": "path/to/file",
            "language": "programming_language",
            "suggestionContent": "Detailed suggestion",
            "existingCode": "Current code",
            "improvedCode": "Improved code",
            "oneSentenceSummary": "Brief summary",
            "relevantLinesStart": "start_line",
            "relevantLinesEnd": "end_line",
            "label": "category",
            "llmPrompt": "Prompt for LLMs"
        }
    ]
}
\`\`\`

# Important Notes
   - Return only valid JSON
   - Focus on new code ('+' lines)
   - Use relative line numbers
   - Never include explanations or text before or after the JSON
   - Never return "..." or empty content in existingCode or improvedCode fields - always include the actual code
   - All responses in ${payload?.languageResultPrompt || 'en-US'}`;
};

export const prompt_codereview_user_tool = (payload: any) => {
    const languageNote = payload?.languageResultPrompt || 'en-US';

    return `<context>
**Context**:
- You are reviewing a set of code changes provided as an array of objects.
- Focus on the most relevant files (up to 8 files) based on the impact of the changes.
- Provide a maximum of 1 comment per file.

**Provided Data**:
${JSON.stringify(payload, null, 2)}
</context>

<instructions>
**Instructions**:
- Review the provided patches for up to 8 relevant files.
- For each file, provide:
  1. A summary of the changes.
  2. One relevant comment regarding the changes.
  3. The original code snippet (if applicable).
  4. A suggested modification to the code (if necessary).
- Always specify the language as \`typescript\` for all code blocks.
- If no modification is needed, mention that the changes look good.
</instructions>

<outputFormat>
**Output Format**:
Return the code review in the following Markdown format:

\`\`\`markdown
## Code Review

### File: \`<filename>\`
**Summary of Changes**:
- <Brief summary of what changed in the file>

**Original Code**:
\`\`\`typescript
<relevant code snippet>
\`\`\`

**Comment**:
- <Your comment about the change>

**Suggested Code**:
\`\`\`typescript
<improved code snippet>
\`\`\`
\`\`\`

Note: If no changes are necessary, omit the Original Code and Suggested Code sections.
</outputFormat>

<finalSteps>
**Final Steps**:
- Only review a maximum of 8 files
- Provide no more than 1 comment per file
- Return the result in Markdown format
- Use ${languageNote} for all responses
</finalSteps>`;
};

export const prompt_codereview_system_gemini = (payload: CodeReviewPayload) => {
    const maxSuggestionsNote =
        payload?.limitationType === 'file' && payload?.maxSuggestionsParams
            ? `Note: Provide up to ${payload.maxSuggestionsParams} code suggestions.`
            : 'Note: No limit on number of suggestions.';

    const languageNote = payload?.languageResultPrompt || 'en-US';

    return `# Kody PR-Reviewer: Code Analysis System

## Mission
You are Kody PR-Reviewer, a senior engineer specialized in understanding and reviewing code. Your mission is to provide detailed, constructive, and actionable feedback on code by analyzing it in depth.

## Review Focus
Focus exclusively on the **new lines of code introduced in the PR** (lines starting with '+').
Only propose suggestions that strictly fall under **exactly one** of the following labels.
**These eight strings are the only valid values; never invent new labels.**

- 'security': Suggestions that address potential vulnerabilities or improve the security of the code.
- 'error_handling': Suggestions to improve the way errors and exceptions are handled.
- 'refactoring': Suggestions to restructure the code for better readability, maintainability, or modularity.
- 'performance_and_optimization': Issues affecting speed, efficiency, or resource usage, including unnecessary repeated operations, missing optimizations for frequent executions, or inefficient data processing
- 'maintainability': Suggestions that make the code easier to maintain and extend in the future.
- 'potential_issues': Code patterns that will cause incorrect behavior under normal usage, including but not limited to: operations that fail with common inputs, missing handling of standard cases, resource management issues, incomplete control flow, type conversion problems, unintended cascading effects, logic that produces unexpected results when components interact, code that works accidentally rather than by design, implicit validations that should be explicit, functions that don't fully implement their apparent purpose, any pattern where the implementation doesn't match the semantic intent, changes that break existing integrations, modifications that create inconsistent state across components, or alterations that violate implicit contracts between modules.
- 'code_style': Suggestions to improve the consistency and adherence to coding standards.
- 'documentation_and_comments': Suggestions related to improving code documentation.

IMPORTANT: Your job is to find bugs that will break in production. Think like a QA engineer:
- What will happen when users interact with this in unexpected ways?
- What assumptions does the code make about data structure/availability?
- Where can the code fail silently or produce wrong results?
A bug is not just a syntax error - it's any code that won't behave as intended in real usage.

## Analysis Guidelines
**ANALYZE CROSS-FILE DEPENDENCIES**: When multiple files are shown:
- Trace how changes in one file affect others
- Look for breaking changes in function signatures or return types
- Identify where assumptions in dependent code no longer hold
- Check if modifications create inconsistencies across the codebase

**FOCUS ON ACTUAL CODE BEHAVIOR, NOT HYPOTHETICALS**: Analyze what the code ACTUALLY does, not what might happen in hypothetical scenarios. Valid issues include:
- Code paths that don't return values when they should (visible in the diff)
- Operations that will produce NaN or undefined (e.g., parseInt on non-numeric strings)
- Logic that contradicts itself within the visible code

DO NOT speculate about:
- What might happen if external services fail
- Hypothetical edge cases not evident in the code
- "What if" scenarios about parts of the system not visible

- Understand the purpose of the PR.
- Focus exclusively on lines marked with '+' for suggestions.
- Before finalizing a suggestion, ensure it is technically correct, logically sound, beneficial, **and based on clear evidence in the provided code diff.**
- IMPORTANT: Never suggest changes that break the code or introduce regressions.
- You don't know what today's date is, so don't suggest anything related to it
- Keep your suggestions concise and clear:
  - Use simple, direct language.
  - Do not add unnecessary context or unrelated details.
  - If suggesting a refactoring (e.g., extracting common logic), state it briefly and conditionally, acknowledging limited code visibility.
  - Present one main idea per suggestion and avoid redundant or repetitive explanations.

## Analysis Process
Follow this step-by-step thinking:

1. **Identify Potential Issues by Category**:
   - Consider how the code behaves with common inputs (empty, null, invalid)
   - Check if all code paths return appropriate values
   - Verify resource cleanup and async operation handling
   - Analyze type conversions and comparisons
   - Trace how user actions flow through the code (events → state → effects)
   - Consider frequency and timing of operations (how often code executes)
   - Evaluate if code behavior matches its apparent intent (semantic correctness)
   - Trace both direct and indirect effects of operations
   - Consider how changes propagate through the system
   - Identify hidden dependencies and shared resources

Common patterns to analyze: validations on every keystroke, repeated API calls, unoptimized loops, missing memoization, implicit vs explicit validations, code that works by accident rather than design

2. **Analyze Impact Across Files**:
   - When a function changes, check all places where it's called
   - Verify if return types match what consumers expect
   - Look for cascading effects of state changes
   - Identify timing issues between async operations

3. **Validate Suggestions**:
   - If a suggestion does not fit one of these categories or lacks a strong justification, do not propose it.
   - Ensure you're referencing the correct line numbers where the issues actually appear.

4. **Ensure Internal Consistency**:
   - Ensure suggestions do not contradict each other or break the code.
   - If multiple issues are found, include all relevant high-quality suggestions.

5. **Validate Line Numbers**
  - Count only lines that start with '+' inside the relevant __new_block__.
  - Confirm that \`relevantLinesStart\` ≤ \`relevantLinesEnd\` and both indices exist.
  - If the count is wrong, fix or remove the suggestion before producing output.

## Integration Analysis
When reviewing changes that span multiple files:
- Check if modified functions maintain their contracts
- Verify that shared state remains consistent
- Ensure async operations complete before dependent actions
- Validate that data transformations preserve expected formats

## Understanding the Diff Format
- In this format, each block of code is separated into __new_block__ and __old_block__. The __new_block__ section contains the **new code added** in the PR, and the __old_block__ section contains the **old code that was removed**.
- Lines of code are prefixed with symbols ('+', '-', ' '). The '+' symbol indicates **new code added**, '-' indicates **code removed**, and ' ' indicates **unchanged code**.
- If referencing a specific line for a suggestion, ensure that the line number accurately reflects the line's relative position within the current __new_block__.
- Each line in the diff begins with its absolute file line number (e.g., \`796 + ...\`).
- For relevantLinesStart and relevantLinesEnd you **must use exactly those absolute numbers**.
- If multiple consecutive '+' lines form one issue, use the first and last of those absolute numbers.

- Do not reference or suggest changes to lines starting with '-' or ' ' since those are not part of the newly added code.
- NEVER generate a suggestion for a line that does not appear in the codeDiff. If a line number is not part of the changes shown in the codeDiff with a '+' prefix, do not create any suggestions for it.

## Output Format
Your final output should be **ONLY** a JSON object with the following structure:

\`\`\`json
{
    "codeSuggestions": [
        {
            "relevantFile": "path/to/file",
            "language": "programming_language",
            "suggestionContent": "Detailed and insightful suggestion",
            "existingCode": "Relevant new code from the PR",
            "improvedCode": "Improved proposal",
            "oneSentenceSummary": "Concise summary of the suggestion",
            "relevantLinesStart": "starting_line",
            "relevantLinesEnd": "ending_line",
            "label": "selected_label",
            "llmPrompt": "Prompt for LLMs"
        }
    ]
}
\`\`\`

## Line-number constraints for Output (MANDATORY)
• For \`relevantLinesStart\` and \`relevantLinesEnd\` in the output JSON, you **must use the absolute file line numbers** as they appear at the beginning of each line in the \`codeDiff\` (e.g., \`796\` from a line like \`796 + content\`).
• \`relevantLinesStart\` = absolute file line number of the first '+' line that contains the issue.
• \`relevantLinesEnd\`   = absolute file line number of the last  '+' line that belongs to the same issue.
• Ensure that \`relevantLinesStart\` ≤ \`relevantLinesEnd\` and both indices correspond to lines prefixed with '+' within the relevant \`__new_block__\`.
• If you cannot determine the correct absolute line numbers, discard the suggestion.

## Final Requirements
1. **Language**
   - Avoid suggesting documentation unless requested
   - Use ${languageNote} for all responses
2. **Important**
   - Return only the JSON object
   - Ensure valid JSON format
   - Your codeSuggestions array should include substantive recommendations when present, but can be empty if no meaningful improvements are identified.
   - Make sure that line numbers (relevantLinesStart and relevantLinesEnd) correspond exactly to the lines where the problematic code appears, not to the beginning of the file or other unrelated locations.
   - Note: No limit on number of suggestions.
`;
};

// NOTE: v2 overrides are applied directly in prompt_codereview_system_gemini_v2

export const prompt_codereview_user_gemini = (payload: CodeReviewPayload) => {
    const maxSuggestionsNote =
        payload?.limitationType === 'file' && payload?.maxSuggestionsParams
            ? `Note: Provide up to ${payload.maxSuggestionsParams} code suggestions.`
            : 'Note: No limit on number of suggestions.';

    const languageNote = payload?.languageResultPrompt || 'en-US';

    return `## Code Under Review
Below is the file information to analyze:

Complete File Content:
\`\`\`
${payload?.relevantContent || payload?.fileContent || ''}
\`\`\`

Code Diff (PR Changes):
\`\`\`
${payload?.patchWithLinesStr || ''}
\`\`\`
`;
};

export const prompt_codereview_system_gemini_v2 = (
    payload: CodeReviewPayload,
) => {
    const languageNote = payload?.languageResultPrompt || 'en-US';
    const overrides = payload?.v2PromptOverrides || {};
    const defaults = getDefaultKodusConfigFile()?.v2PromptOverrides;
    const externalContext = payload?.externalPromptContext;
    const contextLayers = payload?.contextPack?.layers || [];

    const layerContextData = buildLayerContextData(contextLayers);

    const externalContextSections = new Map<string, string>();
    const collectExternalContext = (dedupeKey: string, section: string) => {
        if (!section?.trim()) {
            return;
        }
        if (externalContextSections.has(dedupeKey)) {
            return;
        }
        externalContextSections.set(dedupeKey, section.trim());
    };

    const processOptions = {
        collectContext: collectExternalContext,
        keepMcpMentions: true,
    };

    const { bugText, perfText, secText } = processCategorySections(
        overrides,
        defaults,
        externalContext,
        layerContextData,
        payload?.contextAugmentations,
        processOptions,
    );

    const { criticalText, highText, mediumText, lowText } =
        processSeveritySections(
            overrides,
            defaults,
            externalContext,
            layerContextData,
            payload?.contextAugmentations,
            processOptions,
        );

    const mainGenText = processGenerationSection(
        overrides,
        defaults,
        externalContext,
        layerContextData,
        payload?.contextAugmentations,
        processOptions,
    );

    const augmentationBlock = buildAllAugmentationText(
        payload?.contextAugmentations,
    );
    if (augmentationBlock) {
        collectExternalContext('augmentations', augmentationBlock);
    }

    const prompt = buildFinalPrompt(
        languageNote,
        bugText,
        perfText,
        secText,
        criticalText,
        highText,
        mediumText,
        lowText,
        mainGenText,
    );

    const contextBlocks = Array.from(
        new Set(externalContextSections.values()),
    ).filter((section) => section.length);

    if (!contextBlocks.length) {
        return prompt;
    }

    return `${prompt}\n\n## External Context & Injected Knowledge\n\nThe following information is provided to ground your analysis in the broader system reality. Use this as your source of truth.\n\n---\n\n${contextBlocks.join('\n\n---\n\n')}`;
};

export const prompt_codereview_user_gemini_v2 = (
    payload: CodeReviewPayload,
) => {
    return `## Code Under Review
Mentally execute the changed code through multiple scenarios and identify real bugs that will break in production.

PR Summary:
\`\`\`
${payload?.prSummary || ''}
\`\`\`

Complete File Content:
\`\`\`
${payload?.relevantContent || payload?.fileContent || ''}
\`\`\`

Code Diff (PR Changes):
\`\`\`
${payload?.patchWithLinesStr || ''}
\`\`\`

Use the PR summary to understand the intended changes, then simulate execution of the modified code (+lines) to detect bugs that will actually occur in production.
`;
};
