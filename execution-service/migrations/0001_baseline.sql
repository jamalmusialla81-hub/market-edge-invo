-- 0001 baseline: adopts the schema the stores create themselves
-- (persistence/store.py, paper/ledger.py, control/settings.py all use
-- CREATE TABLE IF NOT EXISTS). Databases created before versioning existed
-- have PRAGMA user_version = 0 and are stamped to 1 here without any change
-- to their tables or rows.
SELECT 1;
