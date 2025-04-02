import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsPhoneNumber,
} from 'class-validator';

export class UpdateInfoOrganizationAndPhoneDto {
    @IsString()
    @IsNotEmpty({ message: 'The name field is required.' })
    public name: string;

    @IsString()
    @IsOptional()
    public phone?: string;
}
