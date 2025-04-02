import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, Repository, UpdateQueryBuilder } from 'typeorm';
import { mapSimpleModelToEntity } from '@/shared/infrastructure/repositories/mappers';
import { AuthModel } from './schema/auth.model';
import { IAuthRepository } from '@/core/domain/auth/contracts/auth.repository.contracts';
import { IAuth } from '@/core/domain/auth/interfaces/auth.interface';
import { AuthEntity } from '@/core/domain/auth/entities/auth.entity';

@Injectable()
export class AuthRepository implements IAuthRepository {
    constructor(
        @InjectRepository(AuthModel)
        private readonly authRepository: Repository<AuthModel>,
    ) {}

    async saveRefreshToken(auth: IAuth): Promise<AuthEntity> {
        try {
            const queryBuilder = this.authRepository.createQueryBuilder('auth');

            const authModel = this.authRepository.create(auth);
            const authSelected = await queryBuilder
                .insert()
                .values(authModel)
                .execute();

            if (authSelected?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<AuthModel> = {
                    where: {
                        uuid: authSelected.identifiers[0].uuid,
                    },
                };

                const insertedAuth =
                    await this.authRepository.findOne(findOneOptions);

                if (insertedAuth) {
                    return mapSimpleModelToEntity(insertedAuth, AuthEntity);
                }
            }

            return undefined;
        } catch (error) {}
    }

    async updateRefreshToken(auth: Partial<IAuth>): Promise<AuthEntity> {
        try {
            if (!auth?.uuid) return undefined;

            const queryBuilder: UpdateQueryBuilder<AuthModel> =
                this.authRepository
                    .createQueryBuilder('auth')
                    .update(AuthModel)
                    .set(auth)
                    .where('uuid = :uuid', { uuid: auth.uuid });

            const authSelected = await queryBuilder.execute();

            if (authSelected) {
                const findOneOptions: FindOneOptions<AuthModel> = {
                    where: {
                        uuid: auth.uuid,
                    },
                };

                const insertedAuth =
                    await this.authRepository.findOne(findOneOptions);

                if (insertedAuth) {
                    return mapSimpleModelToEntity(insertedAuth, AuthEntity);
                }
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }

    async findRefreshToken(auth: Partial<IAuth>): Promise<AuthModel> {
        try {
            // if (!auth?.uuid) return undefined;

            const findOneOptions: FindOneOptions<AuthModel> = {
                where: {
                    ...auth,
                    user: { uuid: auth.uuid },
                },
            };

            const authSelected =
                await this.authRepository.findOne(findOneOptions);

            if (authSelected) {
                return authSelected;
            }

            return undefined;
        } catch (error) {}
    }

    async deactivateRefreshToken(auth: Partial<IAuth>): Promise<void> {
        try {
            if (!auth?.uuid) return undefined;

            const findOneOptions: FindOneOptions<AuthModel> = {
                where: {
                    ...auth,
                    user: { uuid: auth.uuid },
                },
            };

            const authSelected =
                await this.authRepository.findOne(findOneOptions);

            if (authSelected) {
                await this.authRepository.update(
                    {
                        user: {
                            uuid: authSelected.user.uuid,
                        },
                    },
                    {
                        refreshToken: authSelected.refreshToken,
                    },
                );
            }
        } catch (error) {}
    }
}
