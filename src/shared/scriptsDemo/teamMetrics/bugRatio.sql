-- Time: Kanban_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.33}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.28}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.15}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.26}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.30}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.12}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

-- Time: Kanban_2
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.57}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.43}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.38}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.44}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.51}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.39}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

-- Time: Scrum_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.43}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.36}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.33}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.30}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.28}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'bugRatio',
'{"value": 0.25}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);


