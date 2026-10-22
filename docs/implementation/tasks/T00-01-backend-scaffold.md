# T00-01 — Khởi tạo monorepo và khung backend hexagonal

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | WP-01 (nền cho EN-03) |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | — |
| Chặn | [T00-03](T00-03-dev-docker-compose.md), [T00-04](T00-04-db-baseline-migration.md), [T00-06](T00-06-ci-pipeline.md), [T00-08](T00-08-logging-tracing-errors.md), [T01-05](T01-05-pdf-extraction-chunking.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Có monorepo đúng cấu trúc IMPLEMENTATION_PLAN §3 và một backend Python 3.12 rỗng nhưng **chạy được** (FastAPI `/healthz`, `/readyz`, Celery app), với ranh giới hexagonal `domain → application → ports → adapters → entrypoints` được **ép bằng công cụ** (import-linter, mypy strict, ruff) ngay từ commit đầu.

## 2. Bối cảnh

- SAD §2.2, §4.2: modular monolith, một codebase cho C-02 (API) và C-03 (Worker); ranh giới module bằng cấu trúc thư mục.
- SAD §6.1: "Hướng phụ thuộc trong code: `entrypoints → application → domain`; `adapters → ports`; `domain` không phụ thuộc framework. Kiểm tra trong CI bằng `import-linter`."
- SAD §13.2: image `cwd-app:<git-sha>` (Python 3.12 slim, non-root), Worker và beat dùng cùng image, khác lệnh.
- Mọi task BE sau đều thêm code vào khung này, nên quy ước đặt ở đây phải ổn định.

## 3. Phạm vi

**Trong phạm vi:**
- Cây thư mục monorepo (`backend/`, `frontend/` (rỗng, T00-02 điền), `eval/`, `deploy/`, `e2e/`, `perf/`), `Makefile` gốc, `.editorconfig`, `.gitignore`.
- `backend/pyproject.toml` + `uv.lock`; package `cwd` với các tầng; cấu hình ruff, mypy, import-linter, pytest, coverage.
- `cwd/config.py` (pydantic-settings), factory FastAPI `create_app()`, `/healthz`, `/readyz` (khung kiểm tra phụ thuộc), Celery app rỗng với 2 hàng đợi.
- Value object tối thiểu trong `domain` để có test thật (`DocumentStatus`, `Role`).
- `backend/Dockerfile` (multi-stage, non-root).

**Ngoài phạm vi:**
- Docker Compose dev → [T00-03](T00-03-dev-docker-compose.md).
- Alembic/migration → [T00-04](T00-04-db-baseline-migration.md).
- Pipeline CI → [T00-06](T00-06-ci-pipeline.md) (task này chỉ đảm bảo các lệnh chạy được cục bộ).
- Log JSON, OTel, lỗi RFC 9457, middleware request ID → [T00-08](T00-08-logging-tracing-errors.md).
- Khung frontend → [T00-02](T00-02-frontend-scaffold.md).

## 4. Thiết kế chi tiết

### 4.1 Cây thư mục

```text
sdlc-ai/
├── Makefile                      # lệnh chung (§4.6)
├── .editorconfig  .gitignore  .python-version (3.12)
├── backend/
│   ├── pyproject.toml  uv.lock  Dockerfile  .importlinter (hoặc trong pyproject)
│   ├── cwd/
│   │   ├── __init__.py            # __version__ đọc từ env CWD_APP_VERSION (git sha)
│   │   ├── config.py              # Settings
│   │   ├── domain/{documents,conversations,access}/__init__.py
│   │   ├── application/{ingestion,qa,history,reporting}/__init__.py
│   │   ├── ports/__init__.py      # Protocol cho LLMPort, EmbeddingPort... (thêm dần)
│   │   ├── adapters/__init__.py   # persistence/postgres, tei, claude, s3, oidc, celery (thêm dần)
│   │   └── entrypoints/
│   │       ├── api/{__init__,main,health}.py
│   │       └── worker/{__init__,celery_app}.py
│   ├── migrations/                # để trống, T00-04 khởi tạo Alembic
│   ├── prompts/                   # để trống (.gitkeep), T02-04
│   └── tests/{unit,integration}/  conftest.py
├── frontend/  eval/  deploy/{compose,nginx,ansible,observability}/  e2e/  perf/   (.gitkeep)
└── docs/
```

### 4.2 `pyproject.toml` (rút gọn)

| Mục | Giá trị |
|---|---|
| `requires-python` | `>=3.12,<3.13` |
| Runtime deps | `fastapi`, `uvicorn[standard]`, `pydantic>=2`, `pydantic-settings`, `celery>=5,<6`, `valkey` (client), `httpx` |
| Dev deps (`[dependency-groups] dev`) | `ruff`, `mypy`, `import-linter`, `pytest`, `pytest-asyncio`, `pytest-cov`, `testcontainers[postgres]` |
| Khoá phiên bản | `uv lock`; CI dùng `uv sync --frozen` (SAD §6.2) |

Thư viện của task sau (SQLAlchemy, Alembic, psycopg, pgvector, Authlib, anthropic, pypdfium2, structlog, OTel, pybreaker) **do task đó thêm**, tránh khoá phiên bản sớm.

### 4.3 Cấu hình chất lượng

- **ruff:** `line-length = 100`, `target-version = "py312"`, rule `E,F,I,B,UP,S,ASYNC,PL,RUF` (đề xuất); `S101` bỏ qua trong `tests/`.
- **mypy:** mặc định `strict = false`; override `[[tool.mypy.overrides]] module = ["cwd.domain.*", "cwd.application.*", "cwd.ports.*"] strict = true` (IMPLEMENTATION_PLAN §3).
- **pytest:** `testpaths = ["tests"]`, marker `unit`, `integration` (integration cần Docker), `asyncio_mode = "auto"`.
- **coverage:** `source = ["cwd/domain", "cwd/application"]`, `fail_under = 70` (LG-05). Áp dụng trong CI (T00-06).

### 4.4 Hợp đồng import-linter

| Tên contract | Loại | Nội dung |
|---|---|---|
| `domain-thuần` | forbidden | `cwd.domain` không import `cwd.application`, `cwd.ports`, `cwd.adapters`, `cwd.entrypoints`, và thư viện ngoài `fastapi`, `starlette`, `sqlalchemy`, `celery`, `anthropic`, `httpx`, `pydantic_settings`, `valkey` (`include_external_packages = true`) |
| `application-không-biết-hạ-tầng` | forbidden | `cwd.application` không import `cwd.adapters`, `cwd.entrypoints`, `fastapi`, `sqlalchemy`, `celery`, `anthropic`, `httpx` |
| `ports-chỉ-phụ-thuộc-domain` | forbidden | `cwd.ports` không import `cwd.application`, `cwd.adapters`, `cwd.entrypoints` |
| `adapters-không-gọi-entrypoint` | forbidden | `cwd.adapters` không import `cwd.entrypoints`, `cwd.application` |
| `domain-module-độc-lập` (đề xuất) | independence | `cwd.domain.documents`, `cwd.domain.conversations`, `cwd.domain.access` (SAD §7.1: truy vấn chéo module chỉ qua application) |

`cwd.entrypoints` là composition root: được import mọi tầng để nối adapter vào use case.

### 4.5 Cấu hình (`cwd/config.py`)

`class Settings(BaseSettings)` với `model_config = SettingsConfigDict(env_prefix="CWD_", secrets_dir="/run/secrets")` — secret đọc từ Docker secrets (SAD §11.1). Các trường khởi tạo trong task này:

| Biến môi trường | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|
| `CWD_ENV` | `Literal["dev","test","staging","prod"]` | `dev` | |
| `CWD_APP_VERSION` | `str` | `"dev"` | Git sha, CI truyền vào image |
| `CWD_DATABASE_URL` | `PostgresDsn` | — | Role ứng dụng `cwd_app` |
| `CWD_VALKEY_URL` | `str` | `redis://localhost:6379/0` | Phiên, rate limit, broker |
| `CWD_TEI_EMBED_URL`, `CWD_TEI_RERANK_URL` | `HttpUrl` | `http://localhost:8080`, `:8081` | IF-04, IF-05 |
| `CWD_READYZ_CHECK_MODEL_SERVER` | `bool` | `true` | Tắt khi chạy test |

Task sau thêm trường của mình (OIDC, S3, Claude…) vào cùng class, có giá trị mặc định an toàn hoặc bắt buộc. `get_settings()` có `@lru_cache`.

### 4.6 Entrypoint

```python
# cwd/entrypoints/api/main.py
def create_app(settings: Settings | None = None) -> FastAPI: ...
# chạy: uvicorn --factory cwd.entrypoints.api.main:create_app --host 0.0.0.0 --port 8000

# cwd/entrypoints/api/health.py
@router.get("/healthz")  -> 200 {"status": "ok", "version": "<sha>"}   # không chạm phụ thuộc
@router.get("/readyz")   -> 200 {"status":"ok","checks":{...}} | 503 {"status":"fail","checks":{...}}

class ReadinessCheck(Protocol):
    name: str
    async def __call__(self) -> bool: ...   # timeout 1 s mỗi check, chạy song song
```

`/readyz` (SAD §10.2: kiểm tra PG, Valkey, model server) nhận danh sách `ReadinessCheck` qua DI; task này viết `ValkeyPing`, `TeiHealth` (`GET {url}/health`) và `PostgresPing` (`SELECT 1` bằng `psycopg` async — thêm `psycopg[binary]` vào deps). Kết quả check chỉ chứa tên + `ok/fail`, không chứa chuỗi lỗi chi tiết.

```python
# cwd/entrypoints/worker/celery_app.py
app = Celery("cwd", broker=settings.valkey_url)
app.conf.update(task_acks_late=True, worker_prefetch_multiplier=1,
                broker_transport_options={"visibility_timeout": 1800},
                task_queues=(Queue("ingest"), Queue("maintenance")), task_default_queue="maintenance")
# chạy: celery -A cwd.entrypoints.worker.celery_app worker -Q ingest,maintenance -c 2
```

Giá trị Celery lấy từ SAD §4.3 (hàng đợi) và §4.2 (concurrency 2).

### 4.7 Domain tối thiểu

```python
# cwd/domain/documents/status.py
class DocumentStatus(StrEnum): QUEUED; PROCESSING; READY; FAILED; REMOVED
ALLOWED_TRANSITIONS: Mapping[DocumentStatus, frozenset[DocumentStatus]]   # SAD §9.1
def can_transition(src, dst) -> bool

# cwd/domain/access/roles.py
class Role(StrEnum): USER = "user"; LEAD = "lead"; MANAGER = "manager"
```

### 4.8 Dockerfile backend

Multi-stage: `python:3.12-slim` + `uv` (copy từ `ghcr.io/astral-sh/uv:<ver>`) → `uv sync --frozen --no-dev` vào `/app/.venv` → stage runtime `python:3.12-slim`, `useradd -u 10001 cwd`, `USER 10001`, `ENV PATH=/app/.venv/bin:$PATH`, `HEALTHCHECK` gọi `/healthz` cho API. Không `CMD` mặc định cho worker; compose truyền `command`. Không chứa secret (SAD §11.1).

### 4.9 Makefile gốc

| Target | Lệnh |
|---|---|
| `be-install` | `cd backend && uv sync` |
| `be-lint` | `ruff check . && ruff format --check . && lint-imports` |
| `be-type` | `mypy cwd` |
| `be-test` | `pytest -m "not integration"` |
| `be-test-int` | `pytest -m integration` |
| `be-run` | `uvicorn --factory cwd.entrypoints.api.main:create_app --reload` |
| `up` / `down` / `migrate` | Khai báo chỗ trống, T00-03/T00-04 điền |

## 5. Các bước thực hiện

- [ ] Tạo cây thư mục §4.1, `.gitignore` (Python, Node, `.env*` trừ `*.example`), `.editorconfig`.
- [ ] `uv init` trong `backend/`, khai báo deps §4.2, `uv lock`.
- [ ] Cấu hình ruff, mypy, pytest, coverage, import-linter (§4.3, §4.4).
- [ ] Viết `config.py`, `create_app()`, `health.py` với 3 `ReadinessCheck`.
- [ ] Viết `celery_app.py` và task mẫu `maintenance.ping` (trả `"pong"`, dùng cho smoke test T00-03).
- [ ] Viết `DocumentStatus`, `Role` + unit test.
- [ ] Viết `Dockerfile`, build thử `docker build -t cwd-app:dev backend/`.
- [ ] Viết Makefile; cập nhật `README.md` gốc mục "Bắt đầu nhanh" (3–5 dòng lệnh).
- [ ] Cố ý thêm `import fastapi` vào `cwd/domain` để xác nhận `lint-imports` báo lỗi, rồi xoá.

## 6. Tiêu chí hoàn thành

- [ ] `make be-lint be-type be-test` xanh trên máy sạch sau `make be-install` (WP-01: "CI xanh trên repo rỗng có cấu trúc").
- [ ] `lint-imports` báo **fail** khi `cwd.domain` import `fastapi` hoặc `cwd.application` import `cwd.adapters` (SAD §6.1).
- [ ] `GET /healthz` → 200 kèm `version`; `GET /readyz` → 503 khi Valkey/PG không chạy, 200 khi có (kiểm bằng test).
- [ ] Image `cwd-app:dev` build được, chạy user UID 10001, kích thước < 300 MB (đề xuất).
- [ ] Coverage `domain` + `application` ≥ 70% (LG-05) với test hiện có.

## 7. Kiểm thử

| Loại | Kịch bản | Kỳ vọng |
|---|---|---|
| Unit | `can_transition(QUEUED, PROCESSING)`; `(READY, QUEUED)` | `True`; `False` |
| Unit | `create_app()` với `TestClient`, `GET /healthz` | 200, `version == settings.app_version` |
| Unit | `/readyz` với 3 check giả: 1 trả `False` | 503, `checks.<tên> == "fail"` |
| Unit | Check giả treo 5 s | `/readyz` trả trong ≤ 1,5 s, check đó `fail` (timeout) |
| Integration | Testcontainers PostgreSQL + Valkey, check thật | 200 |
| Kiến trúc | `lint-imports` trên fixture vi phạm (chạy tay) | Fail đúng contract |

## 8. Analytics / observability

Không phát sự kiện EV. `/healthz`, `/readyz` là nền cho health check container (T00-03) và Nginx upstream (T00-07). Log/trace thêm ở [T00-08](T00-08-logging-tracing-errors.md); `/healthz`, `/readyz` phải bị loại khỏi access log mức INFO (ghi chú cho T00-08).

## 9. Tham chiếu

- IMPLEMENTATION_PLAN §3, §4 S0 WP-01
- SAD §2.2, §4.2, §4.3, §6.1, §6.2, §10.2 (`/healthz`, `/readyz`), §11.1 (secret), §13.2
- USER_STORIES §8 EN-03, §10 DoD

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Giả định | Repo đặt trên GitHub hoặc GitLab; cấu trúc không phụ thuộc nền tảng CI (chọn ở T00-06). |
| Giả định | `uv` là trình quản lý gói Python (IMPLEMENTATION_PLAN §3). |
| Đề xuất | Contract `independence` cho 3 module domain; cần Tech lead xác nhận vì `Citation` tham chiếu `document_id` (chỉ UUID, không import). |
| Đề xuất | ID UUID v7 (SAD §10.1) sinh ở ứng dụng bằng thư viện `uuid-utils` vì Python 3.12 chưa có `uuid.uuid7()`; thêm ở T00-04. |
| OQ-032 | Secret store của tổ chức — khung đọc `/run/secrets` tương thích cả Docker secrets lẫn Vault agent ghi file. |
