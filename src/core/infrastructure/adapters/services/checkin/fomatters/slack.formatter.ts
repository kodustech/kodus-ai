import { SnoozeTime } from '@/core/domain/snoozedItems/enums/snooze-time.enum';
import { Block, KnownBlock, SectionBlock } from '@slack/types';
import { HeaderBlock } from '@slack/web-api';

interface SectionContent {
    text: string;
    sectionKey: string;
}

export interface SlackSection {
    sectionId: string;
    sectionTitle: string;
    sectionContent: SectionContent[];
    possibleToMutate: boolean;
}

interface ButtonContent extends SectionContent {
    actionValue?: string;
}

interface InputData {
    sections: SlackSection[];
}

export class SlackFormatter {
    private generateSilenceOptions(itemId: string): any[] {
        const options: { key: keyof typeof SnoozeTime; text: string }[] = [
            { key: 'ONE_DAY', text: 'Mute for 1 day' },
            { key: 'TWO_DAYS', text: 'Mute for 2 days' },
            { key: 'FIVE_DAYS', text: 'Mute for 5 days' },
            { key: 'TEN_DAYS', text: 'Mute for 10 days' },
            { key: 'FOREVER', text: 'Mute forever' },
        ];

        return options.map((option) => ({
            text: {
                type: 'plain_text' as const,
                text: option.text,
            },
            value: `${itemId}|${option.key}`,
        }));
    }

    private createHeaderBlock(header: string, frequency: string): HeaderBlock {
        const frequencyText = frequency === 'daily' ? 'Daily' : 'Weekly';

        return {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `${header} - ${frequencyText} Checkin`,
                emoji: true,
            },
        };
    }

    private createTitleBlock(title: string): HeaderBlock {
        return {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `${title.replaceAll('*', '')}`,
                emoji: true,
            },
        };
    }

    private createContentBlock(
        content: string,
        itemId: string,
        isSilenciable: boolean,
    ): SectionBlock {
        const block: SectionBlock = {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: content,
            },
        };

        if (isSilenciable) {
            block.accessory = {
                type: 'overflow',
                action_id: 'snooze_item',
                options: this.generateSilenceOptions(itemId),
            };
        }

        return block;
    }

    private createButtonBlock(button: ButtonContent): any {
        if (button.sectionKey === 'dynamic_button') {
            return {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: button.text,
                },
                accessory: {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: 'Deepen',
                        emoji: true,
                    },
                    value: JSON.stringify({
                        type: 'WeekSummaryQuestions',
                        question: button.text,
                    }),
                    action_id: `handleWeekSummaryCommand_${button.text.toLowerCase().replace(/[^a-z0-9]+/gi, '_')}`,
                },
            };
        } else if (button.sectionKey === 'button_link') {
            return {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: button.text,
                        },
                        url: button.actionValue,
                    },
                ],
            };
        }
        return null;
    }

    public transform(
        input: InputData,
        teamName: string,
        frequency: string,
    ): (KnownBlock | Block)[] {
        const blocks: (KnownBlock | Block)[] = [];

        blocks.push(this.createHeaderBlock(teamName, frequency));

        input.sections.forEach((section) => {
            if (section.sectionTitle !== '') {
                blocks.push(this.createTitleBlock(section.sectionTitle));
            }

            if (section.sectionId === 'buttons') {
                section.sectionContent.forEach((item) => {
                    const buttonBlock = this.createButtonBlock(
                        item as ButtonContent,
                    );
                    if (buttonBlock) {
                        blocks.push(buttonBlock);
                    }
                });
            } else if (section.possibleToMutate) {
                section.sectionContent.forEach((item) => {
                    const itemId = `${section.sectionId}|${item.sectionKey}`;
                    blocks.push(
                        this.createContentBlock(item.text, itemId, true),
                    );
                });
            } else {
                const contentText = section.sectionContent
                    .map((item) => item.text)
                    .join('\n');
                blocks.push(this.createContentBlock(contentText, '', false));
            }
        });

        return blocks;
    }
}
