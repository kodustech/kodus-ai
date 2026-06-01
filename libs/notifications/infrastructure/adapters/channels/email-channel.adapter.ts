import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/render';

import { formatFromAddress } from '@libs/common/email/from';

import {
    IChannelAdapter,
    NotificationDeliveryContext,
} from '../../../domain/contracts/channel-adapter.contract';
import { NotificationChannel } from '../../../domain/enums/channel.enum';
import { NotificationEvent } from '../../../domain/catalog/events';
import {
    IEmailProvider,
    EMAIL_PROVIDER_TOKEN,
} from '../../adapters/email-providers/email-provider.contract';
import {
    EMAIL_TEMPLATE_REGISTRY,
    ResolvedEmailTemplate,
} from './email-template.registry';

/**
 * Renders the registered React Email template for the event and ships
 * it via the active email provider (Resend or SMTP). The adapter is
 * provider-agnostic and template-agnostic — extending support for a
 * new notification event means adding an entry to
 * {@link EMAIL_TEMPLATE_REGISTRY}, not touching this class.
 */
@Injectable()
export class EmailChannelAdapter implements IChannelAdapter {
    readonly channel = NotificationChannel.EMAIL;
    private readonly logger = createLogger(EmailChannelAdapter.name);

    constructor(
        @Inject(EMAIL_PROVIDER_TOKEN)
        private readonly emailProvider: IEmailProvider,
        private readonly configService: ConfigService,
    ) {}

    async deliver(context: NotificationDeliveryContext): Promise<void> {
        const { event, metadata, userEmail } = context;

        const template = this.resolveTemplate(event, metadata);
        if (!template) {
            this.logger.warn({
                message: `No email template registered for event: ${event}`,
                context: EmailChannelAdapter.name,
                metadata: { event, deliveryId: context.deliveryId },
            });
            return;
        }

        const html = await render(template.react);

        await this.emailProvider.send({
            from: formatFromAddress(template.from),
            to: userEmail,
            subject: template.subject,
            html,
            replyTo: template.replyTo,
        });
    }

    private resolveTemplate(
        event: NotificationEvent,
        metadata: Record<string, unknown>,
    ): ResolvedEmailTemplate | null {
        const builder = EMAIL_TEMPLATE_REGISTRY[event];
        if (!builder) return null;

        const webUrl = this.configService.get<string>(
            'API_USER_INVITE_BASE_URL',
            '',
        );

        return builder(metadata, { webUrl });
    }
}
