import * as React from 'react';
import { Heading, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type IdeRulesSyncFailedEmailProps = {
    repoName: string;
    reason: string;
    correlationId: string;
};

export const ideRulesSyncFailedEmailMeta = (params: { repoName: string }) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `IDE rule sync failed — ${params.repoName}`,
});

function IdeRulesSyncFailedEmail({
    repoName,
    reason,
    correlationId,
}: IdeRulesSyncFailedEmailProps) {
    return (
        <BrandLayout preview={`Kody could not sync IDE rules in ${repoName}`}>
            <Heading style={baseHeading}>IDE rule sync failed</Heading>
            <Text style={baseText}>
                Kody could not finish syncing IDE rules from{' '}
                <strong>{repoName}</strong>.
            </Text>
            <Text style={baseText}>
                <strong>Reason:</strong> {reason}
            </Text>
            <Text style={mutedText}>
                You can retry the sync from your repository settings. If this
                persists, share this reference with support:{' '}
                <code>{correlationId}</code>.
            </Text>
        </BrandLayout>
    );
}

IdeRulesSyncFailedEmail.PreviewProps = {
    repoName: 'acme/api',
    reason: 'Failed to fetch .kody-rules/ from default branch',
    correlationId: 'sync-9505e80b-e6df-42f9',
} satisfies IdeRulesSyncFailedEmailProps;

export default IdeRulesSyncFailedEmail;
