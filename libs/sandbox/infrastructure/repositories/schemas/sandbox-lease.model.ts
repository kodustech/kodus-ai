import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';

// Regex extracted to a module-level const so its inferred type doesn't blow
// past TS's max serialized-type length when used inside a @Prop decorator.
const PR_KEY_REGEX: RegExp =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[^:]+:[^:]+(:[^:]+)?$/i;

/**
 * Mongoose schema for the sandbox_leases collection.
 *
 * Each document represents a coordination lease for a single PR (keyed by prKey).
 * The _id IS the prKey string — Mongo's natural uniqueness guarantee serves as the
 * upsert filter for the atomic acquire operation (see sandbox-lease.repository.ts).
 *
 * Do NOT use a MongoDB TTL index (expireAfterSeconds) — the reaper must call
 * Sandbox.kill() before deleting the doc so that orphaned E2B sandboxes are
 * cleaned up properly.
 */
@Schema({ collection: 'sandbox_leases', timestamps: false })
export class SandboxLeaseModel extends CoreDocument {
    // prKey: "{orgId}:{repoId}:{prNumber}" — used as the document _id.
    // SECURITY: regex enforces that the first segment is a UUID (the
    // organizationId) so a malformed prKey can never reach Mongo. A doc
    // that fails this match throws on save, breaking the upsertAcquire
    // call instead of silently creating a poisoned lease.
    @Prop({
        type: String,
        required: true,
        match: PR_KEY_REGEX,
    })
    declare _id: string;

    @Prop({ type: String, required: false })
    sandboxId?: string; // E2B sandbox ID; null while state === 'CREATING'

    // Decomposed prKey fields — populated on insert via $setOnInsert. Stored
    // explicitly (not derived from _id) so dashboards, audit queries, and
    // log filters can read the doc without parsing the composite _id string.
    @Prop({ type: String, required: false, index: true })
    organizationId?: string;

    @Prop({ type: String, required: false })
    repositoryId?: string;

    @Prop({ type: String, required: false })
    prNumber?: string;

    @Prop({ type: String, required: false })
    consumer?: string; // Last consumer label ('review' | 'conversation')

    /**
     * State enum. INVALIDATED is required to handle the mid-create invalidation
     * race (RESEARCH.md Pitfall 5): when a force-push/pr-close event fires while
     * acquire() is still in-flight (state = CREATING), invalidate() sets this to
     * INVALIDATED instead of deleting the doc. The create path checks for this
     * state after updateReady() and immediately kills the sandbox, preventing
     * orphaned E2B sandboxes with no Mongo lease document.
     */
    @Prop({
        type: String,
        required: true,
        enum: ['CREATING', 'READY', 'PAUSED', 'INVALIDATED'],
    })
    state: string;

    @Prop({ type: Number, required: true, default: 0 })
    leaseCount: number; // ref-count of active leases

    @Prop({ type: Date, required: true })
    createdAt: Date;

    @Prop({ type: Date, required: true })
    expiresAt: Date; // used by reaper TTL query

    /**
     * Idle-kill timestamp. When the last lease is released, the manager sets
     * this to `now + idleMs` (30s for review, 5min for conversation). The
     * idle-kill cron picks up docs where `killAt <= now` and kills the
     * sandbox + deletes the doc. Acquire clears this atomically when warm-
     * resume happens (any worker), so the value is multi-worker safe — no
     * in-memory state required.
     */
    @Prop({ type: Date, required: false })
    killAt?: Date;
}

// Explicit type annotation: with the killAt field added the inferred type
// from SchemaFactory blows past TS's max serialized-type length (TS7056).
export const SandboxLeaseSchema: MongooseSchema<SandboxLeaseModel> =
    SchemaFactory.createForClass(SandboxLeaseModel);

// Reaper range scan: find all leases past their expiry regardless of state
SandboxLeaseSchema.index({ expiresAt: 1 });

// Invalidate-by-sandboxId when prKey is unknown (sparse: unused entries have no entry)
SandboxLeaseSchema.index({ sandboxId: 1 }, { sparse: true });

// Tenant scoping for dashboards / audit queries ("all leases of org X")
SandboxLeaseSchema.index({ organizationId: 1, repositoryId: 1 });

// Idle-kill cron query: find docs ready to be killed (killAt <= now AND
// sandboxId set). Sparse so docs without killAt aren't indexed.
SandboxLeaseSchema.index({ killAt: 1, sandboxId: 1 }, { sparse: true });
