import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class PullRequestMessagesDirectoryOverrideCountDto {
    @ApiProperty()
    directoryId: string;

    @ApiProperty()
    overrideCount: number;
}

export class PullRequestMessagesOverrideCountsDto {
    @ApiProperty()
    repositoryId: string;

    @ApiProperty()
    repositoryOverrideCount: number;

    @ApiProperty({ type: [PullRequestMessagesDirectoryOverrideCountDto] })
    directoryOverrideCounts: PullRequestMessagesDirectoryOverrideCountDto[];
}

export class PullRequestMessagesOverrideCountsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: PullRequestMessagesOverrideCountsDto })
    data: PullRequestMessagesOverrideCountsDto;
}
