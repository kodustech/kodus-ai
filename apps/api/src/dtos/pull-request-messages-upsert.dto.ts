import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

export class PullRequestMessageContentUpsertDto {
    @ApiProperty({ example: 'Thanks for the changes! Reviewing now.' })
    @IsString()
    content: string;

    @ApiProperty({
        enum: PullRequestMessageStatus,
        enumName: 'PullRequestMessageStatus',
        example: PullRequestMessageStatus.ACTIVE,
    })
    @IsEnum(PullRequestMessageStatus)
    status: PullRequestMessageStatus;
}

export class PullRequestMessagesGlobalSettingsUpsertDto {
    @ApiPropertyOptional({ example: false })
    @IsOptional()
    @IsBoolean()
    hideComments?: boolean;

    @ApiPropertyOptional({ example: true })
    @IsOptional()
    @IsBoolean()
    suggestionCopyPrompt?: boolean;
}

export class PullRequestMessagesUpsertDto {
    @ApiPropertyOptional({
        description:
            'Team identifier used to resolve team-scoped centralized configuration for global custom messages.',
        example: '2e4f7a61-3c8c-4af5-bf25-2d0cbb19c4d1',
    })
    @IsOptional()
    @IsString()
    teamId?: string;

    @ApiPropertyOptional({
        description: 'Optional identifier for existing message config entity',
        example: 'b871ca02-c235-4ee7-aa89-a3fcccb6ad2f',
    })
    @IsOptional()
    @IsString()
    uuid?: string;

    @ApiPropertyOptional({
        description:
            'Optional. It will be replaced by the authenticated user organization.',
        example: '585e32e5-242e-4381-bef4-d2dfc61375f9',
    })
    @IsOptional()
    @IsString()
    organizationId?: string;

    @ApiProperty({
        enum: ConfigLevel,
        enumName: 'ConfigLevel',
        example: ConfigLevel.REPOSITORY,
    })
    @IsEnum(ConfigLevel)
    configLevel: ConfigLevel;

    @ApiPropertyOptional({ example: '1135722979' })
    @IsOptional()
    @IsString()
    repositoryId?: string;

    @ApiPropertyOptional({ example: 'src/services' })
    @IsOptional()
    @IsString()
    directoryId?: string;

    @ApiPropertyOptional({ type: PullRequestMessageContentUpsertDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => PullRequestMessageContentUpsertDto)
    startReviewMessage?: PullRequestMessageContentUpsertDto;

    @ApiPropertyOptional({ type: PullRequestMessageContentUpsertDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => PullRequestMessageContentUpsertDto)
    endReviewMessage?: PullRequestMessageContentUpsertDto;

    @ApiPropertyOptional({ type: PullRequestMessagesGlobalSettingsUpsertDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => PullRequestMessagesGlobalSettingsUpsertDto)
    globalSettings?: PullRequestMessagesGlobalSettingsUpsertDto;
}
