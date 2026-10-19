import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
} from 'class-validator';

import type { KnowledgeItem } from '@libs/core/infrastructure/config/types/general/codeReview.type';

const trim = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value;

class CustomAgentScopeDto {
    @IsString()
    @IsNotEmpty()
    @ApiProperty()
    teamId: string;

    @IsString()
    @IsNotEmpty()
    @ApiProperty()
    repositoryId: string;
}

/** Body of `POST /code-review/custom-agents/resolve` (#2172). */
export class ResolveCustomAgentDto extends CustomAgentScopeDto {
    /** Draft agent; the use case parses it. */
    @IsOptional()
    @IsObject()
    @ApiPropertyOptional({ type: Object })
    agent?: unknown;

    @IsOptional()
    @IsArray()
    @ApiPropertyOptional({ type: [Object] })
    knowledge?: KnowledgeItem[];

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean })
    discover?: boolean;
}

/** Body of `POST /code-review/custom-agents/try` (#2172). */
export class TryCustomAgentDto extends CustomAgentScopeDto {
    /** Set when the agent is tried from a directory's settings. */
    @IsOptional()
    @IsString()
    @ApiPropertyOptional()
    directoryId?: string;

    @Transform(trim)
    @IsString()
    @IsNotEmpty()
    @ApiProperty()
    prUrl: string;

    /** Agent to run, saved or not; the use case parses it. */
    @IsObject()
    @ApiProperty({ type: Object })
    agent: unknown;

    @IsOptional()
    @IsArray()
    @ApiPropertyOptional({ type: [Object] })
    knowledge?: KnowledgeItem[];
}

/** Query of `GET /code-review/custom-agents/status` (#2172). */
export class CustomAgentsStatusQueryDto extends CustomAgentScopeDto {}
