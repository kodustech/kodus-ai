INSERT INTO organization_metrics
("uuid", "createdAt", "updatedAt", "type", value, status, organization_id)
VALUES(uuid_generate_v4(), '2024-05-13 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'297.33',
true,
(select "uuid" from organizations where "name" = 'Kodus - Demo'));

INSERT INTO organization_metrics
("uuid", "createdAt", "updatedAt", "type", value, status, organization_id)
VALUES(uuid_generate_v4(), '2024-05-20 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'288.33',
true,
(select "uuid" from organizations where "name" = 'Kodus - Demo'));

INSERT INTO organization_metrics
("uuid", "createdAt", "updatedAt", "type", value, status, organization_id)
VALUES(uuid_generate_v4(), '2024-05-27 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'288.33',
true,
(select "uuid" from organizations where "name" = 'Kodus - Demo'));

INSERT INTO organization_metrics
("uuid", "createdAt", "updatedAt", "type", value, status, organization_id)
VALUES(uuid_generate_v4(), '2024-06-03 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'283.33',
true,
(select "uuid" from organizations where "name" = 'Kodus - Demo'));

INSERT INTO organization_metrics
("uuid", "createdAt", "updatedAt", "type", value, status, organization_id)
VALUES(uuid_generate_v4(), '2024-06-10 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'281',
true,
(select "uuid" from organizations where "name" = 'Kodus - Demo'));

INSERT INTO organization_metrics
("uuid", "createdAt", "updatedAt", "type", value, status, organization_id)
VALUES(uuid_generate_v4(), '2024-06-17 02:30:00.000', 'now'::text::timestamp(6) with time zone,
'leadTimeInWip',
'280',
true,
(select "uuid" from organizations where "name" = 'Kodus - Demo'));
