import { Test } from '@nestjs/testing';
import { RuntimeExternalMaintenanceModule } from './maintenance.module';
import { RuntimeExternalMaintenanceCron } from './maintenance.cron';

jest.mock('@libs/runtime/api/runtime-api.module', () => {
    const { Module } = require('@nestjs/common');
    const { DataSource } = require('typeorm');
    const {
        RUNTIME_CLOCK,
        RUNTIME_RUN_PROJECTION_STORE,
    } = require('@libs/runtime/api/domain/ports');
    class RuntimeApiModule {}
    const product = { options: { type: 'postgres' }, destroy: jest.fn() };
    Module({
        providers: [
            { provide: DataSource, useValue: product },
            { provide: RUNTIME_CLOCK, useValue: () => new Date() },
            { provide: RUNTIME_RUN_PROJECTION_STORE, useValue: {} },
        ],
        exports: [DataSource, RUNTIME_CLOCK, RUNTIME_RUN_PROJECTION_STORE],
    })(RuntimeApiModule);
    return { RuntimeApiModule, product };
});

it('builds worker maintenance wiring without opening or destroying the product connection', async () => {
    const module = await Test.createTestingModule({
        imports: [RuntimeExternalMaintenanceModule],
    }).compile();
    expect(module.get(RuntimeExternalMaintenanceCron)).toBeInstanceOf(
        RuntimeExternalMaintenanceCron,
    );
    await module.close();
    expect(
        jest.requireMock('@libs/runtime/api/runtime-api.module').product
            .destroy,
    ).not.toHaveBeenCalled();
});
