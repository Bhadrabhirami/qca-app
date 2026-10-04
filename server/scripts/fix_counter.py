#!/usr/bin/env python3
"""Fix receipt counter to match actual DB max."""
import sqlite3, os

DB = os.getenv("DATABASE_PATH", "/opt/qca_app/qca.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

row = conn.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTR(receipt_no,5) AS INTEGER)),0) AS m "
    "FROM payments WHERE receipt_no LIKE 'REC-%'"
).fetchone()
correct = (row["m"] or 0) + 1

conn.execute(
    "UPDATE sys_counters SET next_value=? WHERE counter_name='receipt_no'",
    (correct,)
)
conn.commit()

verify = conn.execute(
    "SELECT next_value FROM sys_counters WHERE counter_name='receipt_no'"
).fetchone()
print(f"DB max receipt : REC-{row['m']}")
print(f"Counter now    : {verify['next_value']}")
print(f"Next receipt   : REC-{verify['next_value']}")
conn.close()
