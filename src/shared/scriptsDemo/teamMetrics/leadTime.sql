-- Time: Kanban_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 390, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 385, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 380, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 375, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 370, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 360, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

-- Time: Kanban_2
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 450, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 425, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 455, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 430, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 442, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 440, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

-- Time: Scrum_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 450, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 435, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 430, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 425, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 420, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTime',
'{"total": {"sum": 36000, "average": 300, "percentiles": {"p50": 788.598, "p75": 420, "p85": 1620.518, "p95": 1620.558}}, "columns": [{"column": "To Do", "average": 442.002, "percentile": {"p50": 13.361, "p75": 789.316, "p85": 1620.509, "p95": 1620.55}}]}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);
