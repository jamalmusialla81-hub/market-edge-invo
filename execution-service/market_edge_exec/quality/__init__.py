"""Data quality + validation gate (DATA 2, #52): one VALID / INVALID /
UNRESOLVED / QUARANTINED vocabulary for every forward-data row.

Read-only classification. A verdict lives in its own append-only table; the
original row is never rewritten, repaired or deleted."""
CHECKER_VERSION = "DATA-QUALITY-V1"
