import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

import { FIX_PROMPT_MAX_ISSUES } from '@libs/issues/domain/fix-prompt';

import { ApiResponseBaseDto } from './api-response.dto';

export class IssuesFixPromptRequestDto {
    @ApiProperty({
        type: [String],
        description: `Issue UUIDs to fix, at most ${FIX_PROMPT_MAX_ISSUES}.`,
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(FIX_PROMPT_MAX_ISSUES)
    @IsString({ each: true })
    ids: string[];
}

class IssuesFixPromptDto {
    @ApiProperty({
        description:
            "A prompt for the developer's own coding agent; empty when no issue could be included.",
    })
    prompt: string;

    @ApiProperty({ type: [String] })
    included: string[];

    @ApiProperty({
        type: [String],
        description:
            'Asked for but left out: unknown, or in a repository the caller cannot read.',
    })
    skipped: string[];
}

export class IssuesFixPromptResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: IssuesFixPromptDto })
    data: IssuesFixPromptDto;
}
