-- Time: Kanban_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 270, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 260, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 255, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 250, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 245, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 240, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

-- Time: Kanban_2
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 322, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 315, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 320, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 320, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 318, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 325, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

-- Time: Scrum_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 300, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 290, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 290, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 280, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 280, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'{"total": {"sum": 200, "average": 426.018, "deviation": {"level": "Grave", "value": 486}, "percentiles": {"p50": 178.144, "p75": 275, "p85": 789.333, "p95": 1337.087}}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);
