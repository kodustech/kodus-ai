import {
    IsString,
    IsOptional,
    IsBoolean,
    IsArray,
    ValidateNested,
    IsEnum,
    MaxLength,
    ArrayMaxSize,
    IsInt,
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class CliFileInputDto {
    @IsString()
    @MaxLength(500, { message: 'File path too long (max 500 characters)' })
    @ApiProperty({ example: 'src/services/user.service.ts' })
    path: string;

    @IsString()
    @MaxLength(2000000, { message: 'File content too large (max 2MB)' })
    @ApiProperty({ example: 'export const isActive = (user) => user?.active;' })
    content: string;

    @IsEnum(['added', 'modified', 'deleted', 'renamed'])
    @ApiProperty({
        enum: ['added', 'modified', 'deleted', 'renamed'],
        example: 'modified',
    })
    status: 'added' | 'modified' | 'deleted' | 'renamed';

    @IsString()
    @MaxLength(500000, { message: 'Diff too large (max 500KB)' })
    @ApiProperty({ example: '+ const isActive = (user) => user?.active;' })
    diff: string;
}

class CliReviewRulesDto {
    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: true })
    security?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: false })
    performance?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: true })
    style?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: true })
    bestPractices?: boolean;
}

class CliConfigDto {
    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'medium' })
    severity?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => CliReviewRulesDto)
    @ApiPropertyOptional({
        type: CliReviewRulesDto,
        example: { security: true, style: true },
    })
    rules?: CliReviewRulesDto;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: false })
    rulesOnly?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: true })
    fast?: boolean;

    @IsOptional()
    @IsBoolean()
    @ApiPropertyOptional({ type: Boolean, example: false })
    heavy?: boolean;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(500, {
        message: 'Too many files (max 500 files per request)',
    })
    @ValidateNested({ each: true })
    @Type(() => CliFileInputDto)
    @ApiPropertyOptional({
        type: CliFileInputDto,
        isArray: true,
        example: [
            {
                path: 'src/services/user.service.ts',
                content: 'export const isActive = (user) => user?.active;',
                status: 'modified',
                diff: '+ const isActive = (user) => user?.active;',
            },
        ],
    })
    files?: CliFileInputDto[];
}

export class CliReviewRequestDto {
    @IsString()
    @MaxLength(20000000, { message: 'Diff too large (max 20MB)' })
    @ApiProperty({
        example: 'diff --git a/src/app.ts b/src/app.ts\n+const x = 1;',
    })
    diff: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => CliConfigDto)
    @ApiPropertyOptional({ type: CliConfigDto })
    config?: CliConfigDto;

    @IsOptional()
    @IsString()
    @MaxLength(254, { message: 'Email too long' })
    @ApiPropertyOptional({ format: 'email', example: 'dev@kodus.io' })
    userEmail?: string; // git config user.email for tracking

    @IsOptional()
    @IsString()
    @MaxLength(500, { message: 'Git remote URL too long' })
    @ApiPropertyOptional({ example: 'https://github.com/kodus/kodus-ai.git' })
    gitRemote?: string; // git remote get-url origin

    @IsOptional()
    @IsString()
    @MaxLength(255, { message: 'Branch name too long' })
    @ApiPropertyOptional({ example: 'feat/openapi-docs' })
    branch?: string; // git branch --show-current

    @IsOptional()
    @IsString()
    @MaxLength(40, { message: 'Commit SHA too long' })
    @ApiPropertyOptional({ example: 'a1b2c3d4e5f6g7h8i9j0' })
    commitSha?: string; // git rev-parse HEAD

    @IsOptional()
    @IsString()
    @MaxLength(40, { message: 'Merge-base SHA too long' })
    @ApiPropertyOptional({
        description:
            "Merge-base between HEAD and the upstream default branch (git merge-base HEAD origin/main). The sandbox checks out this commit (guaranteed to be on the remote) and applies the diff on top, so reviews work for branches not yet pushed and uncommitted changes.",
        example: 'a1b2c3d4e5f6g7h8i9j0',
    })
    mergeBaseSha?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255, { message: 'GitHub PAT too long' })
    @ApiPropertyOptional({
        description:
            "Optional GitHub Personal Access Token. Trial users (anonymous) need this to clone private repositories — for public repos it's not required. The token is held in memory for the pipeline run only and is never persisted.",
        example: '<your-github-personal-access-token>',
    })
    githubPat?: string;

    @IsOptional()
    @IsEnum(PlatformType)
    @ApiPropertyOptional({
        enum: PlatformType,
        enumName: 'PlatformType',
        example: PlatformType.GITHUB,
    })
    inferredPlatform?: PlatformType; // Inferred from gitRemote

    @IsOptional()
    @IsString()
    @MaxLength(50, { message: 'CLI version too long' })
    @ApiPropertyOptional({ example: '1.12.0' })
    cliVersion?: string; // CLI version for tracking
}

export class TrialCliReviewRequestDto extends CliReviewRequestDto {
    @IsString()
    @MaxLength(256, { message: 'Fingerprint too long (max 256 characters)' })
    @ApiProperty({ example: 'device_fingerprint_123' })
    fingerprint: string; // Device fingerprint for rate limiting
}

export class PublicPrReviewRequestDto {
    @IsString()
    @MaxLength(1000, { message: 'PR URL too long (max 1000 characters)' })
    @ApiProperty({
        description: 'Public GitHub PR URL to review',
        example: 'https://github.com/sgl-project/sglang/pull/12668',
    })
    prUrl: string;

    @IsString()
    @MaxLength(256, { message: 'Fingerprint too long (max 256 characters)' })
    @ApiProperty({
        description:
            'Device fingerprint for rate limiting (generated client-side)',
        example: 'device_fingerprint_123',
    })
    fingerprint: string;
}

export class CliBusinessValidationRequestDto {
    @IsOptional()
    @IsString()
    @MaxLength(1000, { message: 'PR URL too long (max 1000 characters)' })
    @ApiPropertyOptional({
        example: 'https://github.com/kodus-ai/kodus-ai/pull/123',
    })
    prUrl?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @ApiPropertyOptional({ type: Number, example: 123 })
    prNumber?: number;

    @IsOptional()
    @IsString()
    @MaxLength(200, { message: 'Repository ID too long (max 200 characters)' })
    @ApiPropertyOptional({ example: '123456789' })
    repositoryId?: string;

    @IsOptional()
    @IsString()
    @MaxLength(255, {
        message: 'Repository name too long (max 255 characters)',
    })
    @ApiPropertyOptional({ example: 'kodus-ai/kodus-ai' })
    repository?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1000, { message: 'Task URL too long (max 1000 characters)' })
    @ApiPropertyOptional({
        example: 'https://linear.app/kodus/issue/KD-1234/validar-regra',
    })
    taskUrl?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200, { message: 'Task ID too long (max 200 characters)' })
    @ApiPropertyOptional({ example: 'KD-1234' })
    taskId?: string;

    @IsOptional()
    @IsString()
    @MaxLength(5000000, { message: 'Diff too large (max 5MB)' })
    @ApiPropertyOptional({
        example: 'diff --git a/src/app.ts b/src/app.ts\n+const x = 1;',
    })
    diff?: string;
}
