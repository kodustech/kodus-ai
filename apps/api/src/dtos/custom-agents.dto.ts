import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    ValidateNested,
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

/** Where to list skills and docs: strings only. The use case checks their
 *  shape and ignores one that could not name a repository or ref. */
class ResolveCustomAgentSourceDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    @ApiPropertyOptional()
    repository?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    @ApiPropertyOptional()
    ref?: string;
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

    /** List skills and docs in this other repository (owner/repo), at `ref`
     *  or its default branch, instead of the reviewed one. */
    @IsOptional()
    @IsObject()
    @ValidateNested()
    @Type(() => ResolveCustomAgentSourceDto)
    @ApiPropertyOptional({ type: ResolveCustomAgentSourceDto })
    source?: ResolveCustomAgentSourceDto;

    /** Also list every repository the integration reaches. */
    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean })
    listConnected?: boolean;
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

/** Query of `GET /code-review/custom-agents/try/:runId` (#2172). */
export class CustomAgentTryRunQueryDto extends CustomAgentScopeDto {}
