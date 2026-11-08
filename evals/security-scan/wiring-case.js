// The wiring smoke's case: a repository written for it (no GitHub fetch) with
// one route that builds SQL from the request. The scripted model cannot find
// anything; the case proves the scan drives production's engine end to end.
module.exports = {
    id: 'wiring-inline',
    language: 'typescript',
    repo: 'eval/wiring-inline',
    files: {
        'package.json': JSON.stringify({ name: 'wiring', scripts: { test: 'jest' } }, null, 2),
        'src/users.controller.ts': [
            "import { Controller, Get, Param } from '@nestjs/common';",
            "import { db } from './db';",
            '',
            "@Controller('users')",
            'export class UsersController {',
            "    @Get(':id')",
            "    async findOne(@Param('id') id: string) {",
            "        return db.query('select * from users where id = ' + id);",
            '    }',
            '}',
            '',
        ].join('\n'),
        'src/db.ts': "export const db = { query: async (sql: string) => sql };\n",
    },
    advisories: [
        {
            id: 'WIRING-SQLI',
            title: 'SQL built from the request',
            class: 'injection',
            locations: [{ file: 'src/users.controller.ts', line: 8 }],
        },
    ],
};
