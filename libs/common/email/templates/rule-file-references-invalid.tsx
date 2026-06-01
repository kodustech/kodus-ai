import * as React from 'react';
import { Heading, Section, Text } from 'react-email';

import { EMAIL_FROM } from '../from';
import { BrandLayout, baseHeading, baseText, mutedText } from './_layout';

export type RuleFileReferencesInvalidEmailProps = {
    repoName: string;
    invalidCount: number;
    issues: Array<{
        ruleName: string;
        filePath: string;
        reason: string;
    }>;
};

export const ruleFileReferencesInvalidEmailMeta = (params: {
    repoName: string;
    invalidCount: number;
}) => ({
    from: EMAIL_FROM.NOTIFICATIONS,
    subject: `${params.invalidCount} Kody ${
        params.invalidCount === 1 ? 'rule has' : 'rules have'
    } broken file references — ${params.repoName}`,
});

function RuleFileReferencesInvalidEmail({
    repoName,
    invalidCount,
    issues,
}: RuleFileReferencesInvalidEmailProps) {
    const displayedIssues = issues.slice(0, 10);
    const overflowCount = issues.length - displayedIssues.length;

    return (
        <BrandLayout
            preview={`${invalidCount} ${
                invalidCount === 1 ? 'rule has' : 'rules have'
            } a broken file reference in ${repoName}.`}>
            <Heading style={baseHeading}>
                Kody rule file references are broken
            </Heading>
            <Text style={baseText}>
                <strong>{invalidCount}</strong>{' '}
                {invalidCount === 1 ? 'rule' : 'rules'} in{' '}
                <strong>{repoName}</strong> reference a file that no longer
                exists or no longer matches. Affected rules are skipped
                during code review until you fix or remove the reference.
            </Text>
            <Section style={{ margin: '16px 0' }}>
                {displayedIssues.map((issue, i) => (
                    <Text key={i} style={baseText}>
                        <strong>{issue.ruleName}</strong> →{' '}
                        <code>{issue.filePath}</code>
                        <br />
                        <span style={mutedText}>{issue.reason}</span>
                    </Text>
                ))}
                {overflowCount > 0 ? (
                    <Text style={mutedText}>
                        …and {overflowCount} more.
                    </Text>
                ) : null}
            </Section>
            <Text style={mutedText}>
                You can edit the rule&apos;s file path in the Kody Rules
                settings, or remove the rule if it&apos;s no longer
                relevant.
            </Text>
        </BrandLayout>
    );
}

RuleFileReferencesInvalidEmail.PreviewProps = {
    repoName: 'acme/api',
    invalidCount: 3,
    issues: [
        {
            ruleName: 'No console.log in production',
            filePath: 'src/logger.ts',
            reason: 'File not found in repository',
        },
    ],
} satisfies RuleFileReferencesInvalidEmailProps;

export default RuleFileReferencesInvalidEmail;
