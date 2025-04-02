-- Time: Kanban_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 45, "In Progress": 65, "Waiting For Homolog": 4.5, "In Homolog": 88, "Ready To Deploy": 30}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 45, "In Progress": 63, "Waiting For Homolog": 4, "In Homolog": 85, "Ready To Deploy": 28}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 40, "In Progress": 61, "Waiting For Homolog": 4, "In Homolog": 85, "Ready To Deploy": 28}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 38, "In Progress": 55, "Waiting For Homolog": 3.5, "In Homolog": 85, "Ready To Deploy": 25}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 37, "In Progress": 55, "Waiting For Homolog": 3.5, "In Homolog": 105, "Ready To Deploy": 15}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 35, "In Progress": 50, "Waiting For Homolog": 3, "In Homolog": 97, "Ready To Deploy": 15}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

-- Time: Kanban_2
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 33, "In Progress": 65, "Waiting For Homolog": 4.5, "In Homolog": 95, "Ready To Deploy": 14}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 30, "In Progress": 78, "Waiting For Homolog": 4, "In Homolog": 95, "Ready To Deploy": 13}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 30, "In Progress": 78, "Waiting For Homolog": 4, "In Homolog": 97, "Ready To Deploy": 12}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 32, "In Progress": 74, "Waiting For Homolog": 3.5, "In Homolog": 105, "Ready To Deploy": 13}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 35, "In Progress": 74, "Waiting For Homolog": 3.5, "In Homolog": 108, "Ready To Deploy": 14}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 33, "In Progress": 70, "Waiting For Homolog": 3, "In Homolog": 85, "Ready To Deploy": 12}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

-- Time: Scrum_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 50, "In Progress": 70, "Waiting For Homolog": 4.5, "In Homolog": 93, "Ready To Deploy": 60}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 55, "In Progress": 72, "Waiting For Homolog": 4, "In Homolog": 90, "Ready To Deploy": 62}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 52, "In Progress": 69, "Waiting For Homolog": 4, "In Homolog": 90, "Ready To Deploy": 63}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 52, "In Progress": 72, "Waiting For Homolog": 3.5, "In Homolog": 90, "Ready To Deploy": 60}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 50, "In Progress": 68, "Waiting For Homolog": 3.5, "In Homolog": 87, "Ready To Deploy": 60}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeByColumn',
'{"Ready To Do": 47, "In Progress": 67, "Waiting For Homolog": 3, "In Homolog": 85, "Ready To Deploy": 59}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);
