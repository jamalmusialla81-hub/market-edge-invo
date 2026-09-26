"""Checks HummingbotApiClient against a LIVE hummingbot-api instead of
trusting hand-written field names.

1. Drives every client method through a recording transport, so what is
   checked is exactly what the client would send.
2. Validates each recorded request against the live /openapi.json: the path
   and method must exist, every body field must be a declared property,
   every required property must be present, and enum values must be legal.
3. Calls the live read-only endpoints the schema itself lists for accounts,
   connectors, portfolio and trading (authenticated), and records the status
   code for each, so reachability is observed, not assumed.

Writes a JSON report and exits 1 if anything fails. No orders are placed.
"""
from __future__ import annotations

import json
import os
import re
import sys

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "bridge"))
from hummingbot_api_client import HummingbotApiClient  # noqa: E402

READ_PROBE_TAGS = ("account", "connector", "portfolio", "trading")


def resolve(schema: dict, spec: dict) -> dict:
    seen = 0
    while isinstance(schema, dict) and "$ref" in schema and seen < 20:
        name = schema["$ref"].rsplit("/", 1)[-1]
        schema = spec.get("components", {}).get("schemas", {}).get(name, {})
        seen += 1
    if isinstance(schema, dict):
        for key in ("allOf", "anyOf", "oneOf"):
            if key in schema:
                options = [resolve(s, spec) for s in schema[key]]
                non_null = [o for o in options if o.get("type") != "null"]
                if key == "allOf":
                    merged = {"type": "object", "properties": {}, "required": []}
                    for o in options:
                        merged["properties"].update(o.get("properties", {}))
                        merged["required"] += o.get("required", [])
                    return merged
                if len(non_null) == 1:
                    return non_null[0]
    return schema or {}


def match_path(path: str, spec: dict) -> str | None:
    for template in spec.get("paths", {}):
        pattern = "^" + re.sub(r"\{[^/]+\}", "[^/]+", template.rstrip("/")) + "/?$"
        if re.match(pattern, path.rstrip("/") or "/"):
            return template
    return None


def check_body(body, schema: dict, spec: dict, where: str) -> list[str]:
    problems = []
    schema = resolve(schema, spec)
    if not isinstance(body, dict) or schema.get("type") not in (None, "object"):
        return problems
    props = schema.get("properties", {})
    if props and schema.get("additionalProperties") is not True:
        for key in body:
            if key not in props:
                problems.append(f"{where}: field '{key}' is not in the live schema (allowed: {sorted(props)})")
    for key in schema.get("required", []):
        if key not in body:
            problems.append(f"{where}: required field '{key}' is missing")
    for key, value in body.items():
        prop = resolve(props.get(key, {}), spec)
        if "enum" in prop and value is not None and value not in prop["enum"]:
            problems.append(f"{where}: '{key}'={value!r} not in enum {prop['enum']}")
    return problems


def record_client_requests() -> list[httpx.Request]:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={})

    client = HummingbotApiClient("http://recorder", username="u", password="p", transport=httpx.MockTransport(handler))
    base = {"client_order_id": "probe-1", "instrument": "BTC-PERP", "side": "BUY", "quantity": 0.001, "order_type": "MARKET"}
    client.place_order(base)
    client.place_order({**base, "client_order_id": "probe-2", "side": "SELL", "order_type": "LIMIT", "price": 100000.0})
    client.place_order({**base, "client_order_id": "probe-3", "side": "SELL", "reduce_only": True})
    client.cancel_order("probe-1")
    client.positions()
    for name in ("balances", "active_orders"):
        if hasattr(client, name):
            getattr(client, name)()
    return captured


def verify_requests(spec: dict) -> list[dict]:
    results = []
    for request in record_client_requests():
        path, method = request.url.path, request.method.lower()
        body = json.loads(request.content) if request.content else None
        entry = {"method": method.upper(), "path": path, "body": body, "problems": []}
        template = match_path(path, spec)
        if template is None:
            entry["problems"].append("path not found in live schema")
        elif method not in spec["paths"][template]:
            entry["problems"].append(f"method {method.upper()} not allowed (live: {sorted(spec['paths'][template])})")
        else:
            entry["template"] = template
            operation = spec["paths"][template][method]
            content = operation.get("requestBody", {}).get("content", {}).get("application/json")
            if content:
                if operation["requestBody"].get("required") and body is None:
                    entry["problems"].append("request body is required but client sent none")
                entry["problems"] += check_body(body, content.get("schema", {}), spec, f"{method.upper()} {template}")
            elif body:
                entry["problems"].append("client sends a JSON body the live endpoint does not declare")
            ok = operation.get("responses", {}).get("200", {}).get("content", {}).get("application/json", {})
            entry["response_schema"] = resolve(ok.get("schema", {}), spec)
        entry["ok"] = not entry["problems"]
        results.append(entry)
    return results


