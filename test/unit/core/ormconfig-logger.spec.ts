/**
 * Regression guard: TypeORM CLI (migrations / seeds) must stream logs
 * to stdout, not write ./ormlogs.log. The file write breaks the image
 * under Kubernetes PSA "restricted" with readOnlyRootFilesystem=true.
 */

import { dataSourceInstance } from '@libs/core/infrastructure/database/typeorm/ormconfig';

describe("ormconfig TypeORM CLI logger", () => {
    it("does not use the 'file' logger (which writes ./ormlogs.log)", () => {
        expect(dataSourceInstance.options.logger).not.toBe("file");
    });

    it("uses a stdout-based logger option", () => {
        const logger = dataSourceInstance.options.logger;
        expect(["advanced-console", "simple-console", "debug"]).toContain(
            logger,
        );
    });
});
