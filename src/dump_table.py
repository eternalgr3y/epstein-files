#!/usr/bin/env python3
"""Dump one D1 table to a gzipped .sql file via paginated queries.

Exists because the D1 export API cannot dump this database: exports die
server-side mid-upload with no error message once a table is large enough
(mentions always, multi-table exports always). This walks the table by
primary key through the /raw query endpoint instead, which also avoids the
export lock that makes the database unavailable to the live site.

Usage: dump_table.py <table> <out.sql.gz> [rows_per_page]
Use a small page size for tables with large rows (document_texts holds the
full OCR text twice per row).
Requires CLOUDFLARE_API_TOKEN in the environment (source .env first).
"""

import gzip
import json
import os
import sys
import time
import urllib.request

ACCOUNT = "cc7a2789c16e07eb3886901477982a16"
DB_ID = "ae344bab-8a31-422d-bb07-fc07d5d69189"
PAGE = 5000
ROWS_PER_INSERT = 500

URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB_ID}/raw"


def query(sql, params=None, attempts=6):
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        URL,
        data=body,
        headers={
            "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.load(resp)
            if data.get("success"):
                return data["result"][0]["results"]
            raise RuntimeError(data.get("errors"))
        except Exception as e:  # noqa: BLE001 - retry any transient failure
            if attempt == attempts - 1:
                raise
            wait = 2 ** attempt
            print(f"  query failed ({e}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    global PAGE
    table, out_path = sys.argv[1], sys.argv[2]
    if len(sys.argv) > 3:
        PAGE = int(sys.argv[3])
    if not table.isidentifier():
        raise SystemExit(f"suspicious table name: {table}")

    schema = query("SELECT sql FROM sqlite_master WHERE name = ?", [table])
    if not schema["rows"]:
        raise SystemExit(f"no such table: {table}")
    create_sql = schema["rows"][0][0]

    total = 0
    last_id = -1
    with gzip.open(out_path, "wt", encoding="utf-8") as out:
        out.write(f"DROP TABLE IF EXISTS {table};\n{create_sql};\n")
        while True:
            page = query(
                f"SELECT * FROM {table} WHERE id > ? ORDER BY id LIMIT {PAGE}",
                [last_id],
            )
            rows = page["rows"]
            if not rows:
                break
            columns = ", ".join(page["columns"])
            for start in range(0, len(rows), ROWS_PER_INSERT):
                chunk = rows[start:start + ROWS_PER_INSERT]
                values = ",\n".join(
                    "(" + ", ".join(sql_literal(v) for v in row) + ")"
                    for row in chunk
                )
                out.write(f"INSERT INTO {table} ({columns}) VALUES\n{values};\n")
            id_index = page["columns"].index("id")
            last_id = rows[-1][id_index]
            total += len(rows)
            if total % 100000 < PAGE:
                print(f"  {table}: {total} rows dumped", file=sys.stderr)

    print(f"{table}: {total} rows -> {out_path}")


if __name__ == "__main__":
    main()
