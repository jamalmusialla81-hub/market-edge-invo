"""DATA 12 (#62): drift monitor. Synthetic shift is flagged, stable data is quiet, nothing else is written."""
import os
import random
import sqlite3
import time
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from market_edge_exec.api.app import create_app
from market_edge_exec.monitoring import drift as D
from market_edge_exec.shadow.store import ShadowStore, _blob

os.environ.setdefault("MARKET_EDGE_EXEC_API_KEY", "test-key")
HEADERS = {"X-API-Key": "test-key"}
DAY = D.DAY_MS
T0 = 1_800_000_000_000


def put(store, i, ts, *, asset="BTC", strategy="trend", score=60.0, atr=1.0, rsi=50.0, reason=None):
    decision = {"candidate": {"direction": "long", "quant_score": score}, "features": {"h1": {"atr": atr, "rsi": rsi}}}
    with closing(store._connect()) as c:
        c.execute("INSERT OR IGNORE INTO shadow_scans (scan_id, decision_ts, scan_state, execution_decision, n_markets, n_candidates, generator_version, feature_version, dataset_version, detail, created_at_ms) "
                  "VALUES ('s', 0, 'X', 'NO_SIGNAL', 1, 1, 'g', 'f', 'd', x'00', 0)")
        c.execute("INSERT INTO shadow_observations (observation_id, scan_id, kind, asset, coin, direction, strategy, decision_ts, first_bar_ts, is_production_pick, "
                  "execution_status, execution_rejection_reason, research_candidate_valid, observation_cluster_id, market_episode_id, overlap_fraction, generator_version, "
                  "feature_version, dataset_version, outcome_venue, outcome_interval, decision, decision_hash, created_at_ms) "
                  "VALUES (?, 's', 'CANDIDATE', ?, ?, 'long', ?, ?, ?, 0, 'NOT_SUBMITTED', ?, 1, 'c', 'e', 0, 'g', 'f', 'd', 'V', '5m', ?, 'h', 0)",
                  (f"o{i}", asset, asset, strategy, ts, ts, reason, _blob(decision)))
        c.commit()


def fill(store, start, days, per_day, rng, **kw):
    n = 0
    for d in range(days):
        for k in range(per_day):
            n += 1
            ts = start + d * DAY + k * 60_000
            args = {"score": rng.gauss(60, 5), "atr": rng.gauss(1.0, 0.1), "rsi": rng.gauss(50, 8),
                    "asset": rng.choice(["BTC", "ETH", "SOL"]), "strategy": rng.choice(["trend", "breakout"]),
                    "reason": rng.choice([None, "RISK_CAP", "SPREAD"])}
            args.update({k2: (v(rng) if callable(v) else v) for k2, v in kw.items()})
            put(store, f"{start}-{n}", ts, **args)


@pytest.fixture
def store(tmp_path):
    return ShadowStore(str(tmp_path / "s.sqlite3"))


def baseline(store, rng=None):
    fill(store, T0, 5, 20, rng or random.Random(1))
    return D.create_baseline(store, None, "main", T0, T0 + 5 * DAY, now_ms=T0 + 5 * DAY)


def test_psi_is_zero_for_identical_and_grows_with_shift():
    assert D.psi([0.5, 0.5], [0.5, 0.5]) == 0
    assert D.psi([0.5, 0.5], [0.3, 0.7]) < D.psi([0.5, 0.5], [0.1, 0.9])
    assert D.level_of(0.05) == "STABLE" and D.level_of(0.15) == "FLAG" and D.level_of(0.4) == "ALERT"


def test_stable_data_raises_nothing(store):
    baseline(store)
    fill(store, T0 + 5 * DAY, 5, 20, random.Random(2))
    out = D.run(store, None, "main", None, 5, T0 + 10 * DAY)
    assert out["recommendation"]["status"] in ("NONE", "FLAG"), out["recommendation"]
    assert not out["recommendation"]["alert_dimensions"], out["recommendation"]
    assert out["alert_rows_written"] == 0 or all(a["level"] != "ALERT" for a in store.drift_alert_history())


def test_a_synthetic_shift_is_flagged_on_the_shifted_dimensions_only(store):
    baseline(store)
    fill(store, T0 + 5 * DAY, 5, 20, random.Random(3), score=lambda r: r.gauss(75, 5), atr=lambda r: r.gauss(2.0, 0.2), asset="SOL")
    out = D.run(store, None, "main", None, 5, T0 + 10 * DAY)
    alerts = set(out["recommendation"]["alert_dimensions"])
    assert {"score", "feature.h1.atr", "volatility.h1.atr", "asset_mix"} <= alerts
    assert "feature.h1.rsi" not in alerts
    assert out["recommendation"]["status"] == "RECOMMEND_REVIEW"       # three or more dimensions in ALERT
    assert all(a["level"] == "ALERT" for a in store.drift_alert_history() if a["dimension"] == "score")


