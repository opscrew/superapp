# superapp

Sample application for Ops-Crew: a web page in front of [superapp2](../superapp2), its upstream API. Every call it serves calls superapp2, waits for the answer and shows it, with timing stats. A load control makes superapp call superapp2 at a steady rate, enough to make superapp2 slow (see its README).

- `GET /`: the page. Call superapp2 once, set the load in requests per second, and watch the timing stats (last minute: calls, average, p50, p95, slowest, errors) and a chart of the latest calls.
- `GET /api/call`: one call to superapp2, with how long it took.
- `GET /api/stats`: the stats the page shows.
- `POST /api/load?rps=N`: call superapp2 N times a second (0 stops).
- `GET /healthz`: liveness.
- `GET /hog?mb=1024`: allocate and retain N MB in 64MB chunks, so the pod gets OOMKilled on demand.

How long each call to superapp2 took is the OpenTelemetry histogram `superapp.upstream.duration` (seconds, by `upstream` and `outcome`), exported for Prometheus on port 9464 at `/metrics`, where it reads `superapp_upstream_duration_bucket`. Failed calls are logged at most once every 10 seconds, with how many failed.

| Variable | Default | |
|---|---|---|
| `UPSTREAM_URL` | `http://superapp2.superapp2` | superapp2 |
| `UPSTREAM_TIMEOUT_MS` | `15000` | when a call to superapp2 gives up |
| `LOAD_RPS` | `0` | the load at start |
| `METRICS_PORT` | `9464` | |

Deployed by [superapp-infra](../superapp-infra), whose Kustomize manifests Argo CD syncs. The GitHub Actions workflow publishes `ghcr.io/<org>/superapp`.
