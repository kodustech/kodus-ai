/**
 * Context-Pack — local, flow-free port of the legacy flow engine's context-pack
 * surface (the `@file` external-reference context for code review).
 *
 * Phase 2 (done): the TYPES are now defined locally (no longer re-exported from
 * the legacy flow engine) — faithful ports of the legacy flow engine's context interfaces. Deep
 * leaf types the context-pack code never reads (signal/knowledge/runtime
 * snapshots) are kept intentionally loose.
 *
 * The runtime (pack-assembly pipeline + budget + requirements hash + revision
 * entry) is ported below. Every context-pack file imports types + runtime from
 * HERE. The MCP-execution branch (MCPOrchestrator/InMemoryMCPRegistry/
 * createMCPAdapter + MCP invocation types) intentionally stays on the legacy
 * flow-engine path for now and is NOT part of this module.
 */
import { createHash, randomUUID } from 'crypto';

export type ContextDomain = string;
export type SensitivityLevel = 'none' | 'low' | 'medium' | 'high';
export type ConfidentialityLevel = 'public' | 'internal' | 'restricted';

export interface SourceRef {
    type: string;
    location: string;
    accessor?: string;
    metadata?: Record<string, unknown>;
}

export type LineageAction =
    | 'created'
    | 'updated'
    | 'compacted'
    | 'expired'
    | 'approved'
    | 'rollback';
export type LineageActor = 'ingestion' | 'human' | 'automation';

/** Base reference for any actor in the system. */
export interface ActorRef {
    kind: string;
    id?: string;
    name?: string;
    metadata?: Record<string, unknown>;
}

export interface LineageRecord {
    timestamp: number;
    actor: LineageActor;
    action: LineageAction;
    notes?: string;
    metadata?: Record<string, unknown>;
}

// Deep leaf types — the context-pack code never reads their fields (they only
// appear in optional/unused positions), so they stay intentionally loose.
export type SignalPacket = Record<string, unknown>;
export type KnowledgeItem = Record<string, unknown>;
export type RuntimeContextSnapshot = Record<string, unknown>;
export type DeliveryRequest = Record<string, unknown>;

export interface ContentSlice {
    range?: [number, number];
    summary?: string;
    weight: number;
    metadata?: Record<string, unknown>;
}

export interface Candidate {
    item: KnowledgeItem;
    score: number;
    rationale?: string;
    slices?: ContentSlice[];
    metadata?: Record<string, unknown>;
}

export interface RetrievalQuery {
    domain: ContextDomain;
    taskIntent: string;
    signal: SignalPacket;
    constraints?: {
        maxTokens?: number;
        since?: number;
        includeDomains?: ContextDomain[];
        excludeSources?: string[];
        confidentiality?: ConfidentialityLevel;
    };
    hints?: Record<string, unknown>;
}

export interface RetrievalResult {
    candidates: Candidate[];
    durationMs?: number;
    diagnostics?: Record<string, unknown>;
}

export type LayerResidence = 'resident' | 'on_demand' | 'cached';
export type ContextLayerKind =
    | 'core'
    | 'catalog'
    | 'active'
    | 'instructions'
    | 'facts'
    | 'history'
    | 'entities'
    | 'tools'
    | 'metadata'
    | string;

export interface TokenBudget {
    limit: number;
    usage: number;
    breakdown: Record<string, number>;
}

export interface ContextLayer {
    id?: string;
    kind: ContextLayerKind;
    priority: number;
    tokens: number;
    residence?: LayerResidence;
    content: unknown;
    references: Array<{ itemId: string; sliceId?: string }>;
    metadata?: Record<string, unknown>;
}

export interface ContextResourceRef {
    id: string;
    type: 'file' | 'script' | 'template' | 'binary' | string;
    location: string;
    description?: string;
    metadata?: Record<string, unknown>;
}

export type ContextActionType =
    | 'mcp'
    | 'workflow'
    | 'internal'
    | 'http'
    | string;
export type ContextActionTrigger =
    | 'pre_core'
    | 'pre_delivery'
    | 'post_delivery'
    | 'async'
    | 'background';

