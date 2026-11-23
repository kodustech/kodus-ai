import { ApiProperty } from '@nestjs/swagger';
import { IsHexadecimal, Length } from 'class-validator';

export class CredentialRejectedDto {
    @ApiProperty({
        description:
            'credentialFingerprint of the auth headers the MCP server refused: names the credential without carrying it.',
        example: '3f2a9c0d1b4e5f60',
    })
    @IsHexadecimal()
    @Length(16, 16)
    fingerprint: string;
}
