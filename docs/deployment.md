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
PACKRAT_HTML_COMPRESSION=gzip
PACKRAT_MAX_CONCURRENT_CAPTURES=3
PACKRAT_MAX_PDF_BYTES=104857600
PACKRAT_AUTH_USER=packrat
PACKRAT_AUTH_PASSWORD=replace-with-a-secret
```

The entry point reads `/config/.env`. To run with host-matching file ownership, uncomment `PUID` and `PGID` in `docker-compose.yml`; these values must be container environment variables rather than entries in `/config/.env`. The Compose definition allocates 256 MB of shared memory for Chromium.

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

Pushing a semantic version tag such as `v0.2.7` runs type checking and the full test suite before publishing a multi-platform image to `ghcr.io/rcarmo/bun-packrat`. Chromium installation in the test job has a five-minute bound and one retry. The workflow produces full, major/minor, major and `latest` tags for `linux/amd64` and `linux/arm64`, uses the GitHub Actions build cache, and attaches build provenance.

The release workflow keeps the five newest semantic-version package releases and their multi-platform manifest safety window. It removes older package versions outside that window and keeps the five newest workflow runs. Publication runs only for `v*` tag pushes; ordinary branches and manual dispatches cannot publish or prune images.

```bash
docker pull ghcr.io/rcarmo/bun-packrat:latest
```

## Local Bun process

Install dependencies and ensure Playwright can find Chromium:

```bash
bun install
PLAYWRIGHT_BROWSERS_PATH=/workspace/bin/pw-browsers \
PACKRAT_AUTH_DISABLED=1 \
bun run src/server.ts
```

The default database path is `./data/packrat.db`. Migrations run when the database opens.

For an authenticated local service:

```bash
PACKRAT_AUTH_USER=packrat \
PACKRAT_AUTH_PASSWORD='replace-with-a-secret' \
bun run src/server.ts
```

## Health check

```bash
curl -u 'packrat:replace-with-a-secret' \
  http://localhost:3047/api/status
```

An explicitly unauthenticated deployment does not require credentials:

```bash
PACKRAT_AUTH_DISABLED=1 bun run src/server.ts
curl http://localhost:3047/api/status
```

Use unauthenticated mode only on a trusted network. `/api/status` is the health and automation endpoint; `/status` is the authenticated human-readable queue monitor.
