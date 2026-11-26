import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { RELEASE_INDEX } from '@libs/core/infrastructure/database/mongo/release-indexes/release-index-definitions';

/**
 * What the last scan to read a file for a class concluded, tied to the blobs
 * it read (CoverageEntry): one document per repository, file and class.
 */
@Schema({ collection: 'security_scan_coverage', timestamps: true })
export class SecurityScanCoverageModel extends CoreDocument {
    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: Object, required: true })
    public repository: { platform: string; host: string; id: string };

    @Prop({ type: String, required: true })
    public filePath: string;

    @Prop({ type: String, required: true })
    public vulnerabilityClass: string;

    @Prop({ type: String, required: true })
    public blob: string;

    @Prop({ type: [Object], default: [] })
    public evidence: Array<{ file: string; blob: string }>;

    /** The class was assigned but not read to the end: it never holds. */
    @Prop({ type: Boolean, default: false })
    public incomplete?: boolean;

    @Prop({ type: String })
    public scanId?: string;

    @Prop({ type: String })
    public commitSha?: string;

    @Prop({ type: String })
    public modelName?: string;

    @Prop({ type: String })
    public examinedAt?: string;
}

export const SecurityScanCoverageSchema = SchemaFactory.createForClass(
    SecurityScanCoverageModel,
);

SecurityScanCoverageSchema.index(
    RELEASE_INDEX.scanCoveragePerArea.key,
    RELEASE_INDEX.scanCoveragePerArea.options,
);
