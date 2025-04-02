INSERT INTO organizations
("uuid", "createdAt", "updatedAt", "name", "tenantName", status)
VALUES(uuid_generate_v4(), 'now'::text::timestamp(6) with time zone, 'now'::text::timestamp(6) with time zone, 'Kodus - Demo', 'kodus_demo', true);

INSERT INTO teams
("uuid", "createdAt", "updatedAt", "name", organization_id, status)
VALUES(uuid_generate_v4(), 'now'::text::timestamp(6) with time zone, 'now'::text::timestamp(6) with time zone, 'Kanban_1',
(select "uuid" from organizations where name = 'Kodus - Demo'),
'active'::teams_status_enum);

INSERT INTO teams
("uuid", "createdAt", "updatedAt", "name", organization_id, status)
VALUES(uuid_generate_v4(), 'now'::text::timestamp(6) with time zone, 'now'::text::timestamp(6) with time zone, 'Kanban_2',
(select "uuid" from organizations where name = 'Kodus - Demo'),
'active'::teams_status_enum);

INSERT INTO teams
("uuid", "createdAt", "updatedAt", "name", organization_id, status)
VALUES(uuid_generate_v4(), 'now'::text::timestamp(6) with time zone, 'now'::text::timestamp(6) with time zone, 'Scrum_1',
(select "uuid" from organizations where name = 'Kodus - Demo'),
'active'::teams_status_enum);
