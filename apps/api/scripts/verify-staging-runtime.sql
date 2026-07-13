\set ON_ERROR_STOP on

\if :{?migration_owner}
\else
\set migration_owner neondb_owner
\endif

SELECT set_config('delivery.migration_owner', :'migration_owner', false);

DO $verify$
DECLARE
  runtime_oid oid;
  migration_owner_oid oid;
  public_schema_oid oid;
BEGIN
  SELECT oid INTO runtime_oid
  FROM pg_roles
  WHERE rolname = 'delivo_app_staging';

  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'delivo_app_staging role is missing';
  END IF;

  SELECT oid INTO migration_owner_oid
  FROM pg_roles
  WHERE rolname = current_setting('delivery.migration_owner');

  IF migration_owner_oid IS NULL THEN
    RAISE EXCEPTION 'migration owner role is missing';
  END IF;

  SELECT oid INTO public_schema_oid
  FROM pg_namespace
  WHERE nspname = 'public';

  IF public_schema_oid IS NULL THEN
    RAISE EXCEPTION 'public schema is missing';
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

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members
    WHERE member = runtime_oid
  ) THEN
    RAISE EXCEPTION 'delivo_app_staging must not belong to any role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datdba = runtime_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_namespace
    WHERE nspowner = runtime_oid
  ) THEN
    RAISE EXCEPTION 'delivo_app_staging owns a database or schema';
  END IF;

  IF NOT has_database_privilege('delivo_app_staging', current_database(), 'CONNECT')
    OR has_database_privilege('delivo_app_staging', current_database(), 'CREATE')
    OR has_database_privilege('delivo_app_staging', current_database(), 'CONNECT WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'unsafe database privileges';
  END IF;

  IF NOT has_schema_privilege('delivo_app_staging', 'public', 'USAGE')
    OR has_schema_privilege('delivo_app_staging', 'public', 'CREATE')
    OR has_schema_privilege('delivo_app_staging', 'public', 'USAGE WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'unsafe schema privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relowner = runtime_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = public_schema_oid
      AND p.proowner = runtime_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_type t
    WHERE t.typnamespace = public_schema_oid
      AND t.typowner = runtime_oid
  ) THEN
    RAISE EXCEPTION 'runtime role owns database objects';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT (
        has_table_privilege('delivo_app_staging', c.oid, 'SELECT')
        AND has_table_privilege('delivo_app_staging', c.oid, 'INSERT')
        AND has_table_privilege('delivo_app_staging', c.oid, 'UPDATE')
        AND has_table_privilege('delivo_app_staging', c.oid, 'DELETE')
      )
  ) THEN
    RAISE EXCEPTION 'runtime DML grant missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND (
        has_table_privilege('delivo_app_staging', c.oid, 'TRUNCATE')
        OR has_table_privilege('delivo_app_staging', c.oid, 'REFERENCES')
        OR has_table_privilege('delivo_app_staging', c.oid, 'TRIGGER')
        OR has_table_privilege('delivo_app_staging', c.oid, 'MAINTAIN')
        OR has_table_privilege('delivo_app_staging', c.oid, 'SELECT WITH GRANT OPTION')
        OR has_table_privilege('delivo_app_staging', c.oid, 'INSERT WITH GRANT OPTION')
        OR has_table_privilege('delivo_app_staging', c.oid, 'UPDATE WITH GRANT OPTION')
        OR has_table_privilege('delivo_app_staging', c.oid, 'DELETE WITH GRANT OPTION')
      )
  ) THEN
    RAISE EXCEPTION 'runtime has elevated table privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND NOT (
        has_sequence_privilege('delivo_app_staging', c.oid, 'USAGE')
        AND has_sequence_privilege('delivo_app_staging', c.oid, 'SELECT')
      )
  ) THEN
    RAISE EXCEPTION 'runtime sequence grant missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND (
        has_sequence_privilege('delivo_app_staging', c.oid, 'UPDATE')
        OR has_sequence_privilege('delivo_app_staging', c.oid, 'USAGE WITH GRANT OPTION')
        OR has_sequence_privilege('delivo_app_staging', c.oid, 'SELECT WITH GRANT OPTION')
      )
  ) THEN
    RAISE EXCEPTION 'runtime has elevated sequence privileges';
  END IF;

  IF EXISTS (
    SELECT required.privilege_type
    FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS required(privilege_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migration_owner_oid
        AND d.defaclnamespace = public_schema_oid
        AND d.defaclobjtype = 'r'
        AND acl.grantee = runtime_oid
        AND acl.privilege_type = required.privilege_type
        AND NOT acl.is_grantable
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    WHERE d.defaclrole = migration_owner_oid
      AND d.defaclnamespace = public_schema_oid
      AND d.defaclobjtype = 'r'
      AND acl.grantee = runtime_oid
      AND (
        acl.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        OR acl.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'unsafe default table privileges';
  END IF;

  IF EXISTS (
    SELECT required.privilege_type
    FROM (VALUES ('USAGE'), ('SELECT')) AS required(privilege_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migration_owner_oid
        AND d.defaclnamespace = public_schema_oid
        AND d.defaclobjtype = 'S'
        AND acl.grantee = runtime_oid
        AND acl.privilege_type = required.privilege_type
        AND NOT acl.is_grantable
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    WHERE d.defaclrole = migration_owner_oid
      AND d.defaclnamespace = public_schema_oid
      AND d.defaclobjtype = 'S'
      AND acl.grantee = runtime_oid
      AND (
        acl.privilege_type NOT IN ('USAGE', 'SELECT')
        OR acl.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'unsafe default sequence privileges';
  END IF;
END
$verify$;
