import * as dotenv from 'dotenv';
import { dataSourceInstance } from '../libs/core/infrastructure/database/typeorm/ormconfig';

dotenv.config();

async function main() {
    console.log('=====================================');
    console.log('  Force Killing Stuck Advisory Locks');
    console.log('=====================================\n');

    try {
        await dataSourceInstance.initialize();
        console.log('✓ Connected to database');
        const result = await dataSourceInstance.query(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE pid IN (
                SELECT pid FROM pg_locks WHERE locktype = 'advisory'
            )
            AND pid != pg_backend_pid();
        `);
        
        console.log(`✓ Successfully terminated ${result.length} stuck database connections holding advisory locks!`);

        await dataSourceInstance.destroy();
    } catch (e: any) {
        console.error('✗ Failed:', e.message);
        try {
            await dataSourceInstance.destroy();
        } catch {}
    }
}

main().catch(console.error);
