# The two pgrust gaps, reduced: one statement, and 113 grantees

- Date: 2026-09-08
- Runtime: bun 1.4.2 (the wasm lanes) and node 26.8.1 (the native lane) on Linux 7.0.0-30-generic
  (x86_64, 8 logical cores), no browser
- Engines
  - **PGlite** `@pgxsinkit/pglite` 0.5.5-pgx.3 — `PostgreSQL 18.3 (PGlite 0.5.5) on
    wasm32-unknown-linux-gnu, compiled by emcc 3.1.74, 32-bit`. The baseline: what these files are
    supposed to do.
  - **pgrust wasm** — `pgrust 0.2 (PostgreSQL 18.3 compatible) on wasm32-wasip1-threads, 64-bit`,
    commit `d13d781fb9`, memory store, the lane the unit suite ran on.
  - **pgrust native** — the same commit built for x86_64 (`target/debug/postgres`), `--host-pipes`
    over ordinary file descriptors, on a cluster `initdb`'d by PostgreSQL 18.3's own `initdb`.
- Driver: `bun run repro:pgrust` (`scripts/pgrust-repro.ts`)

## Why

`2026-09-07-pgxsinkit-unit-suite-on-pgrust.md` ran pgxsinkit's 1987-test unit suite on pgrust and
came back with 19 failures and exactly two causes:

| Cause | Tests | Where they were |
| --- | --- | --- |
| `funcapi exprType: node family T_NullIfExpr not ported` | 18 | `plpgsql-apply` (17), `apply-function-schema` (1) |
| `aclchk: compressed/external ACL varlena — detoast gap` | 1 | `plpgsql-apply` |

Both are pgrust naming its own gap, so both were already placeable — but "pgxsinkit's generated apply
function does it" is not a bug report. This note reduces each to SQL that mentions nothing from
pgxsinkit, states the minimum it takes to reach the gap, and answers the one question the suite could
not: **is it wasm-only?** It is not. Both reproduce on native pgrust, byte-identical error text.

| File | PGlite | pgrust wasm | pgrust native |
| --- | --- | --- | --- |
| `scripts/pgrust-repro-nullif.sql` | `1` | `ERROR: funcapi exprType: node family T_NullIfExpr not ported` | same |
| `scripts/pgrust-repro-acl-detoast.sql` | `t` | `ERROR: aclchk: compressed/external ACL varlena — detoast gap` | same |

Nothing here was filed. The two draft issues below are ready to be.

---

## Bug 1 — `exprType` has no `T_NullIfExpr` arm, so `NULLIF` cannot be an argument of a `"any"` function

### The reproduction, verbatim

`scripts/pgrust-repro-nullif.sql`, one statement, no DDL, no PL/pgSQL:

```sql
SELECT format('%s', NULLIF(g, 0)) AS out FROM generate_series(1, 1) AS g;
```

### The error, verbatim

```
ERROR:  funcapi exprType: node family T_NullIfExpr not ported
```

and, in the native postmaster's log, the panic behind it:

```
thread 'pg:backend:1031' (1383561) panicked at crates/backend/utils/fmgr/funcapi/src/lib.rs:133:16:
funcapi exprType: node family T_NullIfExpr not ported
```

PostgreSQL 18.3 and PGlite 0.5.5 return one row, `1`.

### What it needs at minimum

Two things, and only two:

1. **A function whose argument type is resolved at run time** — anything declared with `"any"` or
   `VARIADIC "any"`, because those functions have no static argument type and ask fmgr instead.
   Confirmed on `format`, `concat`, `concat_ws` and `json_build_object`.
2. **A `NULLIF` argument that survives constant folding.** Any non-`Const` input does it — a table
   column, a `generate_series` value, a PL/pgSQL variable.

Everything else is incidental. Measured, on the same builds:

| Variant | pgrust |
| --- | --- |
| `SELECT NULLIF(g, 0) FROM generate_series(1, 1) AS g` | **OK** — `NULLIF` itself is fine |
| `SELECT format('%s', NULLIF('p'::text, ''))` | **OK** — folded to a `Const` before execution |
| `SELECT format('%s', concat_ws(', ', NULLIF(t.a, ''), 'b')) FROM (VALUES ('p'::text)) AS t(a)` | **OK** — a one-row `VALUES` is pulled up, and the fold follows |
| `PREPARE q(text) AS SELECT format('%s', NULLIF($1, '')); EXECUTE q('p')` | **OK** — the custom plan substitutes the parameter |
| `SELECT format('%s', NULLIF(g, 0)) FROM generate_series(1, 1) AS g` | **ERROR** |
| `SELECT concat_ws(',', NULLIF(g, 0), 'b') FROM generate_series(1, 1) AS g` | **ERROR** |
| `SELECT json_build_object('k', NULLIF(a, '')) FROM t` (a `text` column) | **ERROR** |
| `DO $$ DECLARE v text := 'a'; BEGIN RAISE NOTICE '%', nullif(v, ''); END $$` | **OK** |
| `DO $$ DECLARE v text := 'a'; BEGIN RAISE NOTICE '%', format('%s', nullif(v, '')); END $$` | **ERROR** |

