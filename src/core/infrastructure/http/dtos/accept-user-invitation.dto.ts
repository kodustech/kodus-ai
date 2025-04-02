import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsStrongPassword,
} from 'class-validator';

export class AcceptUserInvitationDto {
    @IsNotEmpty()
    public uuid: string;

    @IsString()
    public name: string;

    @IsString()
    @IsStrongPassword({
        minLength: 8,
        minLowercase: 1,
        minUppercase: 1,
        minNumbers: 1,
        minSymbols: 1,
    })
    public password: string;

    @IsString()
    @IsOptional()
    public phone?: string;
}
