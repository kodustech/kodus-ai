import { createLogger } from '@kodus/flow';
import { SimpleLogger } from '@kodus/flow/dist/observability/logger';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as React from 'react';

import { EmailFrom, formatFromAddress } from '../from';
import ConfirmationEmail, {
    confirmationEmailMeta,
} from '../templates/confirmation';
import DomainVerificationEmail, {
    domainVerificationEmailMeta,
} from '../templates/domain-verification';
import ForgotPasswordEmail, {
    forgotPasswordEmailMeta,
} from '../templates/forgot-password';
import InviteEmail, { inviteEmailMeta } from '../templates/invite';
import KodyRulesEmail, { kodyRulesEmailMeta } from '../templates/kody-rules';
import WeeklyRecapEmail, {
    type WeeklyRecapEmailProps,
    weeklyRecapEmailMeta,
} from '../templates/weekly-recap';
import { ResendClientProvider } from './resend.client';

type SendInput = {
    from: EmailFrom;
    subject: string;
    to: string;
    react: React.ReactElement;
    replyTo?: string;
};

const REQUIRED_ENV = 'API_USER_INVITE_BASE_URL';

@Injectable()
export class EmailService {
    private readonly logger = createLogger(EmailService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly resendClient: ResendClientProvider,
    ) {}

    async sendForgotPasswordEmail(
        email: string,
        _name: string,
        token: string,
        logger?: SimpleLogger,
    ) {
        try {
            const webUrl = this.getRequiredString(REQUIRED_ENV);
            const resetLink = `${webUrl}/forgot-password/reset?token=${token}`;

            return await this.send({
                ...forgotPasswordEmailMeta,
                to: email,
                react: ForgotPasswordEmail({ resetLink }),
            });
        } catch (error) {
            this.logFailure(
                logger,
                `Error in sendForgotPasswordEmail for ${email}`,
                error,
                { email },
            );
        }
    }

    async sendConfirmationEmail(
        token: string,
        email: string,
        organizationName: string,
        organizationAndTeamData?: { organizationId?: string; teamId?: string },
        logger?: SimpleLogger,
    ) {
        try {
            const webUrl = this.getRequiredString(REQUIRED_ENV);
            const confirmLink = `${webUrl}/confirm-email?token=${token}`;

            return await this.send({
                ...confirmationEmailMeta,
                to: email,
                react: ConfirmationEmail({ organizationName, confirmLink }),
            });
        } catch (error) {
            this.logFailure(
                logger,
                `Error in sendConfirmationEmail for user ${email}`,
                error,
                { email, organizationName, organizationAndTeamData },
            );
        }
    }

    async sendInvite(
        user: any,
        adminUserEmail: string,
        invite: string,
        logger?: SimpleLogger,
    ) {
        try {
            const teamMember = user?.teamMember?.[0];
            const teamName = teamMember?.team?.name ?? 'your team';
            const inviteeName = teamMember?.name ?? user?.email ?? 'there';
            const organizationName =
                user?.organization?.name ?? 'your organization';

            const meta = inviteEmailMeta({ teamName });

            return await this.send({
                ...meta,
                to: user.email,
                replyTo: adminUserEmail,
                react: InviteEmail({
                    inviteeName,
                    inviterEmail: adminUserEmail,
                    organizationName,
                    teamName,
                    inviteLink: invite,
                }),
            });
        } catch (error) {
            this.logFailure(
                logger,
                `Error in sendInvite for user ${user?.email}`,
                error,
                {
                    userEmail: user?.email,
                    adminUserEmail,
                    organizationName: user?.organization?.name,
                },
            );
        }
    }

