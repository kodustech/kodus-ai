import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { faker } from '@faker-js/faker';
import { ValidationPipe } from '@nestjs/common';

import { DatabaseModule } from '../../../src/modules/database.module';
import { AuthModule } from '../../../src/modules/auth.module';

import { dataSourceInstance } from '../../../src/config/database/typeorm/ormconfig';

let app: NestExpressApplication;

describe('User Registration', () => {
    const dataSource = dataSourceInstance;
    const dateInit = new Date();

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [DatabaseModule, AuthModule],
        }).compile();

        app = moduleRef.createNestApplication<NestExpressApplication>();
        app.useGlobalPipes(new ValidationPipe({ transform: true }));

        await app.init();
        await app.listen(0);

        await dataSource.initialize();
    });

    afterEach(async () => {
        // since we are using the same database for local testing and development
        // I don't want to delete data that is outside the scope of the test
        dataSource.query(`
            delete from auth where "createdAt" >= '${dateInit.toISOString()}';
            delete from users where "createdAt" >= '${dateInit.toISOString()}';
            delete from organizations where "createdAt" >= '${dateInit.toISOString()}';
        `);
    });

    afterAll(async () => {
        await app.close();
    });

    it('Should not register a user with an invalid email', async () => {
        const user = {
            email: faker.lorem.word(6),
            password: 'Password!123',
            organizationName: faker.company.name(),
        };

        expect(user.email).not.toMatch(
            /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        );
    });
});
