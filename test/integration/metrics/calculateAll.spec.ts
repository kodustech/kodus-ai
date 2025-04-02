/* eslint-disable @typescript-eslint/no-var-requires */
import { NestExpressApplication } from '@nestjs/platform-express';
import { MetricsModule } from '../../../src/modules/metrics.module';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { METRICS_FACTORY_TOKEN } from '../../../src/core/domain/metrics/contracts/metrics.factory.contract';
import { DatabaseModule } from '../../../src/modules/database.module';

let app: NestExpressApplication;
let metricsFactory;
let metricsKodusProd;
let metricsKodusProd_feb;

describe('Calculate Metrics', () => {
    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [DatabaseModule, MetricsModule],
        }).compile();

        app = moduleRef.createNestApplication<NestExpressApplication>();
        app.useGlobalPipes(new ValidationPipe({ transform: true }));

        metricsFactory = app.get(METRICS_FACTORY_TOKEN);

        const columns = require('./mock/columns.mock.json');
        const columnsConfig = require('./mock/columnsConfig.mock.json');
        const columns_feb = require('./mock/columns_feb.mock.json');
        const workItemTypes = require('./mock/workItemTypes.mock.json');
        const bugTypeIdentifiers = [
            { id: '10012', name: 'Critical Bug' },
            { id: '10007', name: 'Bug' },
        ];

        metricsKodusProd = await metricsFactory.calculateAll(
            columns,
            columnsConfig,
            workItemTypes,
            bugTypeIdentifiers,
            new Date('2024-01-24T09:56:00-03:00'),
            { considerAll: true },
        );

        metricsKodusProd_feb = await metricsFactory.calculateAll(
            columns_feb,
            columnsConfig,
            workItemTypes,
            bugTypeIdentifiers,
            new Date('2024-01-31T15:32:00-03:00'),
            { considerAll: true },
        );
    });

    afterAll(async () => {
        await app.close();
    });

    it('Metrics should not be undefined or null', async () => {
        expect(metricsKodusProd).not.toBeUndefined();
        expect(metricsKodusProd).not.toBeNull();
    });
    it('Should return correct number of issues', async () => {
        expect(metricsKodusProd.leadTime.issues.length).toBe(85);
    });

    it('Should return correct number of columns', async () => {
        expect(Object.keys(metricsKodusProd.leadTimeByColumn).length).toBe(5);
    });

    it('Should return all metrics', async () => {
        expect(metricsKodusProd).toHaveProperty('bugRatio');
        expect(metricsKodusProd).toHaveProperty('leadTime');
        expect(metricsKodusProd).toHaveProperty('leadTimeByColumn');
        expect(metricsKodusProd).toHaveProperty('leadTimeInWip');
        expect(metricsKodusProd).toHaveProperty('leadTimeInWipByItemType');
        expect(metricsKodusProd).toHaveProperty('leadTimeByItemType');
        expect(metricsKodusProd).toHaveProperty('throughput');
    });

    it('Should return correct throughput', async () => {
        expect(metricsKodusProd.throughput).toBe(0);
        expect(metricsKodusProd_feb.throughput).toBe(26);
    });

    it('Should return correct bug ratio', async () => {
        expect(metricsKodusProd.bugRatio).toEqual({
            totalBugs: 16,
            totalWorkItems: 30,
            value: 0.533,
        });
        expect(metricsKodusProd_feb.bugRatio).toEqual({
            totalBugs: 4,
            totalWorkItems: 9,
            value: 0.444,
        });
    });

    it('Should return put zero for skipped column', async () => {
        const KC91 = metricsKodusProd.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-91',
        )['KC-91'];

        const KC150 = metricsKodusProd.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-150',
        )['KC-150'];

        const KC135 = metricsKodusProd.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-135',
        )['KC-135'];

        expect(KC91['In Progress']).toBe(0);
        expect(KC91['Waiting For Homolog']).toBe(0);
        expect(KC150['Waiting For Homolog']).toBe(0);
        expect(KC135['In Progress']).toBe(0);
        expect(KC135['Waiting For Homolog']).toBe(0);

        // new data for tests
        const KC140 = metricsKodusProd_feb.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-140',
        )['KC-140'];

        const KC137 = metricsKodusProd_feb.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-137',
        )['KC-137'];

        const KC51 = metricsKodusProd_feb.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-51',
        )['KC-51'];

        expect(KC140['Ready To Do']).toBe(0);
        expect(KC140['In Progress']).toBe(0);
        expect(KC140['Waiting For Homolog']).toBe(0);
        expect(KC140['In Homolog']).toBe(0);
        expect(KC140['Ready To Deploy']).toBe(0);
        expect(KC137['Ready To Do']).toBe(0);
        expect(KC51['Ready To Do']).toBe(0);
        expect(KC51['In Progress']).toBe(0);
        expect(KC51['Waiting For Homolog']).toBe(0);
        expect(KC51['In Homolog']).toBe(0);
        expect(KC51['Ready To Deploy']).toBe(0);
    });

    it('Should return the correct value for issues that have returned in the board', async () => {
        const KC130 = metricsKodusProd.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-130',
        )['KC-130'];

        const KC93 = metricsKodusProd.leadTime.issues.find(
            (task) => Object.keys(task)[0] === 'KC-93',
        )['KC-93'];

        expect(KC130['In Progress']).toBe(67.263);
        expect(KC93['Ready To Do']).toBe(554.548);
        expect(KC93['In Progress']).toBe(41.092);
    });

    // all issues that passed through that column
    it('Should return correct lead time by column', async () => {
        expect(metricsKodusProd.leadTimeByColumn['In Progress']).toBe(52.935);
        expect(metricsKodusProd.leadTimeByColumn['Waiting For Homolog']).toBe(
            4.729,
        );
        expect(metricsKodusProd.leadTimeByColumn['In Homolog']).toBe(144.988);
        expect(metricsKodusProd.leadTimeByColumn['Ready To Deploy']).toBe(
            333.752,
        );

        // dados de fevereiro
        expect(metricsKodusProd_feb.leadTimeByColumn['In Progress']).toBe(
            53.681,
        );
        expect(
            metricsKodusProd_feb.leadTimeByColumn['Waiting For Homolog'],
        ).toBe(4.748);
        expect(metricsKodusProd_feb.leadTimeByColumn['In Homolog']).toBe(
            142.896,
        );
        expect(metricsKodusProd_feb.leadTimeByColumn['Ready To Deploy']).toBe(
            282.981,
        );
    });

    // all issues that are starting from the first mapped column of the board
    it('Should return correct total Lead Time', async () => {
        expect(metricsKodusProd.leadTime.total.average).toBe(372.788);
        expect(metricsKodusProd.leadTime.total.percentiles.p50).toBe(353.413);
        expect(metricsKodusProd.leadTime.total.percentiles.p75).toBe(550.039);
        expect(metricsKodusProd.leadTime.total.percentiles.p85).toBe(667.445);
        expect(metricsKodusProd.leadTime.total.percentiles.p95).toBe(827.284);

        // new data for February
        expect(metricsKodusProd_feb.leadTime.total.average).toBe(377.437);
        expect(metricsKodusProd_feb.leadTime.total.percentiles.p50).toBe(
            354.861,
        );
        expect(metricsKodusProd_feb.leadTime.total.percentiles.p75).toBe(
            550.039,
        );
        expect(metricsKodusProd_feb.leadTime.total.percentiles.p85).toBe(
            640.133,
        );
        expect(metricsKodusProd_feb.leadTime.total.percentiles.p95).toBe(
            855.459,
        );
    });

    // all issues that are in WIP
    it('Should return correct total Lead Time in WIP', async () => {
        expect(metricsKodusProd.leadTimeInWip.total.average).toBe(352.913);
        expect(metricsKodusProd.leadTimeInWip.total.percentiles.p50).toBe(
            330.07,
        );
        expect(metricsKodusProd.leadTimeInWip.total.percentiles.p75).toBe(
            528.414,
        );
        expect(metricsKodusProd.leadTimeInWip.total.percentiles.p85).toBe(
            640.924,
        );
        expect(metricsKodusProd.leadTimeInWip.total.percentiles.p95).toBe(
            741.77,
        );

        // data for February
        expect(metricsKodusProd_feb.leadTimeInWip.total.average).toBe(359.78);
        expect(metricsKodusProd_feb.leadTimeInWip.total.percentiles.p50).toBe(
            337.565,
        );
        expect(metricsKodusProd_feb.leadTimeInWip.total.percentiles.p75).toBe(
            528.007,
        );
        expect(metricsKodusProd_feb.leadTimeInWip.total.percentiles.p85).toBe(
            609.288,
        );
        expect(metricsKodusProd_feb.leadTimeInWip.total.percentiles.p95).toBe(
            734.593,
        );
    });
});
