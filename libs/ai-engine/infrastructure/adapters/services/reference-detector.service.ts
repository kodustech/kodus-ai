import { ContextDependency } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

import {
    IDetectedReference,
    IFileReference,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    prompt_detect_external_references_system,
    prompt_detect_external_references_user,
} from '@libs/common/utils/prompts/externalReferences';
import {
    prompt_kodyrules_detect_references_system,
    prompt_kodyrules_detect_references_user,
} from '@libs/common/utils/prompts/kodyRulesExternalReferences';
import { LLM_ENVELOPE_TAG } from '@libs/llm/log-tags';
import { normalizeEnvelope } from '@libs/llm/structured-output-repair';
import { getModelName, trialDefaultModel } from '@libs/llm/byok-to-vercel';
import { LLM } from '@libs/llm/llm';

/**
 * Kodus control markers are instructions to the sync engine, never file
 * references. They must be filtered from EVERY detection path — both the
 * regex marker extraction and the LLM-based detector (which happily
 * returns "@kody-sync" as a file); the miss on the LLM path kept stamping
 * spurious 'file not found: @kody-sync' sync errors on every rule synced
 * via the marker.
 */
const KODUS_CONTROL_MARKERS = new Set(['@kody-sync', '@kody-ignore']);

/**
 * Escapes every RegExp metacharacter so an arbitrary string can be embedded in
 * a `new RegExp(...)` as a literal. The previous inline version escaped only
 * `-`, `/` and `@` — none of which are special outside a character class —
 * while leaving the real metacharacters (`.`, `*`, `(`, `)`, `?`, …)
 * unescaped (CodeQL js/incomplete-sanitization). Harmless for the current
 * markers, but a foot-gun the moment a marker contains a metacharacter.
 */
export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes Kody control markers (@kody-sync/@kody-ignore) from free text so the
 * reference detector never sees them as content. Case-insensitive, every
 * occurrence, and safe for markers containing regex metacharacters.
 */
export function stripControlMarkers(text: string): string {
    return [...KODUS_CONTROL_MARKERS].reduce(
        (acc, marker) =>
            acc.replace(new RegExp(escapeRegExp(marker), 'gi'), ''),
        text,
    );
}

/** A reference carrying a control marker under any key, in any case. */
function hasControlMarker(ref: IDetectedReference): boolean {
    return Object.values(ref).some(isControlMarker);
}

/** The text inside a reply that is itself one JSON string ("\"[...]\""). */
function unquoteJsonString(raw: unknown): unknown {
    if (typeof raw !== 'string' || !raw.trim().startsWith('"')) return raw;
    try {
        const inner = JSON.parse(raw);
        return typeof inner === 'string' ? inner : raw;
    } catch {
        return raw;
    }
}

/**
 * The reference list in the detector's text reply: a bare array, or one
 * fenced, wrapped in prose, under a wrapper key, or a single reference sent
 * without the array. Only items naming a file are kept. Null when the reply
 * holds no list.
 */
function parseReferenceReply(
    raw: unknown,
    onRecover: (reason: string) => void,
): IDetectedReference[] | null {
    const opts = { liftEmptyArray: true, onRecover };
    let value = normalizeEnvelope(
        unquoteJsonString(raw),
        'items',
        ['references', 'refs', 'files'],
        opts,
    );
    // A provider response body written out as the text: read its content.
    const content = (
        value as { choices?: { message?: { content?: unknown } }[] }
    )?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
        onRecover('unwrapped-provider-envelope');
        value = normalizeEnvelope(
            unquoteJsonString(content),
            'items',
            ['references', 'refs', 'files'],
            opts,
        );
    }
    const isObject = (v: unknown): v is Record<string, unknown> =>
        !!v && typeof v === 'object' && !Array.isArray(v);
    let items: unknown;
    if (isObject(value) && Array.isArray(value.items)) {
        items = value.items;
    } else if (
        isObject(value) &&
        (typeof value.fileName === 'string' ||
            typeof value.filePath === 'string')
    ) {
        onRecover('lifted-single-reference');
        items = [value];
    } else {
        return null;
    }
    // Consumers read `fileName`; a reference that named its file only under
    // `filePath` carries it over.
    return (items as unknown[])
        .map((item) =>
            isObject(item) &&
            typeof item.fileName !== 'string' &&
            typeof item.filePath === 'string'
                ? { ...item, fileName: item.filePath }
                : item,
        )
        .filter(
            (item): item is IDetectedReference =>
                isObject(item) && typeof item.fileName === 'string',
        );
}

