import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class CodeManagementRepositoryTreeDto {
    @ApiProperty({ nullable: true })
    repository: Record<string, unknown> | null;

    @ApiProperty({ nullable: true })
    parentPath: string | null;

    @ApiProperty()
    currentPath: string;

    @ApiProperty({ type: String, isArray: true })
    directories: string[];
}

export class CodeManagementRepositoryTreeResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementRepositoryTreeDto })
    data: CodeManagementRepositoryTreeDto;
}

export class CodeManagementWebhookStatusDto {
    @ApiProperty({ type: Boolean })
    active: boolean;
}

export class CodeManagementWebhookStatusResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementWebhookStatusDto })
    data: CodeManagementWebhookStatusDto;
}

export class CodeManagementWebhookCreationFailureDto {
    @ApiProperty({
        description:
            'Reason the provider refused the webhook, as reported by the provider.',
    })
    reason: string;

    @ApiProperty({ description: 'When the attempt failed (ISO 8601).' })
    at: string;
}

export class CodeManagementWebhookCreationFailuresDataDto {
    @ApiProperty({
        type: 'object',
        description:
            'Repositories whose webhook could not be created during the last selection save, keyed by repository id.',
        additionalProperties: {
            type: 'object',
            properties: {
                reason: { type: 'string' },
                at: { type: 'string' },
            },
        },
    })
    failures: Record<string, CodeManagementWebhookCreationFailureDto>;
}

export class CodeManagementWebhookCreationFailuresResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementWebhookCreationFailuresDataDto })
    data: CodeManagementWebhookCreationFailuresDataDto;
}

export class CodeManagementRepositoryDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    full_name: string;

    @ApiProperty()
    http_url: string;

    @ApiProperty()
    avatar_url: string;

    @ApiProperty()
    organizationName: string;

    @ApiProperty()
    default_branch: string;

    @ApiProperty()
    language: string;

    @ApiProperty()
    visibility: string;

    @ApiProperty()
    selected: boolean;

    @ApiProperty({ required: false })
    lastActivityAt?: string;
}

export class CodeManagementRepositoriesResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementRepositoryDto, isArray: true })
    data: CodeManagementRepositoryDto[];
}

export class CodeManagementRepositoryRefDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;
}

export class CodeManagementPullRequestDto {
    @ApiProperty()
    id: string;

    @ApiProperty({ type: CodeManagementRepositoryRefDto })
    repository: CodeManagementRepositoryRefDto;

    @ApiProperty()
    pull_number: number;

    @ApiProperty()
    title: string;

    @ApiProperty()
    url: string;
}

export class CodeManagementPullRequestsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementPullRequestDto, isArray: true })
    data: CodeManagementPullRequestDto[];
}

export class CodeManagementRepositoriesCreateDataDto {
    @ApiProperty()
    status: boolean;
}

export class CodeManagementRepositoriesCreateResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementRepositoriesCreateDataDto })
    data: CodeManagementRepositoriesCreateDataDto;
}

export class CodeManagementSearchUserDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    username: string;

    @ApiProperty()
    email: string;

    @ApiProperty()
    avatarUrl: string;

    @ApiProperty()
    source: string;
}

export class CodeManagementSearchUsersDataDto {
    @ApiProperty({ type: CodeManagementSearchUserDto, isArray: true })
    users: CodeManagementSearchUserDto[];
}

export class CodeManagementSearchUsersResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementSearchUsersDataDto })
    data: CodeManagementSearchUsersDataDto;
}

export class CodeManagementCurrentUserDto {
    @ApiProperty()
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    username: string;

    @ApiProperty()
    email: string;

    @ApiProperty()
    avatarUrl: string;

    @ApiProperty({
        type: Object,
        description:
            'Raw provider payload for the current user (shape varies by integration).',
        additionalProperties: true,
    })
    raw: Record<string, unknown>;
}

export class CodeManagementCurrentUserDataDto {
    @ApiProperty({ type: CodeManagementCurrentUserDto })
    user: CodeManagementCurrentUserDto;
}

export class CodeManagementCurrentUserResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: CodeManagementCurrentUserDataDto })
    data: CodeManagementCurrentUserDataDto;
}