It is NOT about PL/pgSQL, not about set-returning functions, and not about polymorphic return types —
the 2026-09-07 note guessed "a set-returning PL/pgSQL function's result type", and that guess was
wrong. It is the fmgr **argument**-type walk, nothing else.

### Where it is in pgrust

`crates/backend/utils/fmgr/funcapi/src/lib.rs:100` — `expr_type`, C's `exprType` (`nodeFuncs.c`) over
the families a call expression can carry. Twenty-four arms, then:

```rust
        NodeTag::T_SQLValueFunction => node.as_sql_value_function().unwrap().r#type,
        tag => panic!("funcapi exprType: node family {tag:?} not ported"),   // :133
    }
}
```

The path in: a `"any"` function calls `get_fn_expr_argtype` (`:172`), which hands the `fn_expr` node
to `get_call_expr_argtype` (`:187`), which walks to the argument and calls `expr_type` on it
(`:196`). The argument is the `NullIfExpr`. C's `exprType` answers `((NullIfExpr *) expr)->opresulttype`
there (`nodeFuncs.c`); this port has no such arm, so it panics.

### `NULLIF` is one of eight

`T_NullIfExpr` is simply the family a real workload reached first. The same `match` is missing most
of C's `exprType`, and every one of these was measured on the same builds, as
`SELECT format('%s', <expression>) AS out FROM generate_series(1, 1) AS g;`:

| Expression | PGlite | pgrust |
| --- | --- | --- |
| `NULLIF(g, 0)` | `1` | `T_NullIfExpr not ported` |
| `GREATEST(g, 0)` | `1` | `T_MinMaxExpr not ported` |
| `g IS NULL` | `f` | `T_NullTest not ported` |
| `g > 0 AND g < 5` | `t` | `T_BoolExpr not ported` |
| `g IS DISTINCT FROM 0` | `t` | `T_DistinctExpr not ported` |
| `(g > 0) IS TRUE` | `t` | `T_BooleanTest not ported` |
| `g = ANY (ARRAY[1, 2])` | `t` | `T_ScalarArrayOpExpr not ported` |
| `(SELECT max(x) FROM generate_series(1, g) AS x)` | `1` | `T_SubPlan not ported` |
| `g::text COLLATE "C"` | `1` | `1` — the planner strips `CollateExpr`, so it never reaches the walk |

`format('%s', a AND b)` and `format('%s', GREATEST(a, b))` are ordinary SQL; this is one fix, not
eight.

### Does native pgrust reproduce it?

**Yes**, identically. Same commit, x86_64 `target/debug/postgres`, a real `initdb`'d cluster, the
same error text and the same panic site. Nothing about it is wasm-specific — the walker never sees a
pointer width.

### Draft issue

