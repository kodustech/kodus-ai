import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class PullRequestMessageValueDto {
    @ApiProperty()
    value: string;

    @ApiProperty()
    level: string;
}

export class PullRequestMessageBooleanSettingDto {
    @ApiProperty()
    value: boolean;

    @ApiProperty()
    level: string;
}

export class PullRequestMessagesGlobalSettingsDto {
    @ApiProperty({ type: PullRequestMessageBooleanSettingDto })
    hideComments: PullRequestMessageBooleanSettingDto;

    @ApiProperty({ type: PullRequestMessageBooleanSettingDto })
    suggestionCopyPrompt: PullRequestMessageBooleanSettingDto;
}

export class PullRequestMessagesEntryDto {
    @ApiProperty({ type: PullRequestMessageValueDto })
    status: PullRequestMessageValueDto;

    @ApiProperty({ type: PullRequestMessageValueDto })
    content: PullRequestMessageValueDto;
}

export class PullRequestMessagesConfigDto {
    @ApiProperty()
    organizationId: string;

    @ApiProperty()
    repositoryId: string;

    @ApiProperty({ required: false })
    directoryId?: string;

    @ApiProperty({ type: PullRequestMessagesGlobalSettingsDto })
    globalSettings: PullRequestMessagesGlobalSettingsDto;

    @ApiProperty({ type: PullRequestMessagesEntryDto })
    startReviewMessage: PullRequestMessagesEntryDto;

    @ApiProperty({ type: PullRequestMessagesEntryDto })
    endReviewMessage: PullRequestMessagesEntryDto;

    @ApiProperty({ type: PullRequestMessagesEntryDto })
    errorReviewMessage: PullRequestMessagesEntryDto;
}

export class PullRequestMessagesResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: PullRequestMessagesConfigDto })
    data: PullRequestMessagesConfigDto;
}