def probe_reads(base_url: str, auth, spec: dict) -> list[dict]:
    probes = []
    with httpx.Client(base_url=base_url, auth=auth, timeout=15) as http:
        for template, ops in spec.get("paths", {}).items():
            op = ops.get("get")
            if not op or "{" in template or not any(t in template.lower() for t in READ_PROBE_TAGS):
                continue
            try:
                response = http.get(template)
                sample = response.text[:400]
                probes.append({"path": template, "status": response.status_code, "sample": sample})
            except httpx.HTTPError as error:
                probes.append({"path": template, "status": None, "error": str(error)})
    return probes


def account_lifecycle(base_url: str, auth) -> dict:
    """Create, inspect and delete a throwaway account on the live API. No
    credentials are added, so nothing here can reach an exchange."""
    name = "market_edge_ci_probe"
    steps = {}
    with httpx.Client(base_url=base_url, auth=auth, timeout=30) as http:
        def step(label, method, path, **kw):
            try:
                r = http.request(method, path, **kw)
                steps[label] = {"status": r.status_code, "body": r.text[:300]}
                return r
            except httpx.HTTPError as error:
                steps[label] = {"status": None, "error": str(error)}
                return None
        step("add_account", "POST", "/accounts/add-account", params={"account_name": name})
        listed = step("list_accounts", "GET", "/accounts/")
        steps["account_listed"] = bool(listed is not None and listed.status_code == 200 and name in listed.json())
        step("list_credentials", "GET", f"/accounts/{name}/credentials")
        step("portfolio_state", "POST", "/portfolio/state", json={"account_names": [name], "skip_gateway": True})
        step("positions", "POST", "/trading/positions", json={"account_names": [name]})
        step("active_orders", "POST", "/trading/orders/active", json={"account_names": [name]})
        connectors = step("connectors", "GET", "/connectors/")
        if connectors is not None and connectors.status_code == 200:
            steps["perpetual_connectors"] = sorted(c for c in connectors.json() if "perpetual" in c)
        step("delete_account", "POST", "/accounts/delete-account", params={"account_name": name})
    required = ("add_account", "list_credentials", "portfolio_state", "positions", "active_orders", "delete_account")
    steps["ok"] = steps.get("account_listed") is True and all(steps.get(k, {}).get("status") == 200 for k in required)
    return steps


def main() -> int:
    base_url = os.environ.get("HUMMINGBOT_API_URL", "http://localhost:8000")
    auth = (os.environ["HUMMINGBOT_API_USERNAME"], os.environ["HUMMINGBOT_API_PASSWORD"])
    report = {"base_url": base_url}
    try:
        report["root"] = httpx.get(f"{base_url}/", timeout=10).json()
        spec = httpx.get(f"{base_url}/openapi.json", timeout=10).json()
    except (httpx.HTTPError, ValueError) as error:
        report["verdict"] = "FAIL"
        report["error"] = f"live API unreachable: {error}"
        print(json.dumps(report, indent=2))
        return 1
    report["api_version"] = spec.get("info", {}).get("version")
    report["path_count"] = len(spec.get("paths", {}))
    report["paths"] = {p: sorted(ops) for p, ops in spec.get("paths", {}).items()}
    report["client_requests"] = verify_requests(spec)
    report["read_probes"] = probe_reads(base_url, auth, spec)
    report["account_lifecycle"] = account_lifecycle(base_url, auth)
    auth_ok = any(p.get("status") == 200 for p in report["read_probes"]) and report["account_lifecycle"]["ok"]
    requests_ok = all(r["ok"] for r in report["client_requests"])
    report["authenticated_reads_ok"] = auth_ok
    report["client_schema_ok"] = requests_ok
    report["verdict"] = "PASS" if (auth_ok and requests_ok) else "FAIL"
    print(json.dumps(report, indent=2, default=str))
    return 0 if report["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
