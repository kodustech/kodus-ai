import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import {
    IContributingSuggestion,
    IRepositoryToIssues,
} from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { LabelType } from '@libs/common/utils/codeManagement/labels';

@Schema({
    collection: 'issues',
    timestamps: true,
    autoIndex: true,
})
export class IssuesModel extends CoreDocument {
    @Prop({ type: String, required: true })
    public title: string;

    @Prop({ type: String, required: true })
    public description: string;

    @Prop({ type: String, required: true })
    public filePath: string;

    @Prop({ type: String, required: true })
    public language: string;

    @Prop({ type: String, required: true })
    public label: LabelType;

    @Prop({ type: String, required: true })
    public severity: SeverityLevel;

    @Prop({ type: String, required: true })
    public status: IssueStatus;

    @Prop({ type: Object, required: true })
    public contributingSuggestions: IContributingSuggestion[];

    @Prop({ type: Object, required: true })
    public repository: IRepositoryToIssues;

    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: Object, required: false })
    public owner?: {
        gitId: string;
        username: string;
    };

    @Prop({ type: Object, required: false })
    public reporter?: {
        gitId: string;
        username: string;
    };
}

export const IssuesSchema = SchemaFactory.createForClass(IssuesModel);

// 1. Main - organization + status open
IssuesSchema.index(
    { organizationId: 1, createdAt: -1 },
    {
        partialFilterExpression: { status: 'open' },
        name: 'organization_open',
    },
);

// 2. By repository
IssuesSchema.index(
    { 'organizationId': 1, 'repository.name': 1, 'createdAt': -1 },
    {
        partialFilterExpression: { status: 'open' },
        name: 'organization_repository_open',
    },
);

// 3. Severity high or critical
IssuesSchema.index(
    { organizationId: 1, severity: 1, createdAt: -1 },
    {
        partialFilterExpression: {
            status: 'open',
            severity: { $in: ['critical', 'high'] },
        },
        name: 'organization_severity_high_critical_open',
    },
);

// 4. By label + severity
IssuesSchema.index(
    { organizationId: 1, label: 1, severity: 1, createdAt: -1 },
    {
        partialFilterExpression: { status: 'open' },
        name: 'organization_label_severity_open',
    },
);

// 5. By org/repository, any status. Every index above is partial on
// `status: 'open'`, so reads that don't filter by status (IssuesRepository.find,
// the KODUS_LIST_KODY_ISSUES MCP tool) fell back to a full collection scan.
IssuesSchema.index(
    { 'organizationId': 1, 'repository.name': 1 },
    { name: 'organization_repository_any_status', background: true },
);