function isControlMarker(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    // Compare the BASENAME: the LLM detector emits the marker with a
    // fabricated repo prefix ("kody-sync/@kody-sync" — observed in
    // production sync errors), so an exact-string check misses it.
    const normalized = value.trim().toLowerCase().replace(/[.]+$/, '');
    const basename = normalized.split('/').pop() ?? normalized;
    return (
        KODUS_CONTROL_MARKERS.has(normalized) ||
        KODUS_CONTROL_MARKERS.has(basename)
    );
}

export interface DetectReferencesParams {
    requirementId: string;
    promptText: string;
    organizationAndTeamData: OrganizationAndTeamData;
    context?: 'rule' | 'instruction' | 'prompt';
    detectionMode?: 'rule' | 'prompt';
    byokConfig?: NormalizedModel;
    subscriptionStatus?: string;
}

@Injectable()
export class ReferenceDetectorService {
    private readonly logger = createLogger(ReferenceDetectorService.name);

    hasLikelyExternalReferences(promptText: string): boolean {
        const patterns = [
            /@file[:\s]/i,
            /\[\[file:/i,
            /@\w+\.(ts|js|py|md|yml|yaml|json|txt|go|java|cpp|c|h|rs)/i,
            /refer to.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /check.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /see.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /\b\w+\.\w+\.(ts|js|py|md|yml|yaml|json|txt)\b/i,
            /\b[A-Z_][A-Z0-9_]*\.(ts|js|py|md|yml|yaml|json|txt)\b/,
            /\b(readme|contributing|changelog|license|setup|config|package|tsconfig|jest\.config|vite\.config|webpack\.config)\.(md|json|yml|yaml|ts|js)\b/i,
        ];

        return patterns.some((pattern) => pattern.test(promptText));
    }

    /**
     * What a detection's answer depends on: the system prompt of its mode, the
     * context, and the text the model sees. Two calls with the same fingerprint
     * would send the model the same request, so the first answer can stand in
     * for the second. The prompt itself is part of it, so editing a detection
     * prompt invalidates every stored answer without a version to bump.
     */
    detectionFingerprint(
        params: Pick<
            DetectReferencesParams,
            'promptText' | 'detectionMode' | 'context'
        >,
    ): string {
        const isRuleMode = params.detectionMode === 'rule';
        const systemPrompt = isRuleMode
            ? prompt_kodyrules_detect_references_system()
            : prompt_detect_external_references_system();
        return createHash('sha256')
            .update(
                [
                    systemPrompt,
                    params.detectionMode ?? '',
                    params.context ?? '',
                    stripControlMarkers(params.promptText),
                ].join('\n\u0000\n'),
            )
            .digest('hex');
    }

    async detectReferences(
        params: DetectReferencesParams,
    ): Promise<IDetectedReference[]> {
        return (await this.detectReferencesWithStatus(params)).references;
    }

    /**
     * `reliable` is false when the model gave no usable answer (empty, or not a
     * JSON array). That `[]` means "could not tell", not "no references", and
     * must not be reused as if it were an answer.
     */
    async detectReferencesWithStatus(
        params: DetectReferencesParams,
    ): Promise<{ references: IDetectedReference[]; reliable: boolean }> {
        const { organizationAndTeamData } = params;

        // Trial-only override: on the 14-day trial with no BYOK key, route
        // reference detection through the Kodus-funded default so we don't burn
        // the production model on Kodus's dime. Off-trial → undefined (resolver
        // uses the production/env default). Any BYOK config still wins.
        const defaultModelOverride = trialDefaultModel({
            subscriptionStatus: params.subscriptionStatus,
        });

        // The caller passes the already-resolved slot.
        const byokSlot = params.byokConfig;
        const resolvedModelName = getModelName(byokSlot, defaultModelOverride);
        this.logger.log({
            message: `[REF-DETECTOR-DEBUG] Resolved model: ${resolvedModelName}`,
            context: ReferenceDetectorService.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                requirementId: params.requirementId,
                subscriptionStatus: params.subscriptionStatus,
                hasByok: !!byokSlot,
                byokMainProvider: byokSlot?.provider,
                byokMainModel: byokSlot?.model,
                defaultModelOverride,
                resolvedModelName,
            },
        });

        // Strip control markers from the text the model sees: with
        // "@kody-sync" in the rule body, the detector not only returned the
        // marker as a file but also CONTAMINATED real references with a
        // fabricated "kody-sync/" repo prefix (observed live:
        // "kody-sync/docs/contratos-de-api.md" in the UI error detail).
        const sanitizedPromptText = stripControlMarkers(params.promptText);

        const isRuleMode = params.detectionMode === 'rule';
        const systemPrompt = isRuleMode
            ? prompt_kodyrules_detect_references_system()
            : prompt_detect_external_references_system();
        const userPrompt = isRuleMode
            ? prompt_kodyrules_detect_references_user({
                  rule: sanitizedPromptText,
              })
            : prompt_detect_external_references_user({
                  text: sanitizedPromptText,
                  context: params.context,
              });

        // Run through the shared text executor (Porta 2): builds the same model
        // (slot, else the trial default), adds the BYOK limiter + the slot's
        // reasoning + a timeout, and preserves the telemetry. No observability
        // span here — this call never recorded one, so observabilityService is
        // omitted (the executor runs the call directly).
        const raw = await LLM.run({
            byokConfig: byokSlot,
            system: systemPrompt,
            user: userPrompt,
            runName: 'detectExternalReferences',
            defaultModelOverride,
            organizationId: organizationAndTeamData.organizationId,
            telemetryMetadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
        });
        const recoveries: string[] = [];
        const refs = parseReferenceReply(raw, (r) => recoveries.push(r));
        if (!refs) {
            this.logger.warn({
                message: `${LLM_ENVELOPE_TAG} reference detector reply has no reference list; nothing detected and the result is not cached`,
                context: ReferenceDetectorService.name,
                metadata: {
                    replyType: typeof raw,
                    replyLength: typeof raw === 'string' ? raw.length : 0,
                    organizationAndTeamData,
                    requirementId: params.requirementId,
                },
            });
            return { references: [], reliable: false };
        }
        if (recoveries.length > 0) {
            this.logger.warn({
                message: `${LLM_ENVELOPE_TAG} recovered an off-shape reference detector reply (${recoveries.join('+')})`,
                context: ReferenceDetectorService.name,
                metadata: {
                    reasons: recoveries,
                    organizationAndTeamData,
                    requirementId: params.requirementId,
                },
            });
        }
        const parsed = refs.filter((ref) => !hasControlMarker(ref));

        this.logger.debug({
            message: 'Detected external references',
            context: ReferenceDetectorService.name,
            metadata: {
                referencesCount: parsed.length,
                organizationAndTeamData,
                requirementId: params.requirementId,
            },
        });

        return { references: parsed, reliable: true };
    }

    extractMarkers(promptText: string, references: IFileReference[]): string[] {
        const markers = new Set<string>();

        for (const reference of references) {
            if (reference.originalText) {
                markers.add(reference.originalText);
            }
        }

        const fileRegex = /@[A-Za-z0-9/_\-.]+/g;
        const fileMatches = promptText.match(fileRegex);
        if (fileMatches) {
            fileMatches
                .filter((match) => !isControlMarker(match))
                .forEach((match) => markers.add(match));
        }

        // Detect MCP markers: @mcp<app|tool>
        const mcpRegex = /@mcp<([^|>]+)\|([^>]+)>/g;
        let mcpMatch;
        while ((mcpMatch = mcpRegex.exec(promptText)) !== null) {
            markers.add(mcpMatch[0]); // Add the full @mcp<app|tool> marker
        }

        return Array.from(markers.values());
    }

    extractMCPDependencies(
        text: string,
        repositoryId: string,
    ): ContextDependency[] {
        const mcpDependencies: ContextDependency[] = [];
        const mcpRegex = /@mcp<([^|>]+)\|([^>]+)>/g;
        let match;

        this.logger.debug({
            message: 'Extracting MCP dependencies from text',
            context: ReferenceDetectorService.name,
            metadata: {
                textLength: text.length,
                textSnippet: text.substring(0, 200),
                repositoryId,
            },
        });

        while ((match = mcpRegex.exec(text)) !== null) {
            const [fullMatch, app, tool] = match;
            this.logger.log({
                message: 'Found MCP dependency',
                context: ReferenceDetectorService.name,
                metadata: {
                    fullMatch,
                    app,
                    tool,
                    repositoryId,
                },
            });
            mcpDependencies.push({
                type: 'mcp',
                id: `${app}|${tool}`,
                metadata: {
                    app,
                    tool,
                    originalText: fullMatch,
                    repositoryId,
                    detectedAt: new Date().toISOString(),
                },
            });
        }

        this.logger.debug({
            message: 'MCP extraction completed',
            context: ReferenceDetectorService.name,
            metadata: {
                foundCount: mcpDependencies.length,
            },
        });

        return mcpDependencies;
    }
}