def test_activity_rate_collapse_is_flagged(store):
    baseline(store)
    fill(store, T0 + 5 * DAY, 5, 4, random.Random(4))            # 5x fewer scans per day
    out = D.run(store, None, "main", None, 5, T0 + 10 * DAY)
    rate = next(f for f in out["findings"] if f["dimension"] == "activity.observations")
    assert rate["level"] == "ALERT" and rate["statistic"] >= D.RATE_ALERT_RATIO


def test_thin_current_data_is_insufficient_not_alarming(store):
    baseline(store)
    fill(store, T0 + 5 * DAY, 1, 5, random.Random(5), score=90.0)   # only 5 rows, wildly different
    out = D.run(store, None, "main", None, 1, T0 + 6 * DAY)
    score = next(f for f in out["findings"] if f["dimension"] == "score")
    assert score["level"] == "INSUFFICIENT_DATA" and score["statistic"] is None
    assert "score" not in out["recommendation"]["alert_dimensions"]


def test_baselines_are_named_versioned_and_immutable(store):
    first = baseline(store)
    second = D.create_baseline(store, None, "main", T0, T0 + 5 * DAY)
    assert (first["version"], second["version"]) == (1, 2)
    assert store.drift_baseline("main")["version"] == 2 and store.drift_baseline("main", 1)["version"] == 1
    with sqlite3.connect(store.path) as c:
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            c.execute("UPDATE drift_baselines SET name='x'")
        with pytest.raises(sqlite3.DatabaseError, match="SHADOW_RESEARCH_ROW_IMMUTABLE"):
            c.execute("DELETE FROM drift_baselines")


def test_an_empty_window_cannot_become_a_baseline(store):
    with pytest.raises(ValueError, match="TOO_FEW_RECORDS"):
        D.create_baseline(store, None, "main", T0, T0 + DAY)


def test_rerun_is_quiet_and_only_changes_are_recorded(store):
    baseline(store)
    fill(store, T0 + 5 * DAY, 5, 20, random.Random(3), score=lambda r: r.gauss(75, 5))
    first = D.run(store, None, "main", None, 5, T0 + 10 * DAY)
    again = D.run(store, None, "main", None, 5, T0 + 10 * DAY + 1000)
    assert first["alert_rows_written"] > 0 and again["alert_rows_written"] == 0


def _tables(path):
    with closing(sqlite3.connect(path)) as c:
        return {t: c.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()}


def test_a_check_writes_only_its_own_alert_table(store):
    baseline(store)
    fill(store, T0 + 5 * DAY, 5, 20, random.Random(3), score=lambda r: r.gauss(75, 5))
    before = _tables(store.path)
    D.run(store, None, "main", None, 5, T0 + 10 * DAY)
    after = _tables(store.path)
    changed = {t for t in after if after[t] != before[t]}
    assert changed == {"drift_alerts"}


def test_no_production_mutation_path_in_the_module():
    import inspect
    src = inspect.getsource(D)
    for banned in ("ControlStore", "set_setting", "PaperLedger", "PaperEngine", "sizing_runtime", "requests", "urllib", "httpx"):
        assert banned not in src


def test_api_flow(tmp_path):
    app = create_app(db_path=str(tmp_path / "p.sqlite3"), shadow_db_path=str(tmp_path / "s.sqlite3"))
    client = TestClient(app)
    assert client.get("/research/drift?baseline=x").status_code == 401
    assert client.get("/research/drift?baseline=x", headers=HEADERS).status_code == 404
    assert client.post("/research/drift/baselines", headers=HEADERS, json={"name": "m", "start_ms": 1, "end_ms": 2}).status_code == 422
    now = int(time.time() * 1000)
    rng = random.Random(7)
    fill(app.state.shadow, now - 20 * DAY, 10, 20, rng)
    made = client.post("/research/drift/baselines", headers=HEADERS, json={"name": "m", "start_ms": now - 20 * DAY, "end_ms": now - 10 * DAY})
    assert made.status_code == 200 and made.json()["version"] == 1
    fill(app.state.shadow, now - 5 * DAY, 5, 20, rng, score=lambda r: r.gauss(80, 3))
    out = client.get("/research/drift?baseline=m&window_days=6", headers=HEADERS).json()
    assert "score" in out["recommendation"]["alert_dimensions"] and out["label"].startswith("RESEARCH ONLY")
    assert client.get("/research/drift/alerts?baseline=m", headers=HEADERS).json()["alerts"]
    assert client.get("/research/drift/baselines", headers=HEADERS).json()["baselines"][0]["name"] == "m"
