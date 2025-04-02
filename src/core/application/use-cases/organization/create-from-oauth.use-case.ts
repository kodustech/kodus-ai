import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { Injectable } from '@nestjs/common';
import { CreateOrganizationUseCase } from './create.use-case';
import { generateRandomOrgName, randomString } from '@/shared/utils/helpers';

@Injectable()
export class CreateOrganizationFromOAuthUseCase implements IUseCase {
    constructor(
        private readonly createOrganizationUseCase: CreateOrganizationUseCase,
    ) {}

    public async execute(
        payload: any,
        user: Partial<IUser>,
    ): Promise<Partial<IUser>> {
        try {
            const { name }: { name: string } = payload;
            const { email } = user;

            if (!name) {
                throw new Error('Name is required');
            }

            if (!email) {
                throw new Error('Email is required');
            }

            // Generate a random organization name to avoid conflicts
            let organizationName = generateRandomOrgName(name);

            const password = randomString(32);

            return await this.createOrganizationUseCase.execute(
                { organizationName, name },
                {
                    email,
                    password,
                    organization: { name: organizationName },
                },
            );
        } catch (error) {
            throw error;
        }
    }
}
