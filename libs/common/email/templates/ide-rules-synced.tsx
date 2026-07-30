import * as React from 'react';
import { Button, Heading, Section, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import {
    BrandLayout,
    baseButton,
    baseHeading,
    baseText,
    mutedText,
} from './_layout';

export type IdeRulesSyncedEmailProps = {
    repoName: string;
    rulesCount: number;
    rulesLink: string;
};

export const ideRulesSyncedEmailMeta = (params: { repoName: string }) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `IDE rules synced — ${params.repoName}`,
});

function IdeRulesSyncedEmail({
    repoName,
    rulesCount,
    rulesLink,
}: IdeRulesSyncedEmailProps) {
    return (
        <BrandLayout
            preview={`Synced ${rulesCount} ${rulesCount === 1 ? 'rule' : 'rules'} from ${repoName}`}>
            <Heading style={baseHeading}>IDE rules synced</Heading>
            <Text style={baseText}>
                Kody synced <strong>{rulesCount}</strong>{' '}
                {rulesCount === 1 ? 'rule' : 'rules'} from{' '}
                <strong>{repoName}</strong> into your Kody Rules.
            </Text>
            <Section style={{ margin: '24px 0' }}>
                <Button href={rulesLink} style={baseButton}>
                    View Kody Rules
                </Button>
            </Section>
            <Text style={mutedText}>
                Manage IDE-sync notifications in your notification settings.
            </Text>
        </BrandLayout>
    );
}

IdeRulesSyncedEmail.PreviewProps = {
    repoName: 'acme/api',
    rulesCount: 12,
    rulesLink: 'https://app.kodus.io/settings/code-review/global/kody-rules',
} satisfies IdeRulesSyncedEmailProps;

export default IdeRulesSyncedEmail;
