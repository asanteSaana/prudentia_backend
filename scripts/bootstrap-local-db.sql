-- PrudenTia — one-off local database bootstrap.
--
-- Run ONCE as a superuser. Everything after this point is done by migrations.
--
--   psql -U postgres -h localhost -v ON_ERROR_STOP=1 -f scripts/bootstrap-local-db.sql
--
-- WHY THIS EXISTS, and why the app does not simply connect as `postgres`:
--
-- A superuser bypasses every GRANT. Connecting the application as `postgres` would make
-- the read-only role's restrictions invisible — the boot assertion would pass, the
-- Phase 7 defence-in-depth tests (D-01 to D-13) would pass, and all of it would be
-- vacuous, because a superuser can write to anything regardless of what was revoked.
-- The template estate hit exactly this and recorded it: a suite that "runs as postgres
-- and therefore never exercises RLS" is green against policies that reject every write.
--
-- ADR-03's whole argument is that two independent controls must both fail. Running as a
-- superuser deletes the second one while leaving the paperwork in place.
--
-- `prudentia_app` therefore has CREATEROLE (it must provision `prudentia_ro` from a
-- migration) but NOT SUPERUSER. This mirrors Azure Database for PostgreSQL Flexible
-- Server, where the admin login is a member of azure_pg_admin and can create roles but
-- is not a superuser — so the migration path is identical locally and in production.

\set app_password 'PrudenTiaApp#2026'

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prudentia_app') THEN
		CREATE ROLE prudentia_app LOGIN PASSWORD 'PrudenTiaApp#2026'
			NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
	ELSE
		ALTER ROLE prudentia_app WITH LOGIN PASSWORD 'PrudenTiaApp#2026'
			NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
	END IF;
END
$$;

SELECT 'CREATE DATABASE prudentia OWNER prudentia_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'prudentia')
\gexec

SELECT 'CREATE DATABASE prudentia_test OWNER prudentia_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'prudentia_test')
\gexec

\echo 'Bootstrap complete. prudentia_app owns prudentia and prudentia_test.'
\echo 'prudentia_ro is created by migration 20260812090200_readonly_role.ts, not here.'
