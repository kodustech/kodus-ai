import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * One document per organization and Git host: what the egress probe found
 * when it listed that host's repository WITHOUT the egress proxy.
 * `_id` is `<organizationId>:<host>`. No credential is ever stored.
 */
@Schema({ collection: 'sandbox_egress_probes', timestamps: true })
export class SandboxEgressProbeModel extends Document<string> {
    @Prop({ type: String, required: true })
    declare _id: string;

    @Prop({ type: String, required: true, index: true })
    organizationId: string;

    @Prop({ type: String, required: false })
    teamId?: string;

    @Prop({ type: String, required: true })
    host: string;

    @Prop({ type: String, required: true })
    platform: string;

    /** When a worker last took the right to probe this org/host. */
    @Prop({ type: Date, required: false })
    lastClaimedAt?: Date;

    @Prop({ type: Date, required: false })
    lastProbedAt?: Date;

    /** `direct_ok` | `direct_blocked`. */
    @Prop({ type: String, required: false, index: true })
    lastOutcome?: string;

    @Prop({ type: String, required: false })
    lastReason?: string;

    /** First lines of git's error, with secrets removed. */
    @Prop({ type: String, required: false })
    lastDetail?: string;

    @Prop({ type: Number, required: false })
    lastExitCode?: number;

    @Prop({ type: Number, default: 0 })
    okCount: number;

    @Prop({ type: Number, default: 0 })
    blockedCount: number;
}

export const SandboxEgressProbeSchema = SchemaFactory.createForClass(
    SandboxEgressProbeModel,
);
