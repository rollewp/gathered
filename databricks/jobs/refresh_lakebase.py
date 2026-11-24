# Databricks notebook source
# Gathered nightly refresh (serverless job, runs as the workspace owner).
#
# 1. Recompute workspace.gathered.person_features and workspace.gathered.demand_gaps in Databricks
#    (the SQL is embedded from databricks/sql/*.sql by databricks/deploy.mjs: one source of truth).
# 2. Upsert them into Lakebase as the narrow role gathered_refresh (credentials come from the
#    Databricks secret scope "gathered"; nothing is hard-coded).
#
# Idempotent: a row is written only when a feature value differs (computed_at is excluded from the
# comparison), so a rerun on unchanged data inserts and updates nothing, and the database's
# invalidation triggers on person_features therefore invalidate no recommendation run.
#
# Returns a JSON summary through dbutils.notebook.exit.

import json
import time
import ssl
import pg8000.dbapi

NS = "workspace.gathered"
MIN_PEOPLE, PRESSURE_HIGH = 5, 4
PERSON_FEATURES_SQL = __PERSON_FEATURES_SQL__
DEMAND_GAPS_SQL = __DEMAND_GAPS_SQL__

t0 = time.time()
spark.sql(PERSON_FEATURES_SQL.replace("{NS}", NS))
spark.sql(DEMAND_GAPS_SQL.replace("{NS}", NS).replace("{MIN_PEOPLE}", str(MIN_PEOPLE)).replace("{PRESSURE_HIGH}", str(PRESSURE_HIGH)))

# pg8000 (pure Python): the psycopg2 binary wheel aborts on import in the serverless runtime.
conn = pg8000.dbapi.connect(
    host=dbutils.secrets.get("gathered", "pg_host"), port=int(dbutils.secrets.get("gathered", "pg_port")),
    database=dbutils.secrets.get("gathered", "pg_database"), user=dbutils.secrets.get("gathered", "pg_user"),
    password=dbutils.secrets.get("gathered", "pg_password"), ssl_context=ssl.create_default_context(), timeout=30)
cur = conn.cursor()
summary = {}


def upsert(table, key_cols, cols, row_template, rows):
    non_key = [c for c in cols if c not in key_cols]
    changed = " or ".join(f"{table}.{c} is distinct from excluded.{c}" for c in non_key)
    tail = (f"on conflict ({', '.join(key_cols)}) do update set {', '.join(f'{c} = excluded.{c}' for c in non_key)}, "
            f"computed_at = excluded.computed_at where {changed} returning (xmax = 0) as inserted")
    out = []
    for i in range(0, len(rows), 400):
        chunk = rows[i:i + 400]
        sql = f"insert into {table} ({', '.join(cols)}, computed_at) values " + ", ".join([row_template] * len(chunk)) + " " + tail
        cur.execute(sql, [v for row in chunk for v in row])
        out.extend(cur.fetchall())
    ins = sum(1 for r in out if r[0])
    return {"rows": len(rows), "inserted": ins, "updated": len(out) - ins, "unchanged": len(rows) - len(out)}


try:
    # ---- person_features
    FEATURE_COLS = ["person_id", "observed_weeks_12w", "attendance_rate_12w", "signal_sources", "signal_confidence",
                    "online_share_12w", "consistency_score", "busy_slots", "serving_areas", "kids_age_bands",
                    "tenure_months", "last_attended_on"]
    pf = spark.sql(f"select {', '.join(FEATURE_COLS)} from {NS}.person_features order by person_id").collect()
    rows = [tuple(r[c] for c in FEATURE_COLS) for r in pf]
    tpl = "(%s::uuid, %s, %s, %s::text[], %s, %s, %s, %s::text[], %s::text[], %s::text[], %s, %s, now())"
    summary["person_features"] = upsert("app.person_features", ["person_id"], FEATURE_COLS, tpl, rows)

    # ---- demand_gap (replace the current aggregate: upsert, then drop cohorts that no longer exist)
    DG_COLS = ["life_stage", "available_slot", "opted_in_ungrouped_count", "serving_group_count", "available_seat_count",
               "people_per_open_seat", "people_without_group_in_catalog", "people_without_reachable_group",
               "gap_classification", "gap_rank", "as_of_date"]
    dg = spark.sql(f"select {', '.join(DG_COLS)} from {NS}.demand_gaps").collect()
    rows = [tuple(r[c] for c in DG_COLS) for r in dg]
    tpl = "(" + ", ".join(["%s"] * len(DG_COLS)) + ", now())"
    summary["demand_gap"] = upsert("app.demand_gap", ["life_stage", "available_slot"], DG_COLS, tpl, rows)
    keys = [(r["life_stage"], r["available_slot"]) for r in dg]
    cur.execute("delete from app.demand_gap where (life_stage, available_slot) not in (select * from unnest(%s::text[], %s::text[]))",
                ([k[0] for k in keys], [k[1] for k in keys]))
    summary["demand_gap"]["deleted"] = cur.rowcount

    conn.commit()
except Exception:
    conn.rollback()
    raise
finally:
    conn.close()

summary["seconds"] = round(time.time() - t0, 1)
dbutils.notebook.exit(json.dumps(summary))
