import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOneOptions, Repository, UpdateQueryBuilder } from 'typeorm';

import { mapSimpleModelToEntity } from '@libs/core/infrastructure/repositories/mappers';
import { IAuthRepository } from '@libs/identity/domain/auth/contracts/auth.repository.contracts';
import { AuthEntity } from '@libs/identity/domain/auth/entities/auth.entity';
import { IAuth } from '@libs/identity/domain/auth/interfaces/auth.interface';
import { AuthModel } from './schemas/auth.model';

@Injectable()
export class AuthRepository implements IAuthRepository {
    constructor(
        @InjectRepository(AuthModel)
        private readonly authRepository: Repository<AuthModel>,
    ) {}

    async saveRefreshToken(auth: IAuth): Promise<AuthEntity> {
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
        const findOneOptions: FindOneOptions<AuthModel> = {
            where: {
                ...auth,
                user: { uuid: auth.uuid },
            },
        };

        const authSelected = await this.authRepository.findOne(findOneOptions);

        if (authSelected) {
            return authSelected;
        }

        return undefined;
    }

    async deactivateRefreshToken(auth: Partial<IAuth>): Promise<void> {
        if (!auth?.uuid) return undefined;

        const findOneOptions: FindOneOptions<AuthModel> = {
            where: {
                ...auth,
                user: { uuid: auth.uuid },
            },
        };

        const authSelected = await this.authRepository.findOne(findOneOptions);

        if (authSelected) {
            // TypeORM's UpdateQueryBuilder can't resolve a nested relation
            // path in its criteria — `update({ user: { uuid } }, ...)` throws
            // "Cannot find alias for relation at user" on the real query
            // builder (same root cause as the markAsRead/markAllAsRead 500
            // fixed in #1894). The record is already scoped by the `findOne`
            // above, so update by its own flat `uuid` instead.
            await this.authRepository.update(
                { uuid: authSelected.uuid },
                {
                    refreshToken: authSelected.refreshToken,
                },
            );
        }
    }
}