> **Title:** `exprType` is missing `T_NullIfExpr` and seven sibling families, so `NULLIF`, `GREATEST`, `IS NULL` and `AND` cannot be arguments of a `"any"` function
>
> **Body:**
>
> `funcapi`'s `expr_type` has no `T_NullIfExpr` arm, so any function that resolves its argument types
> through fmgr at run time — everything declared `"any"` or `VARIADIC "any"` — fails when one of its
> arguments is a `NULLIF` expression.
>
> **Version:** `pgrust 0.2 (PostgreSQL 18.3 compatible)`, commit `d13d781fb9`.
> **Targets:** reproduced on `wasm32-wasip1-threads` (64-bit `Datum`, memory store) **and** on a
> native `x86_64-unknown-linux-gnu` `--host-pipes` build of the same commit. Not target-specific.
>
> **Reproduction** — one statement, no DDL:
>
> ```sql
> SELECT format('%s', NULLIF(g, 0)) AS out FROM generate_series(1, 1) AS g;
> ```
>
> **Actual:**
>
> ```
> ERROR:  funcapi exprType: node family T_NullIfExpr not ported
> ```
>
> ```
> thread 'pg:backend:1031' panicked at crates/backend/utils/fmgr/funcapi/src/lib.rs:133:16:
> funcapi exprType: node family T_NullIfExpr not ported
> ```
>
> **Expected** (PostgreSQL 18.3, and PGlite 0.5.5 which is PostgreSQL 18.3 compiled to wasm): one
> row, `1`.
>
> **What is required to hit it**
>
> - a function with a run-time-resolved argument type — `format`, `concat`, `concat_ws` and
>   `json_build_object` all confirmed, and every other `"any"` / `VARIADIC "any"` function resolves
>   the same way;
> - a `NULLIF` argument that is not constant-folded away. `generate_series` above is only there for
>   that; a table column or a PL/pgSQL variable behaves the same, while `NULLIF('a'::text, '')` folds
>   to a `Const` and the walker is never reached.
>
> `NULLIF` on its own is fine (`SELECT NULLIF(g, 0) FROM generate_series(1, 1) AS g` answers), so this
> is only the fmgr argument-type walk.
>
> **Where**
>
> `crates/backend/utils/fmgr/funcapi/src/lib.rs:100` `expr_type` → the catch-all `panic!` at `:133`,
> reached from `get_fn_expr_argtype` (`:172`) → `get_call_expr_argtype` (`:187`) → `expr_type` on the
> argument node (`:196`). C's `exprType` (`nodeFuncs.c`) answers
> `((const NullIfExpr *) expr)->opresulttype` for this family.
>
> **Scope: `NULLIF` is one of eight.** Substituting the argument in the same statement
> (`SELECT format('%s', <expression>) FROM generate_series(1, 1) AS g`) reaches seven more missing
> families, all of which PostgreSQL 18.3 answers:
>
> | Expression | pgrust |
> | --- | --- |
> | `NULLIF(g, 0)` | `T_NullIfExpr not ported` |
> | `GREATEST(g, 0)` | `T_MinMaxExpr not ported` |
> | `g IS NULL` | `T_NullTest not ported` |
> | `g > 0 AND g < 5` | `T_BoolExpr not ported` |
> | `g IS DISTINCT FROM 0` | `T_DistinctExpr not ported` |
> | `(g > 0) IS TRUE` | `T_BooleanTest not ported` |
> | `g = ANY (ARRAY[1, 2])` | `T_ScalarArrayOpExpr not ported` |
> | `(SELECT max(x) FROM generate_series(1, g) AS x)` | `T_SubPlan not ported` |
>
> C's `exprType` also carries `GroupingFunc`, `MergeSupportFunc`, `NamedArgExpr`, `SubLink`,
> `AlternativeSubPlan`, `FieldStore`, `CollateExpr`, `CaseTestExpr`, `RowCompareExpr`, `XmlExpr`,
> `JsonBehavior`, `SetToDefault`, `CurrentOfExpr`, `NextValueExpr`, `InferenceElem` and
> `PlaceHolderVar`, none of which are in this `match` either. This looks like one fix rather than
> eight.
>
> **Impact seen in the wild.** A generated PL/pgSQL function that builds DDL with
> `format('… %s …', concat_ws(', ', nullif(v_cols, ''), …))` takes 18 tests of an unrelated suite down
> with this one line.

---

## Bug 2 — a compressed ACL varlena is not detoasted, so a function with 113 grantees cannot be privilege-checked

### The reproduction, verbatim

`scripts/pgrust-repro-acl-detoast.sql`:

```sql
DO $$
BEGIN
  FOR i IN 1..113 LOOP
    EXECUTE format('CREATE ROLE pgrust_repro_g%s', i);
  END LOOP;
END;
$$;

CREATE FUNCTION public.pgrust_repro_f() RETURNS int LANGUAGE sql AS 'SELECT 1';

DO $$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.pgrust_repro_f() TO '
    || (SELECT string_agg(format('pgrust_repro_g%s', i), ', ') FROM generate_series(1, 113) AS i);
END;
$$;

SELECT has_function_privilege('pgrust_repro_g1', 'public.pgrust_repro_f()', 'EXECUTE') AS may_execute;
```

The single `GRANT` matters: it reads only the default (`NULL`) ACL and writes the compressed one, so
the first statement that READS a compressed `proacl` is the `SELECT` at the end. (Measured: the same
script ending in `SELECT pg_column_size(proacl) FROM pg_proc WHERE proname = 'pgrust_repro_f'`
succeeds on pgrust and reports 402 — the write side is fine.)

### The error, verbatim

```
ERROR:  aclchk: compressed/external ACL varlena — detoast gap
```

```
thread 'pg:backend:1031' (1383635) panicked at crates/backend/catalog/aclchk/src/lib.rs:92:13:
aclchk: compressed/external ACL varlena — detoast gap
```

PostgreSQL 18.3 and PGlite 0.5.5 return one row, `t`.

