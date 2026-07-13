\set ON_ERROR_STOP on

\if :{?migration_owner}
\else
\set migration_owner neondb_owner
\endif

BEGIN;

DO $guard$
DECLARE
  runtime_oid oid;
BEGIN
  SELECT oid INTO runtime_oid
  FROM pg_roles
  WHERE rolname = 'delivo_app_staging';

  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'delivo_app_staging role is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE member = runtime_oid
  ) THEN
    RAISE EXCEPTION 'delivo_app_staging must not belong to any role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE oid = runtime_oid
      AND (
        NOT rolcanlogin
        OR rolinherit
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR rolreplication
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'delivo_app_staging has unsafe role attributes';
  END IF;
END
$guard$;

SELECT format(
  'REVOKE ALL PRIVILEGES ON DATABASE %I FROM delivo_app_staging',
  current_database()
) \gexec

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO delivo_app_staging',
  current_database()
) \gexec

REVOKE ALL PRIVILEGES ON SCHEMA public FROM delivo_app_staging;
GRANT USAGE ON SCHEMA public TO delivo_app_staging;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM delivo_app_staging;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO delivo_app_staging;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM delivo_app_staging;
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO delivo_app_staging;

ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM delivo_app_staging;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO delivo_app_staging;

ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM delivo_app_staging;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO delivo_app_staging;

COMMIT;