    async sendKodyRulesNotification(
        users: Array<{ email: string; name: string }>,
        rules: string[],
        organizationName: string,
        logger?: SimpleLogger,
    ) {
        const webUrl = this.getRequiredString(REQUIRED_ENV);
        const rulesLink = `${webUrl}/library/kody-rules`;
        const limitedRules = rules.slice(0, 3);
        const meta = kodyRulesEmailMeta({ organizationName });
        const rulesCount = rules.length;

        const results = await Promise.allSettled(
            users.map((user) =>
                this.send({
                    ...meta,
                    to: user.email,
                    react: KodyRulesEmail({
                        userName: user.name,
                        organizationName,
                        rules: limitedRules,
                        rulesCount,
                        rulesLink,
                    }),
                }),
            ),
        );

        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
            this.logFailure(
                logger,
                `sendKodyRulesNotification: ${failures.length} of ${users.length} failed for ${organizationName}`,
                (failures[0] as PromiseRejectedResult).reason,
                {
                    organizationName,
                    usersCount: users.length,
                    failureCount: failures.length,
                },
            );
        }

        return results;
    }

    async sendWeeklyRecap(
        recipient: { email: string; name: string },
        props: Omit<WeeklyRecapEmailProps, 'devName'>,
        logger?: SimpleLogger,
    ) {
        try {
            const meta = weeklyRecapEmailMeta({
                kodySuggestions: props.kodySuggestions,
                criticalIssues: props.criticalIssues,
            });
            return await this.send({
                ...meta,
                to: recipient.email,
                react: WeeklyRecapEmail({
                    ...props,
                    devName: recipient.name,
                }),
            });
        } catch (error) {
            this.logFailure(
                logger,
                `Error in sendWeeklyRecap for ${recipient.email}`,
                error,
                {
                    email: recipient.email,
                    company: props.company,
                    startDate: props.startDate,
                    endDate: props.endDate,
                },
            );
        }
    }

    async createContact(
        input: { email: string; name?: string },
        logger?: SimpleLogger,
    ) {
        const { firstName, lastName } = splitName(input.name);

        try {
            const client = this.resendClient.getClient();
            const { data, error } = await client.contacts.create({
                email: input.email,
                firstName,
                lastName,
                unsubscribed: false,
            });

            if (error) {
                throw new Error(
                    `Resend contacts.create failed: ${
                        error.name ?? 'unknown'
                    } — ${error.message ?? 'no message'}`,
                );
            }

            return data;
        } catch (error) {
            this.logFailure(
                logger,
                `Error creating Resend contact for ${input.email}`,
                error,
                { email: input.email },
            );
        }
    }

    async sendDomainVerificationEmail(
        token: string,
        email: string,
        organizationName: string,
        domain: string,
        logger?: SimpleLogger,
    ) {
        try {
            const webUrl = this.getRequiredString(REQUIRED_ENV);
            const confirmLink = `${webUrl}/organization/sso?domainVerificationToken=${token}`;
            const meta = domainVerificationEmailMeta({ domain });

            return await this.send({
                ...meta,
                to: email,
                react: DomainVerificationEmail({
                    organizationName,
                    domain,
                    confirmLink,
                }),
            });
        } catch (error) {
            this.logFailure(
                logger,
                `Error in sendDomainVerificationEmail for ${email}`,
                error,
                { email, organizationName, domain },
            );
        }
    }

    private async send(input: SendInput) {
        const client = this.resendClient.getClient();
        const { data, error } = await client.emails.send({
            from: formatFromAddress(input.from),
            to: [input.to],
            subject: input.subject,
            react: input.react,
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        });

        if (error) {
            throw new Error(
                `Resend send failed: ${error.name ?? 'unknown'} — ${
                    error.message ?? 'no message'
                }`,
            );
        }

        return data;
    }

    private getRequiredString(envKey: string): string {
        const value = this.configService.get<string>(envKey);
        if (!value) {
            throw new Error(`${envKey} is not set`);
        }
        return value;
    }

    private logFailure(
        logger: SimpleLogger | undefined,
        message: string,
        error: unknown,
        metadata: Record<string, unknown>,
    ) {
        const err =
            error instanceof Error ? error : new Error(String(error));
        const target = logger ?? this.logger;
        target.error({
            message,
            error: err,
            context: EmailService.name,
            metadata,
        });
    }
}

function splitName(name?: string): { firstName?: string; lastName?: string } {
    const trimmed = name?.trim();
    if (!trimmed) return {};
    const parts = trimmed.split(/\s+/);
    const [firstName, ...rest] = parts;
    return {
        firstName,
        lastName: rest.length ? rest.join(' ') : undefined,
    };
}
