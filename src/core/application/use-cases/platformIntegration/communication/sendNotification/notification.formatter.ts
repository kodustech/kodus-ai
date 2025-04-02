import { KodyNotification } from '@/core/domain/platformIntegrations/types/communication/kodyNotification.type';

export type SlackBlocks = Array<SlackBlock>;

export interface SlackBlock {
    type: string;
    text?: {
        type: string;
        text: string;
        emoji?: boolean;
    };
    elements?: Array<SlackElement>;
    accessory?: SlackAccessory;
}

export interface SlackElement {
    type: string;
    text: {
        type: string;
        text: string;
        emoji?: boolean;
    };
    url?: string;
}

export interface SlackAccessory {
    type: string;
    action_id: string;
}

export interface DiscordMessage {
    embeds: DiscordEmbed[];
    components?: DiscordComponent[];
}

export interface DiscordComponent {
    type: number;
    components?: DiscordButtonComponent[];
}

export interface DiscordButtonComponent {
    type: number;
    style: number;
    label: string;
    url: string;
}
export interface DiscordEmbed {
    title: string;
    description: string;
    color?: number;
    fields?: Array<DiscordField>;
}

export interface DiscordField {
    name: string;
    value: string;
    inline?: boolean;
}

class NotificationFormatter {
    static formatForSlack(notification: KodyNotification): SlackBlocks {
        const blocks: SlackBlocks = [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: notification.title,
                    emoji: true,
                },
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: notification.message,
                },
            },
        ];

        if (notification.buttons && notification.buttons.length > 0) {
            blocks.push({
                type: 'actions',
                elements: notification.buttons.map((button) => ({
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: button.text,
                        emoji: true,
                    },
                    url: button.url,
                })),
            });
        }

        return blocks;
    }

    static formatForDiscord(notification: KodyNotification): DiscordMessage {
        const embed: DiscordEmbed = {
            title: notification.title,
            description: notification.message,
            color: 0x0099ff,
        };

        const components: DiscordComponent[] = [];

        if (notification.buttons && notification.buttons.length > 0) {
            const buttonRow: DiscordComponent = {
                type: 1,
                components: notification.buttons.map((button) => ({
                    type: 2,
                    style: 5,
                    label: button.text,
                    url: button.url,
                })),
            };
            components.push(buttonRow);
        }

        return {
            embeds: [embed],
            components: components.length > 0 ? components : undefined,
        };
    }
}

export default NotificationFormatter;
