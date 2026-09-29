"""The simple challenger family (DATA 6): random baseline, current-Quant baseline, ridge regression, boosted stumps.

Pure Python, deterministic, no neural nets. Every model is fitted on the TRAIN split of a frozen
snapshot only; validation and OOS rows are never read by fit(). Missing feature values are imputed
with the TRAIN median (recorded in the artifact); nothing is fitted on the future.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import sqlite3
from contextlib import closing
from typing import Any, Optional

from market_edge_exec.training import TRAINING_VERSION


class TrainingError(ValueError):
    pass


def load_snapshot(folder: str) -> dict:
    """Verifies the snapshot is intact (recomputed content hash equals the manifest's) and returns rows grouped by split."""
    manifest = json.load(open(os.path.join(folder, "manifest.json")))
    path = os.path.join(folder, "snapshot.sqlite3")
    with closing(sqlite3.connect("file:" + os.path.abspath(path).replace("\\", "/") + "?mode=ro", uri=True)) as c:
        c.row_factory = sqlite3.Row
        rows = [dict(r) for r in c.execute("SELECT * FROM snapshot_rows ORDER BY decision_ts, observation_id")]
    paths = manifest["feature_paths"]
    canon = json.dumps({"paths": paths, "target": manifest["target"]["name"], "rows": [
        {"observation_id": r["observation_id"], "scan_id": r["scan_id"], "cluster_id": r["cluster_id"], "episode_id": r["episode_id"], "split": r["split"],
         "decision_ts": r["decision_ts"], "window_end_ts": r["window_end_ts"], "asset": r["asset"], "strategy": r["strategy"], "direction": r["direction"],
         "features": json.loads(r["features"]), "quant_score": r["quant_score"], "regime": r["regime"], "target": r["target"]} for r in rows]}, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if hashlib.sha256(canon.encode()).hexdigest() != manifest["content_hash"]:
        raise TrainingError("SNAPSHOT_HASH_MISMATCH: the snapshot no longer matches its manifest")
    return {"manifest": manifest, "paths": paths, "rows": rows}


def _matrix(rows: list[dict], paths: list[str], medians: Optional[dict] = None):
    feats = [json.loads(r["features"]) for r in rows]
    if medians is None:
        medians = {}
        for p in paths:
            vals = sorted(f[p] for f in feats if isinstance(f.get(p), (int, float)))
            medians[p] = vals[len(vals) // 2] if vals else 0.0
    X = [[(f[p] if isinstance(f.get(p), (int, float)) else medians[p]) for p in paths] for f in feats]
    return X, medians


class RandomBaseline:
    name = "random_baseline"

    def __init__(self, seed: int):
        self.seed = seed

    def fit(self, rows, paths):
        return self

    def predict(self, rows):
        rng = random.Random(self.seed)
        return [rng.random() for _ in rows]

    def artifact(self):
        return {"model": self.name, "seed": self.seed}


class QuantBaseline:
    """The production Quant score as the prediction: the bar every challenger has to beat."""
    name = "quant_baseline"

    def fit(self, rows, paths):
        return self

    def predict(self, rows):
        return [r["quant_score"] if r["quant_score"] is not None else float("-inf") for r in rows]

    def artifact(self):
        return {"model": self.name, "input": "candidate.quant_score at decision time"}


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(a)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-12:
            raise TrainingError("SINGULAR_SYSTEM")
        m[col], m[piv] = m[piv], m[col]
        for r in range(n):
            if r != col:
                f = m[r][col] / m[col][col]
                if f:
                    m[r] = [x - f * y for x, y in zip(m[r], m[col])]
    return [m[i][n] / m[i][i] for i in range(n)]


class Ridge:
    name = "ridge"

    def __init__(self, alpha: float = 10.0):
        self.alpha = alpha

    def fit(self, rows, paths):
        X, self.medians = _matrix(rows, paths)
        y = [r["target"] for r in rows]
        self.paths = paths
        n = len(X)
        self.mean = [sum(c) / n for c in zip(*X)]
        self.sd = [math.sqrt(sum((v - m) ** 2 for v in c) / n) for c, m in zip(zip(*X), self.mean)]
        keep = [j for j, s in enumerate(self.sd) if s > 1e-12]
        self.keep = keep
        Z = [[(row[j] - self.mean[j]) / self.sd[j] for j in keep] for row in X]
        self.y_mean = sum(y) / n
        yc = [v - self.y_mean for v in y]
        k = len(keep)
        a = [[sum(z[i] * z[j] for z in Z) + (self.alpha if i == j else 0.0) for j in range(k)] for i in range(k)]
        b = [sum(z[i] * v for z, v in zip(Z, yc)) for i in range(k)]
        self.coef = _solve(a, b) if k else []
        return self

    def predict(self, rows):
        X, _ = _matrix(rows, self.paths, self.medians)
        return [self.y_mean + sum(c * (row[j] - self.mean[j]) / self.sd[j] for c, j in zip(self.coef, self.keep)) for row in X]

    def artifact(self):
        return {"model": self.name, "alpha": self.alpha, "intercept": self.y_mean, "medians": self.medians,
                "coefficients": {self.paths[j]: c for j, c in zip(self.keep, self.coef)}, "standardisation": {self.paths[j]: [self.mean[j], self.sd[j]] for j in self.keep}}


class BoostedStumps:
    """Gradient-boosted regression stumps (squared error). Small on purpose."""
    name = "gbm_stumps"

    def __init__(self, rounds: int = 40, learning_rate: float = 0.1, thresholds: int = 8, min_leaf: int = 5):
        self.rounds, self.lr, self.thresholds, self.min_leaf = rounds, learning_rate, thresholds, min_leaf

    def fit(self, rows, paths):
        X, self.medians = _matrix(rows, paths)
        y = [r["target"] for r in rows]
        self.paths, n = paths, len(y)
        self.base = sum(y) / n
        pred, self.stumps = [self.base] * n, []
        cand = []
        for j in range(len(paths)):
            col = sorted(row[j] for row in X)
            cuts = sorted({col[min(n - 1, int(n * q / (self.thresholds + 1)))] for q in range(1, self.thresholds + 1)})
            cand.append(cuts)
        for _ in range(self.rounds):
            resid = [a - b for a, b in zip(y, pred)]
            best = None
            for j, cuts in enumerate(cand):
                for t in cuts:
                    l = [r for row, r in zip(X, resid) if row[j] <= t]
                    r_ = [r for row, r in zip(X, resid) if row[j] > t]
                    if len(l) < self.min_leaf or len(r_) < self.min_leaf:
                        continue
                    ml, mr = sum(l) / len(l), sum(r_) / len(r_)
                    gain = len(l) * ml * ml + len(r_) * mr * mr
                    if best is None or gain > best[0] + 1e-12:
                        best = (gain, j, t, ml, mr)
            if best is None:
                break
            _, j, t, ml, mr = best
            self.stumps.append((paths[j], t, self.lr * ml, self.lr * mr))
            pred = [p + (self.lr * ml if row[j] <= t else self.lr * mr) for p, row in zip(pred, X)]
        return self

    def predict(self, rows):
        X, _ = _matrix(rows, self.paths, self.medians)
        idx = {p: i for i, p in enumerate(self.paths)}
        return [self.base + sum((lv if row[idx[p]] <= t else rv) for p, t, lv, rv in self.stumps) for row in X]

    def artifact(self):
        return {"model": self.name, "rounds": len(self.stumps), "learning_rate": self.lr, "base": self.base, "medians": self.medians,
                "stumps": [{"feature": p, "threshold": t, "left": lv, "right": rv} for p, t, lv, rv in self.stumps]}


def family(seed: int) -> list:
    return [RandomBaseline(seed), QuantBaseline(), Ridge(), BoostedStumps()]


def train_family(snapshot: dict, seed: int, models: Optional[list] = None) -> dict:
    """Fits every model on the TRAIN split only. Returns {model_name: {artifact, artifact_hash}} and the split sizes used."""
    train = [r for r in snapshot["rows"] if r["split"] == "TRAIN"]
    if len(train) < 10:
        raise TrainingError(f"TOO_FEW_TRAIN_ROWS: {len(train)}")
    out = {}
    for m in models or family(seed):
        m.fit(train, snapshot["paths"])
        art = {**m.artifact(), "training_version": TRAINING_VERSION, "trained_on": {"split": "TRAIN", "rows": len(train)}}
        out[m.name] = {"artifact": art, "artifact_hash": hashlib.sha256(json.dumps(art, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
    return {"models": out, "train_rows": len(train), "validation_rows_untouched": sum(r["split"] == "VALIDATION" for r in snapshot["rows"]),
            "oos_rows_untouched": sum(r["split"] == "OOS" for r in snapshot["rows"])}
