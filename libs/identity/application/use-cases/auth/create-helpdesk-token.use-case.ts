import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';

@Injectable()
export class CreateHelpdeskTokenUseCase implements IUseCase {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
    ) {}

    async execute(user: Partial<IUser>): Promise<{ token: string }> {
        const token = await this.authService.createHelpdeskToken(user);
        return { token };
    }
}
