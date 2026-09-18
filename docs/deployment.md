# Deployment

Packrat can run as one Docker container or as a local Bun process. Docker includes the matching Chromium binaries and runtime libraries.

## Docker

Set an authentication password before starting the service:

```bash
export PACKRAT_AUTH_PASSWORD='replace-with-a-secret'
make up
```

The equivalent commands are:

```bash
docker compose build
mkdir -p data config
docker compose up -d
```

Open <http://localhost:3047/>. The default username is `packrat`.

The first build downloads Chromium and produces an image of about 500 MB. Container startup does not download a browser.

### Volumes

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/data` | SQLite database and required persistent data. |
| `./config` | `/config` | Optional read-only `.env` file. |

Create `config/.env` to override container settings:

```dotenv
PACKRAT_BASE_URL=http://packrat.local
PACKRAT_HTML_COMPRESSION=auto
PACKRAT_MAX_CONCURRENT_CAPTURES=3
PACKRAT_MAX_PDF_BYTES=104857600
PACKRAT_AUTH_USER=packrat
PACKRAT_AUTH_PASSWORD=replace-with-a-secret
```

The entry point reads `/config/.env`. To run with host-matching file ownership, uncomment `PUID` and `PGID` in `docker-compose.yml`; these values must be container environment variables rather than entries in `/config/.env`. The Compose definition allocates 256 MB of shared memory for Chromium. Packrat starts Bun with `--no-orphans` so a watchdog or service exit also terminates descendant Chromium processes.

### Make targets

| Target | Action |
|---|---|
| `make build` | Build the image. |
| `make build-clean` | Rebuild without the Docker cache. |
| `make run` | Start the service. |
| `make up` | Build and start. |
| `make stop` | Stop and remove the container. |
| `make logs` | Follow service logs. |
| `make shell` | Open a shell in the container. |
| `make test` | Run tests on the host. |
| `make clean` | Remove containers, volumes and the local image. |

## Published images

Pushing a semantic version tag such as `v0.3.1` runs type checking and the full test suite before publishing a multi-platform image to `ghcr.io/rcarmo/bun-packrat`. Chromium installation in the test job has a five-minute bound and one retry. The workflow produces full, major/minor, major and `latest` tags for `linux/amd64` and `linux/arm64`, uses the GitHub Actions build cache, and attaches build provenance.

The release workflow keeps the five newest semantic-version package releases and their multi-platform manifest safety window. It removes older package versions outside that window and keeps the five newest workflow runs. Publication runs only for `v*` tag pushes; ordinary branches and manual dispatches cannot publish or prune images.

```bash
docker pull ghcr.io/rcarmo/bun-packrat:latest
```

Production should use an immutable multi-platform manifest digest. The operator-recorded v0.3.1 deployment uses:

```text
ghcr.io/rcarmo/bun-packrat@sha256:c95504fcaddb8baae132204ab4bf7496b875f7723da1dab729d74377e06e4bb7
```

The image carries OCI revision `3d4ae95ae8ad043ecbc4a075f99adc0adfaf40d8`. The previous v0.3.0 production digest, retained for application rollback, is `sha256:6f0b54ce836a8d877043abee15e71d118b1b461de5f87f237c37764344058731`.

## Local Bun process

Install dependencies and ensure Playwright can find Chromium:

```bash
bun install
PLAYWRIGHT_BROWSERS_PATH=/workspace/bin/pw-browsers \
PACKRAT_AUTH_DISABLED=1 \
bun run start
```

The default database path is `./data/packrat.db`. Migrations run when the database opens.

For an authenticated local service:

```bash
PACKRAT_AUTH_USER=packrat \
PACKRAT_AUTH_PASSWORD='replace-with-a-secret' \
bun run start
```

## Health check

```bash
curl -u 'packrat:replace-with-a-secret' \
  http://localhost:3047/api/status
```

An explicitly unauthenticated deployment does not require credentials:

```bash
PACKRAT_AUTH_DISABLED=1 bun run start
curl http://localhost:3047/api/status
```

Use unauthenticated mode only on a trusted network. `/api/status` is the health and automation endpoint; `/status` is the authenticated human-readable queue monitor.