export interface ContextActionDescriptor {
    id: string;
    type: ContextActionType;
    trigger: ContextActionTrigger;
    instruction?: string;
    metadata?: Record<string, unknown>;
    config?: Record<string, unknown>;
    mcpId?: string;
    toolName?: string;
    workflowId?: string;
    callable?: string;
    endpoint?: string;
}

export type ContextConsumerKind =
    | 'prompt'
    | 'workflow'
    | 'action'
    | 'tool'
    | 'agent'
    | string;

export interface ContextConsumerRef extends ActorRef {
    id: string;
    kind: ContextConsumerKind;
}

/** Immutable/versioned contract of what a consumer needs from context. */
export interface ContextRequirement {
    id: string;
    consumer: ContextConsumerRef;
    request: RetrievalQuery;
    packProfileId?: string;
    requiredLayerKinds?: ContextLayerKind[];
    dependencies?: ContextDependency[];
    optional?: boolean;
    metadata?: Record<string, unknown>;
    version?: string;
    revisionId?: string;
    parentRevisionId?: string;
    createdBy?: string;
    createdAt?: number;
    updatedBy?: string;
    updatedAt?: number;
    status?: 'active' | 'deprecated' | 'draft';
}

/** Official whitelist of tools/knowledge/MCPs for governance. */
export interface ContextDependency {
    type:
        | 'tool'
        | 'mcp'
        | 'workflow'
        | 'prompt'
        | 'action'
        | 'knowledge'
        | string;
    id: string;
    descriptor?: unknown;
    metadata?: Record<string, unknown>;
}

export interface ContextRevisionScope {
    level: string;
    identifiers?: Record<string, string>;
    path?: Array<{ level: string; id: string }>;
    metadata?: Record<string, unknown>;
}

export interface ContextRevisionActor extends ActorRef {
    kind: 'human' | 'automation' | 'system' | string;
    contact?: string;
}

/** Versioned event (commit) that introduces/updates requirements + payload. */
export interface ContextRevisionLogEntry {
    revisionId: string;
    parentRevisionId?: string;
    scope: ContextRevisionScope;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    requirements?: ContextRequirement[];
    knowledgeRefs?: Array<{ itemId: string; version?: string }>;
    origin?: ContextRevisionActor;
    createdAt: number;
    metadata?: Record<string, unknown>;
}

export interface ContextEvidence<TPayload = unknown> {
    id: string;
    provider: string;
    category?: string;
    severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
    confidence?: 'high' | 'medium' | 'low';
    title?: string;
    payload: TPayload;
    source?: SourceRef;
    attachments?: string[];
    metadata?: Record<string, unknown>;
    createdAt: number;
    correlationId?: string;
    toolName?: string;
}

/** Final pack delivered to the LLM with layers, resources and requirements. */
export interface ContextPack {
    id: string;
    domain: ContextDomain;
    version: string;
    createdAt: number;
    createdBy: string;
    budget: TokenBudget;
    layers: ContextLayer[];
    provenance?: LineageRecord[];
    constraints?: RetrievalQuery['constraints'];
    resources?: ContextResourceRef[];
    requiredActions?: ContextActionDescriptor[];
    dependencies?: ContextDependency[];
    metadata?: Record<string, unknown>;
}

export interface LayerInputContext {
    domain: ContextDomain;
    taskIntent: string;
    retrieval: RetrievalResult;
    runtimeContext?: RuntimeContextSnapshot;
    deliveryRequest?: DeliveryRequest;
    metadata?: Record<string, unknown>;
}

export interface LayerBuildOptions {
    maxTokens?: number;
    priority?: number;
    residence?: LayerResidence;
    includeDiagnostics?: boolean;
}

export interface LayerBuildDiagnostics {
    tokensBefore?: number;
    tokensAfter?: number;
    compactionStrategy?: string;
    notes?: string;
}

export interface LayerBuildResult {
    layer: ContextLayer;
    resources?: ContextResourceRef[];
    diagnostics?: LayerBuildDiagnostics;
}

