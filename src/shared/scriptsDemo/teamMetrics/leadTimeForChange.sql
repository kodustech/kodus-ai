-- Time: Kanban_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 225, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 200, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 200, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 195, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 190, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 180, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

-- Time: Kanban_2
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 300, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 320, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 320, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 300, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 295, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 290, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

-- Time: Scrum_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 275, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 270, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 275, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 270, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 265, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeForChange',
'{"total": 7000, "average": 150, "percentiles": {"p50": 100, "p75": 260, "p95": 400}}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);
