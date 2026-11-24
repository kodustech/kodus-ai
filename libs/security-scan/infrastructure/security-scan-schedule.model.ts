import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { RELEASE_INDEX } from '@libs/core/infrastructure/database/mongo/release-indexes/release-index-definitions';

import type { SecurityScanBudget } from '../domain/security-scan.types';
import type { SecurityScanMode } from '../domain/coverage-ledger';
import type { ScanCadence, ScanExportTarget } from '../domain/scan-schedule';

/** A repository's deep scan schedule: one per repository. */
@Schema({ collection: 'security_scan_schedules', timestamps: true })
export class SecurityScanScheduleModel extends CoreDocument {
    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: String, required: true })
    public teamId: string;

    @Prop({ type: Object, required: true })
    public repository: { platform: string; host: string; id: string };

    @Prop({ type: String, required: true })
    public cadence: ScanCadence;

    @Prop({ type: Object, default: {} })
    public budget: SecurityScanBudget;

    @Prop({ type: String, default: 'incremental' })
    public mode: SecurityScanMode;

    @Prop({ type: String })
    public modelId?: string;

    @Prop({ type: Object })
    public exportTo?: ScanExportTarget;

    @Prop({ type: Boolean, default: true })
    public enabled: boolean;

    @Prop({ type: Date, required: true })
    public nextRunAt: Date;

    @Prop({ type: String })
    public lastRunAt?: string;

    @Prop({ type: String })
    public lastScanId?: string;

    @Prop({ type: String })
    public lastError?: string;

    @Prop({ type: Object })
    public createdBy?: { userId?: string; email?: string };
}

export const SecurityScanScheduleSchema = SchemaFactory.createForClass(
    SecurityScanScheduleModel,
);

SecurityScanScheduleSchema.index(
    RELEASE_INDEX.scanSchedulesDue.key,
    RELEASE_INDEX.scanSchedulesDue.options,
);
SecurityScanScheduleSchema.index(
    RELEASE_INDEX.oneScanSchedulePerRepository.key,
    RELEASE_INDEX.oneScanSchedulePerRepository.options,
);
