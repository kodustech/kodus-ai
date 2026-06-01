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

export type KodyRulesEmailProps = {
    userName: string;
    organizationName: string;
    rules: string[];
    rulesCount: number;
    rulesLink: string;
};

export function kodyRulesEmailMeta({
    organizationName,
}: {
    organizationName: string;
}) {
    return {
        from: EMAIL_FROM.NOTIFICATIONS,
        subject: `New Kody Rules generated for ${organizationName}`,
    };
}

const ruleItem: React.CSSProperties = {
    backgroundColor: '#F9FAFB',
    borderLeft: '3px solid #f8b76d',
    borderRadius: 4,
    color: '#1F2937',
    fontSize: 14,
    lineHeight: '20px',
    margin: '0 0 8px',
    padding: '12px 14px',
};

function KodyRulesEmail({
    userName,
    organizationName,
    rules,
    rulesCount,
    rulesLink,
}: KodyRulesEmailProps) {
    const visibleRules = rules.slice(0, 3);
    const remaining = Math.max(rulesCount - visibleRules.length, 0);

    return (
        <BrandLayout
            preview={`${rulesCount} new Kody Rule${
                rulesCount === 1 ? '' : 's'
            } for ${organizationName}`}
        >
            <Heading style={baseHeading}>New Kody Rules are ready</Heading>
            <Text style={baseText}>Hi {userName},</Text>
            <Text style={baseText}>
                We just generated{' '}
                <strong>
                    {rulesCount} new rule{rulesCount === 1 ? '' : 's'}
                </strong>{' '}
                for <strong>{organizationName}</strong> based on recent code
                review activity.
            </Text>
            <Section style={{ margin: '16px 0' }}>
                {visibleRules.map((rule, index) => (
                    <Text key={index} style={ruleItem}>
                        {rule}
                    </Text>
                ))}
            </Section>
            {remaining > 0 ? (
                <Text style={mutedText}>
                    + {remaining} more — review the full list in Kodus.
                </Text>
            ) : null}
            <Section style={{ margin: '24px 0 0' }}>
                <Button href={rulesLink} style={baseButton}>
                    View Kody Rules
                </Button>
            </Section>
        </BrandLayout>
    );
}

KodyRulesEmail.PreviewProps = {
    userName: 'Sam',
    organizationName: 'Acme Inc',
    rules: [
        'All public methods must have unit tests covering happy path and edge cases.',
        'API endpoints must include OpenAPI/Swagger documentation with request/response examples.',
        'Avoid logging PII (emails, names, tokens) in info/debug levels.',
        'Wrap async operations in try/catch and surface meaningful error messages.',
    ],
    rulesCount: 4,
    rulesLink: 'https://app.kodus.io/library/kody-rules',
} satisfies KodyRulesEmailProps;

export default KodyRulesEmail;
