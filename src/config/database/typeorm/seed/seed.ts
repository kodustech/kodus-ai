import 'reflect-metadata';
import { runSeeders } from 'typeorm-extension';
import { dataSourceInstance } from '../ormconfig';

const dataSource = dataSourceInstance;

dataSource.initialize().then(async () => {
    await runSeeders(dataSource);
    process.exit();
});
