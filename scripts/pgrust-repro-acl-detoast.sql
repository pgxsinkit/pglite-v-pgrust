-- pgrust bug 2 — `ERROR: aclchk: compressed/external ACL varlena — detoast gap`
--
-- `aclchk`'s `with_acl_datum` reads the stored `aclitem[]` in place and refuses any varlena that is
-- not plain: a 4-byte COMPRESSED header (or an external TOAST pointer) raises instead of being
-- detoasted. So the bug needs one thing only — a catalog ACL that the toaster stored compressed —
-- and then ANY read through aclchk trips it: `has_function_privilege`, a `GRANT`, a `REVOKE`.
--
-- The smallest way to get one is grantee count. A `pg_proc` tuple is toasted once it passes
-- TOAST_TUPLE_THRESHOLD (2032 bytes on an 8 kB-page build); `proacl` is `aclitem[]` with EXTENDED
-- storage and 16 bytes per item, and an aclitem array is very compressible, so the toaster picks it.
-- 113 grantees is the boundary measured on PostgreSQL 18.3: 115 aclitems (the 113 roles + the owner +
-- PUBLIC) = 1864 bytes plain, which pglz stores as 402. 112 grantees (114 items, 1848 bytes) still
-- fits plain and pgrust answers normally, so the failure appears exactly at 113 and at every count
-- above it.
--
-- The size of the ACL is not the real requirement, only the easiest one to write down: a SMALL ACL in
-- a LARGE `pg_proc` tuple compresses just as well, which is how a generated PL/pgSQL function with a
-- ~4.5 kB body and four aclitems reaches the same error.
--
-- PostgreSQL 18.3 / PGlite 0.5.5: one row, `t`.
DO $$
BEGIN
  FOR i IN 1..113 LOOP
    EXECUTE format('CREATE ROLE pgrust_repro_g%s', i);
  END LOOP;
END;
$$;

CREATE FUNCTION public.pgrust_repro_f() RETURNS int LANGUAGE sql AS 'SELECT 1';

-- One GRANT, so the write that fills proacl reads only the default (NULL) ACL and the compressed
-- value is first READ by the statement below.
DO $$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.pgrust_repro_f() TO '
    || (SELECT string_agg(format('pgrust_repro_g%s', i), ', ') FROM generate_series(1, 113) AS i);
END;
$$;

SELECT has_function_privilege('pgrust_repro_g1', 'public.pgrust_repro_f()', 'EXECUTE') AS may_execute;
