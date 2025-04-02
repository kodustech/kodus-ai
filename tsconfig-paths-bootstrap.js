import { compilerOptions } from './tsconfig.json';
import { register } from 'tsconfig-paths';

const paths = compilerOptions.paths;

register({
    baseUrl: compilerOptions.outDir,
    paths: Object.keys(paths).reduce(
        (agg, key) => ({
            ...agg,
            [key]: paths[key].map((p) =>
                p.replace(compilerOptions.baseUrl, compilerOptions.outDir),
            ),
        }),
        {},
    ),
});
