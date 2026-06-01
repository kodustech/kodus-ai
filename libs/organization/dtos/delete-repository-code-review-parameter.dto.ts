import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class DeleteRepositoryCodeReviewParameterDto {
    @IsString()
    @ApiProperty({ example: 'c33ef663-70e7-4f43-9605-0bbef979b8e0' })
    teamId: string;

    @IsString()
    @ApiProperty({ example: '1135722979' })
    repositoryId: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'src/services' })
    directoryId?: string;

    @IsOptional()
    @IsString()
    @ApiPropertyOptional({ example: 'folder-uuid' })
    folderId?: string;
}
