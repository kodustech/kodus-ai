/**
 * RoutingStrategy — the task→model resolver seam (Phase 4, plan 04-01).
 *
 * Greenfield (grep=0 before this plan): there was no task dimension in routing —
 * only `{main,fallback}` + a single `byokModel` name-override applied inline at
 * the pipeline stages. This interface centralizes task→model resolution so the
 * future Auto router (dynamic, stats-aware) drops in as a second strategy without
 * reshaping config or the executor.
 *
 * `StaticTaskStrategy` is strategy #1 (Manual policy). `stats` is a RESERVED slot:
 * declared so the Auto router lands without an interface change, but NOT populated
 * in v1 (RFC §4.2; router telemetry is Phase 5).
 *
 * Lives in libs/llm next to `getBYOKConfig`/`normalizeByokConfig` — routing is a
 * resolver-layer concern, never smeared across pipeline stages.
 */
import type { BYOKConfigV2, LlmTask } from './byok-config';

/**
 * Per-request routing inputs the resolver reads BESIDES the stored config.
 *  - `override`: a folder/repo model override (top of the precedence chain). Its
 *    `modelId` may be a v2 `models[]` id OR a legacy model NAME — see the
 *    id-THEN-name contract in StaticTaskStrategy (REQ-COMPAT-01 read window).
 *  - `parentTask`/`parentModelId`: an internal helper call under BYOK inherits
 *    the parent task's already-resolved model instead of re-resolving.
 */
export interface RequestContext {
    override?: { modelId?: string };
    parentTask?: LlmTask;
    parentModelId?: string;
}

/**
 * Runtime stats slot for the future Auto router (rpm/tpm/latency/health).
 * RESERVED and unused in v1 — declared so the Auto strategy lands without an
 * interface change (RFC §4.2). Do NOT populate in Phase 4.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ModelRuntimeStats {}

/**
 * The resolver verdict.
 *  - `modelId`: the chosen v2 `models[]` id, or `null` when the resolve is
 *    BLOCKED (no candidate satisfied the task's capability requirement).
 *  - `reason`: a machine/human-readable trace (which tier, which model, which
 *    missing capability). NEVER contains key material.
 *  - `modelName`: set ONLY for a legacy NAME override (id-THEN-name, W1) — the
 *    effective model name to apply onto the chosen slot's `.model`. The chosen
 *    slot supplies the credential; this overrides just the model string,
 *    mirroring the legacy `byokModel`-onto-`.main` behavior (REQ-COMPAT-01).
 */
export interface RoutingVerdict {
    modelId: string | null;
    reason: string;
    modelName?: string;
}

/**
 * A task→model routing strategy. `StaticTaskStrategy` = Manual; the future Auto
 * router = strategy #2 (same signature, reads `stats`).
 */
export interface RoutingStrategy {
    resolve(
        task: LlmTask,
        ctx: RequestContext,
        config: BYOKConfigV2,
        stats?: ModelRuntimeStats,
    ): RoutingVerdict;
}
