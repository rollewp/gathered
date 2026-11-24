# Databricks notebook source
# Connectivity probe: can serverless job compute open a TCP connection to the Lakebase endpoint?
# No credentials are used or sent.
import socket, importlib.util, json
host = dbutils.widgets.get("host")
res = {}
try:
    s = socket.create_connection((host, 5432), timeout=10); s.close(); res["tcp_5432"] = "open"
except Exception as e:
    res["tcp_5432"] = f"failed: {type(e).__name__}: {e}"
res["psycopg2"] = importlib.util.find_spec("psycopg2") is not None
res["psycopg"] = importlib.util.find_spec("psycopg") is not None
try:
    import databricks.sdk as sdk; res["sdk"] = sdk.version.__version__
except Exception as e:
    res["sdk"] = f"n/a {e}"
dbutils.notebook.exit(json.dumps(res))
