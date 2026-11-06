-- Least-privilege roles, created at first boot.
--
-- The application roles cannot execute DDL, and neither can UPDATE or DELETE an
-- audit row. That is enforced here rather than in application code, because an
-- application bug should not be able to erase the trail.

CREATE ROLE soar_app LOGIN PASSWORD :'app_password';
CREATE ROLE soar_worker LOGIN PASSWORD :'worker_password';

GRANT CONNECT ON DATABASE soar TO soar_app, soar_worker;
GRANT USAGE ON SCHEMA public TO soar_app, soar_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE soar_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO soar_app;

ALTER DEFAULT PRIVILEGES FOR ROLE soar_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO soar_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE soar_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO soar_app, soar_worker;

-- Audit is insert-only for every runtime role, and the worker never reads a
-- credential row. Both are enforced in the migrations rather than here: ALTER
-- DEFAULT PRIVILEGES applies to EVERY table it cannot name, so writing them
-- here took UPDATE away from all 52 of them and left the platform unable to
-- record a worker heartbeat.
