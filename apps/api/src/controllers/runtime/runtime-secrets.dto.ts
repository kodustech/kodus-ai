import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Request shapes of the Runtime secret routes. The value is write-only: no
// response carries it, and no validation message repeats it (the use case
// checks its form with messages of its own).

export class CreateRuntimeSecretDto {
    @ApiProperty({ example: 'NPM_TOKEN', description: 'The environment variable the machine sees the placeholder in.' })
    @IsString()
    @MaxLength(64, { message: 'name is longer than 64 characters' })
    name: string;

    @ApiProperty({ type: [String], example: ['npm.corp.example'], description: 'The exact hosts the value may go to.' })
    @IsArray()
    @ArrayMinSize(1, { message: 'name at least one host' })
    @ArrayMaxSize(16, { message: 'at most 16 hosts' })
    @IsString({ each: true })
    hosts: string[];

    @ApiProperty({ writeOnly: true, description: 'The value. Stored in the secret store only; never returned.' })
    @IsString({ message: 'value must be a string' })
    @MinLength(1, { message: 'value must not be empty' })
    @MaxLength(8192, { message: 'value is longer than 8 KiB' })
    value: string;
}

export class UpdateRuntimeSecretDto {
    @ApiPropertyOptional({ type: [String], example: ['npm.corp.example'] })
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1, { message: 'name at least one host' })
    @ArrayMaxSize(16, { message: 'at most 16 hosts' })
    @IsString({ each: true })
    hosts?: string[];

    @ApiPropertyOptional({ writeOnly: true, description: 'A new value; replaces the current one. Never returned.' })
    @IsOptional()
    @IsString({ message: 'value must be a string' })
    @MinLength(1, { message: 'value must not be empty' })
    @MaxLength(8192, { message: 'value is longer than 8 KiB' })
    value?: string;
}
