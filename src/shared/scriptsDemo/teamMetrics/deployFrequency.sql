-- Time: Kanban_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 1, "weeklyFrequency": 5, "deploymentsTotal": 25, "deploymentsLastWeek": 5}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 1, "weeklyFrequency": 5, "deploymentsTotal": 30, "deploymentsLastWeek": 5}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 1.2, "weeklyFrequency": 6, "deploymentsTotal": 36, "deploymentsLastWeek": 5}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 1.25, "weeklyFrequency": 7, "deploymentsTotal": 43, "deploymentsLastWeek": 6}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 1.3, "weeklyFrequency": 7.5, "deploymentsTotal": 50, "deploymentsLastWeek": 7}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 1.5, "weeklyFrequency": 9, "deploymentsTotal": 59, "deploymentsLastWeek": 7}',
true,
(select "uuid" from teams where "name" = 'Kanban_1')
);

-- Time: Kanban_2
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.28, "weeklyFrequency": 2, "deploymentsTotal": 30, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.28, "weeklyFrequency": 2, "deploymentsTotal": 32, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.35, "weeklyFrequency": 2.5, "deploymentsTotal": 34.5, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.35, "weeklyFrequency": 2.5, "deploymentsTotal": 37, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.4, "weeklyFrequency": 3, "deploymentsTotal": 39.5, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.4, "weeklyFrequency": 3, "deploymentsTotal": 42.5, "deploymentsLastWeek": 3}',
true,
(select "uuid" from teams where "name" = 'Kanban_2')
);

-- Time: Scrum_1
INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.43, "weeklyFrequency": 3, "deploymentsTotal": 25, "deploymentsLastWeek": 3}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.28, "weeklyFrequency": 2, "deploymentsTotal": 30, "deploymentsLastWeek": 3}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.28, "weeklyFrequency": 2, "deploymentsTotal": 36, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.43, "weeklyFrequency": 3, "deploymentsTotal": 43, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.28, "weeklyFrequency": 2, "deploymentsTotal": 50, "deploymentsLastWeek": 3}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);

INSERT INTO metrics
("uuid", "createdAt", "updatedAt", "type", value, status, team_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'deployFrequency',
'{"dailyFrequency": 0.28, "weeklyFrequency": 2, "deploymentsTotal": 59, "deploymentsLastWeek": 2}',
true,
(select "uuid" from teams where "name" = 'Scrum_1')
);
