# Deployment

The project has a single deployment target: a self-managed DigitalOcean Droplet running the stack
via Docker Compose (see the README's **Deploying to DigitalOcean** section for the concrete
step-by-step). That same droplet setup serves both:

- Production
- The shared development/test environment, used for:
  - Backend development
  - Frontend integration
  - Postman testing
  - LINE OA webhook testing
  - WebSocket testing
  - Integration testing
  - QA
  - Feature demonstrations

There is no separate hosted provider for dev/test — if the team wants dev/test physically
isolated from production, that means a second droplet running the same `docker-compose.yml`
setup with its own `.env`, own domain, own database, own secrets, not a different platform.

nginx and TLS (Let's Encrypt or otherwise) are set up directly on the droplet host, outside
Docker Compose — `api-prod` just listens on port 8080 for whatever reverse proxy is configured
in front of it.

## Deployment Architecture

```text
Developer
    |
    | git push
    v
GitHub Repository
    |
    v
GitHub Actions CI
    |
    | CI checks pass
    v
SSH deploy (manual, or your own CD step) to the DigitalOcean Droplet
    |
    v
Host nginx (reverse proxy + TLS, configured outside this repo)
    |
    v
Docker Compose ("production" profile)
    |
    |-- api-prod (Backend Web Service)
    |-- PostgreSQL (Dockerized "local-db" profile, or an external managed instance)
    `-- Redis
```