### What it needs at minimum

One condition: **a stored ACL varlena that the toaster did not leave plain**, and then any read of it
through `aclchk`.

The easy way to get one is grantee count, and the boundary is sharp. A `pg_proc` tuple is toasted
once it passes `TOAST_TUPLE_THRESHOLD` (2032 bytes on an 8 kB-page build); `proacl` is `aclitem[]`
with EXTENDED storage at 16 bytes an item, and an aclitem array compresses extremely well, so the
toaster picks it. Measured on both engines, which agree byte for byte:

| Grantee roles | `array_length(proacl, 1)` | `pg_column_size(proacl)` | `has_function_privilege` on pgrust |
| --- | --- | --- | --- |
| 112 | 114 | 1848 (plain) | OK |
| **113** | **115** | **402 (compressed)** | **ERROR** |
| 114 | 116 | 405 (compressed) | ERROR |
| 115 | 117 | 409 (compressed) | ERROR |

(115 aclitems, not 113: the owner and PUBLIC are in there too. 1864 bytes plain, which pglz stores as
402.)

**The ACL does not have to be large** — that is only the tidiest way to write the condition down. A
SMALL ACL inside a LARGE `pg_proc` tuple is compressed just as readily, which is the shape pgxsinkit
actually hit:

- Its generated apply function has a 4464-byte `prosrc` and a **four**-item `proacl` (owner, PUBLIC,
  and two roles from a consumer's `ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS`). The
  artifact's first `REVOKE ALL … FROM PUBLIC` succeeds — at that point `proacl` is still plain, 85
  bytes — and REWRITES the tuple with a `proacl` the toaster compresses to 38 bytes. The **next** ACL
  read, one statement later, is the one that fails.
- With ~1800–1950 bytes of incompressible function body the tuple crosses the threshold at `CREATE`
  time instead, `proacl` is stored compressed immediately, and the very first `REVOKE` fails.

Which readers trip it, measured:

| Reader | pgrust |
| --- | --- |
| `has_function_privilege(role, fn, 'EXECUTE')` | **ERROR** |
| `REVOKE EXECUTE ON FUNCTION … FROM role` | **ERROR** |
| `SELECT … FROM pg_proc p, aclexplode(p.proacl)` | **OK** — that path goes through `utils/adt/acl`, which detoasts |
| `SELECT pg_column_size(proacl) FROM pg_proc` | **OK** — never decodes the items |

So it is specifically `catalog/aclchk`'s in-place reader, not ACL handling in general.

### Where it is in pgrust

`crates/backend/catalog/aclchk/src/lib.rs:80` — `with_acl_datum`, described as "DatumGetAclP without
the container copy":

```rust
    let payload: &[u8] = unsafe {
        if varatt::varatt_is_1b_e(p) || (!varatt::varatt_is_1b(p) && !varatt::varatt_is_4b_u(p)) {
            // pg_class/pg_attribute have no toast tables; only inline
            // compression can appear here.
            panic!("aclchk: compressed/external ACL varlena — detoast gap");   // :92
        }
```

The comment states the assumption that the guard rests on, and the assumption is too narrow twice
over: `pg_proc` **does** have a toast table (`pg_toast_1255`), and inline compression alone is enough
to reach the `panic!` even on a relation that does not. C's `DatumGetAclP` (`utils/acl.h`) is
`PG_DETOAST_DATUM`, which handles both cases before any item is read.

`crates/backend/catalog/aclchk/src/grant.rs:1862` carries a guard of the same shape over a different
field — `ExecGrant_Parameter: compressed/external parname varlena — detoast gap`, on
`pg_parameter_acl.parname`, which is `text` rather than an ACL. Not reproduced here, but it looks
like the same omission.

### Does native pgrust reproduce it?

**Yes**, identically — same file, same panic site, same error text on the x86_64 `--host-pipes`
build. Toasting is decided by tuple size and `BLCKSZ`, neither of which changes with the target.

### Draft issue

> **Title:** `aclchk` does not detoast a compressed ACL: any privilege check on a function with ≥113 grantees fails
>
> **Body:**
>
> `catalog/aclchk`'s `with_acl_datum` reads a stored `aclitem[]` in place and raises on any varlena
> that is not plain, so once the toaster stores a catalog ACL compressed, every subsequent
> privilege check, `GRANT` and `REVOKE` against that object fails.
>
> **Version:** `pgrust 0.2 (PostgreSQL 18.3 compatible)`, commit `d13d781fb9`.
> **Targets:** reproduced on `wasm32-wasip1-threads` (64-bit `Datum`, memory store) **and** on a
> native `x86_64-unknown-linux-gnu` `--host-pipes` build of the same commit. Not target-specific.
>
> **Reproduction:**
>
> ```sql
> DO $$
> BEGIN
>   FOR i IN 1..113 LOOP
>     EXECUTE format('CREATE ROLE pgrust_repro_g%s', i);
>   END LOOP;
> END;
> $$;
>
> CREATE FUNCTION public.pgrust_repro_f() RETURNS int LANGUAGE sql AS 'SELECT 1';
>
> DO $$
> BEGIN
>   EXECUTE 'GRANT EXECUTE ON FUNCTION public.pgrust_repro_f() TO '
>     || (SELECT string_agg(format('pgrust_repro_g%s', i), ', ') FROM generate_series(1, 113) AS i);
> END;
> $$;
>
> SELECT has_function_privilege('pgrust_repro_g1', 'public.pgrust_repro_f()', 'EXECUTE') AS may_execute;
> ```
>
> **Actual:**
>
> ```
> ERROR:  aclchk: compressed/external ACL varlena — detoast gap
> ```
>
> ```
> thread 'pg:backend:1031' panicked at crates/backend/catalog/aclchk/src/lib.rs:92:13:
> aclchk: compressed/external ACL varlena — detoast gap
> ```
>
> **Expected** (PostgreSQL 18.3, and PGlite 0.5.5 which is PostgreSQL 18.3 compiled to wasm): one
> row, `t`.
>
> **What is required to hit it**
>
> A `proacl` the toaster did not leave plain, and then any `aclchk` read of it. 113 grantees is the
> measured boundary on an 8 kB-page build: 115 aclitems (the roles plus the owner plus PUBLIC) =
> 1864 bytes, which pushes the `pg_proc` tuple past `TOAST_TUPLE_THRESHOLD` and is stored compressed
> at 402 bytes. 112 grantees (114 items, 1848 bytes) still fits plain and answers normally. PGlite
> reports the same `pg_column_size(proacl)` at every count, so this is not a divergence in the
> toaster — only in the reader.
>
> Grantee count is just the shortest way to write the condition. A four-item ACL in a `pg_proc` tuple
> with a ~4.5 kB `prosrc` is compressed the same way: there, a first `REVOKE ALL … FROM PUBLIC`
> succeeds (the ACL is still plain, 85 bytes) and rewrites `proacl` as a 38-byte compressed value, and
> the next ACL read fails.
>
> **Readers affected:** `has_function_privilege` and `REVOKE` both fail. `aclexplode(p.proacl)` is
> fine — it goes through `utils/adt/acl`, which detoasts — so the gap is specifically the in-place
> reader in `aclchk`.
>
> **Where**
>
> `crates/backend/catalog/aclchk/src/lib.rs:80` `with_acl_datum`; the `panic!` is at `:92`:
>
> ```rust
> if varatt::varatt_is_1b_e(p) || (!varatt::varatt_is_1b(p) && !varatt::varatt_is_4b_u(p)) {
>     // pg_class/pg_attribute have no toast tables; only inline
>     // compression can appear here.
>     panic!("aclchk: compressed/external ACL varlena — detoast gap");
> }
> ```
>
> The comment names the assumption: `pg_proc` does have a toast table (`pg_toast_1255`), and inline
> compression alone reaches the `panic!` in any case. C's `DatumGetAclP` (`utils/acl.h`) is
> `PG_DETOAST_DATUM`, which handles both before any item is read.
>
> `crates/backend/catalog/aclchk/src/grant.rs:1862` carries a guard of the same shape over
> `pg_parameter_acl.parname` (a `text` field, not an ACL). Not reproduced here, but it may be the
> same omission.
>
> **Impact seen in the wild.** A deny-by-default install that revokes PUBLIC and then converges the
> remaining grantees — two ACL reads on the same function, in one migration — fails on the second.

---

## Reproducing

```
bun run repro:pgrust                        # all three lanes, one table, a verdict
PGRUST_DIR=/path/to/pgrust bun run repro:pgrust
PGRUST_NATIVE_BIN=/path/to/postgres …       # a specific native build
PGRUST_PGBIN=/usr/lib/postgresql/18/bin …   # where initdb is
```

The native lane needs a built `postgres` (`target/release/postgres` or `target/debug/postgres` under
`PGRUST_DIR`) and an `initdb`. Without either it reports `SKIPPED` with the reason and the run still
passes on the other two lanes; its datadir and postmaster log are left under
`tmp/agents/pgrust-repro/<case>/` for reading.

The script fails if a pgrust lane ever ANSWERS one of these files. That is the point: when either gap
is closed upstream, this is where it shows first, and this note is what then needs rewriting.
