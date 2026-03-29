import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class TeamCliKeyConfigDto {
    @ApiProperty({
        required: false,
        type: [String],
        default: [],
    })
    capabilities?: string[];
}

export class TeamCliKeyCreatedDataDto {
    @ApiProperty()
    key: string;

    @ApiProperty()
    message: string;
}

export class TeamCliKeyCreatedResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: TeamCliKeyCreatedDataDto })
    data: TeamCliKeyCreatedDataDto;
}

export class TeamCliKeyCreatedByDto {
    @ApiProperty()
    uuid: string;
}

export class TeamCliKeyMetadataDto {
    @ApiProperty({ format: 'uuid' })
    uuid: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    active: boolean;

    @ApiProperty({
        required: false,
        nullable: true,
        type: TeamCliKeyConfigDto,
    })
    config?: TeamCliKeyConfigDto | null;

    @ApiProperty({ required: false, nullable: true })
    lastUsedAt?: string | null;

    @ApiProperty()
    createdAt: string;

    @ApiProperty({
        required: false,
        nullable: true,
        type: TeamCliKeyCreatedByDto,
    })
    createdBy?: TeamCliKeyCreatedByDto | null;
}

export class TeamCliKeyListResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: TeamCliKeyMetadataDto, isArray: true })
    data: TeamCliKeyMetadataDto[];
}

export class TeamCliKeyDeleteDataDto {
    @ApiProperty()
    message: string;
}

export class TeamCliKeyDeleteResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: TeamCliKeyDeleteDataDto })
    data: TeamCliKeyDeleteDataDto;
}

export class TeamCliKeyUpdateResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: TeamCliKeyMetadataDto })
    data: TeamCliKeyMetadataDto;
}
