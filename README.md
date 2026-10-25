# superapp

Sample application for Ops-Crew. A tiny HTTP service with an endpoint that hoards memory so the pod gets OOMKilled on demand.

- `GET /` — identity and current RSS
- `GET /healthz` — liveness
- `GET /hog?mb=1024` — allocate and retain N MB in 64MB chunks

Deployed by [superapp-infra](../superapp-infra) with Pulumi. The GitHub Actions workflow publishes `ghcr.io/<org>/superapp`.
