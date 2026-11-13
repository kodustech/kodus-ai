import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

import {
    ScanReportedFinding,
    ScanUnit,
    ScanUnitProgress,
    SecurityScanBudget,
    SecurityScanCoverage,
    SecurityScanOutcomeCounts,
    SecurityScanSpend,
    SecurityScanStatus,
} from '../domain/security-scan.types';

@Schema({ collection: 'security_scans', timestamps: true, autoIndex: true })
export class SecurityScanModel extends CoreDocument {
    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: String, required: true })
    public teamId: string;

    @Prop({ type: Object, required: true })
    public repository: {
        id: string;
        name: string;
        fullName: string;
        platform: string;
        defaultBranch: string;
    };

    @Prop({
        type: String,
        required: true,
        enum: Object.values(SecurityScanStatus),
    })
    public status: SecurityScanStatus;

    /** Empty when the scan runs without a limit. */
    @Prop({ type: Object, default: {} })
    public budget: SecurityScanBudget;

    @Prop({ type: Object, required: true })
    public spend: SecurityScanSpend;

    @Prop({ type: String })
    public commitSha?: string;

    @Prop({ type: String })
    public planCommitSha?: string;

    @Prop({ type: [Object], default: [] })
    public units: ScanUnit[];

    @Prop({ type: [Object], default: [] })
    public progress: ScanUnitProgress[];

    @Prop({ type: [Object], default: [] })
    public reported: ScanReportedFinding[];

    @Prop({ type: Object })
    public coverage?: SecurityScanCoverage;

    @Prop({ type: Object })
    public outcome?: SecurityScanOutcomeCounts;

    @Prop({ type: String })
    public modelName?: string;

    @Prop({ type: Object })
    public requestedBy?: { userId?: string; email?: string };

    @Prop({ type: String })
    public error?: string;

    @Prop({ type: String })
    public startedAt?: string;

    @Prop({ type: String })
    public finishedAt?: string;

    /** `organization:repository` while the scan is queued or running, unset
     *  once it ends: the unique index below allows one active scan per
     *  repository, whatever two requests race. */
    @Prop({ type: String })
    public activeKey?: string;

    /**
     * The job running the scan, and until when its claim holds: two jobs of
     * one scan (a redelivered one beside its continuation) never run at once.
     */
    @Prop({ type: String })
    public runningJobId?: string;

    @Prop({ type: Date })
    public leaseExpiresAt?: Date;
}

export const SecurityScanSchema =
    SchemaFactory.createForClass(SecurityScanModel);

SecurityScanSchema.index(
    { 'organizationId': 1, 'repository.id': 1, 'createdAt': -1 },
    { name: 'organization_repository_recent' },
);

SecurityScanSchema.index(
    { activeKey: 1 },
    {
        name: 'one_active_scan_per_repository',
        unique: true,
        partialFilterExpression: { activeKey: { $exists: true } },
    },
);