export interface ContextLayerBuilder {
    stage: Extract<ContextLayerKind, 'core' | 'catalog' | 'active'>;
    build(
        input: LayerInputContext,
        options?: LayerBuildOptions,
    ): Promise<LayerBuildResult>;
}

export interface PackAssemblyStep {
    builder: ContextLayerBuilder;
    description?: string;
}

/** Sum layer tokens into a `TokenBudget`. */
export function computeBudget(
    limit: number,
    layers: ContextLayer[],
): TokenBudget {
    return {
        limit,
        usage: layers.reduce((acc, layer) => acc + layer.tokens, 0),
        breakdown: layers.reduce<Record<string, number>>((acc, layer) => {
            acc[layer.kind] = layer.tokens;
            return acc;
        }, {}),
    };
}

/** Deterministic sha256 over the id-sorted requirements. */
export function computeRequirementsHash(
    requirements: ContextRequirement[],
): string {
    const sorted = [...requirements].sort((a, b) => a.id.localeCompare(b.id));
    return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Build a revision-log entry. */
export function createRevisionEntry(params: {
    revisionId: string;
    parentRevisionId?: string;
    scope: ContextRevisionScope;
    entityType: string;
    entityId: string;
    payload?: Record<string, unknown>;
    requirements?: ContextRequirement[];
    origin?: ContextRevisionActor;
    knowledgeRefs?: ContextRevisionLogEntry['knowledgeRefs'];
    metadata?: Record<string, unknown>;
}): ContextRevisionLogEntry {
    const payload =
        params.payload ??
        (params.requirements ? { requirements: params.requirements } : {});
    return {
        revisionId: params.revisionId,
        parentRevisionId: params.parentRevisionId,
        scope: params.scope,
        entityType: params.entityType,
        entityId: params.entityId,
        payload,
        requirements: params.requirements,
        origin: params.origin,
        createdAt: Date.now(),
        knowledgeRefs: params.knowledgeRefs,
        metadata: params.metadata,
    };
}

/**
 * Sequential pack-assembly pipeline. Runs each step's builder, collects the
 * layers/resources, and wraps them into a `ContextPack` with a computed budget.
 */
export class SequentialPackAssemblyPipeline {
    private readonly steps: PackAssemblyStep[];
    private readonly packIdFactory?: (input: LayerInputContext) => string;
    private readonly versionFactory: () => string;
    private readonly createdBy: string;

    constructor(config: {
        steps: PackAssemblyStep[];
        packIdFactory?: (input: LayerInputContext) => string;
        versionFactory?: () => string;
        createdBy?: string;
    }) {
        this.steps = config.steps;
        this.packIdFactory = config.packIdFactory;
        this.versionFactory =
            config.versionFactory ?? (() => new Date().toISOString());
        this.createdBy = config.createdBy ?? 'context-os';
    }

    async execute(
        input: LayerInputContext,
        options?: LayerBuildOptions,
    ): Promise<{
        pack: ContextPack;
        resources: ContextResourceRef[];
        diagnostics?: Record<string, unknown>;
    }> {
        const layers: ContextLayer[] = [];
        const resources: ContextResourceRef[] = [];
        const diagnostics: { steps: unknown[] } = { steps: [] };

        for (const step of this.steps) {
            const result = await step.builder.build(input, options);
            layers.push(result.layer);
            resources.push(...(result.resources ?? []));
            diagnostics.steps.push({
                stage: step.builder.stage,
                description: step.description,
                layerTokens: result.layer.tokens,
                diagnostics: result.diagnostics,
            });
        }

        const queryMetadata = (input.metadata?.query ?? {}) as {
            constraints?: ContextPack['constraints'];
        };

        const pack: ContextPack = {
            id: this.packIdFactory?.(input) ?? randomUUID(),
            domain: input.domain,
            version: this.versionFactory(),
            createdAt: Date.now(),
            createdBy: this.createdBy,
            budget: computeBudget(options?.maxTokens ?? 8192, layers),
            layers,
            provenance: [],
            constraints: queryMetadata.constraints,
            resources,
            metadata: {
                diagnosticSummary: diagnostics,
                taskIntent: input.taskIntent,
            },
        };

        return { pack, resources, diagnostics };
    }
}
