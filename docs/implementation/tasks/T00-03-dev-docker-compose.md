# T00-03 — Docker Compose môi trường dev

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | WP-02 (một phần EN-03) |
| Loại | DevOps |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T00-01](T00-01-backend-scaffold.md) |
| Chặn | [T00-04](T00-04-db-baseline-migration.md), [T00-05](T00-05-spike-llm-latency.md), [T00-07](T00-07-staging-deploy-nginx.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Một lệnh `make up` dựng toàn bộ hạ tầng cục bộ — PostgreSQL 16 + pgvector, Valkey 8, SeaweedFS (S3), TEI embedding + rerank (CPU), Keycloak tạm, OTel Collector + Jaeger — cùng API, Worker, beat chạy từ image `cwd-app`, để lập trình viên và spike EN-01 có môi trường giống staging.

## 2. Bối cảnh

- SAD §13.2 cột "Dev": PostgreSQL container `pgvector/pgvector:pg16`, SeaweedFS container, Valkey `valkey/valkey:8`, TEI CPU cục bộ, LLM dùng key dev hoặc `FakeLLMAdapter`.
- SAD §4.3: cấu hình Valkey (`appendonly yes`, `maxmemory 1gb`, `noeviction`), bucket riêng, khoá object `documents/{document_id}.pdf`.
- IMPLEMENTATION_PLAN PA-04: Keycloak cục bộ thay IdP cho tới khi có OQ-016.
- File này cũng là nền của `staging.yml` (T00-07): giữ tên service, biến môi trường thống nhất.

## 3. Phạm vi

**Trong phạm vi:**
- `deploy/compose/dev.yml`, `deploy/compose/.env.dev.example`, script khởi tạo PostgreSQL, Valkey, SeaweedFS, realm Keycloak.
- Tải sẵn mô hình TEI vào volume (`make models`).
- Target Makefile: `up`, `up-core`, `down`, `reset`, `logs`, `ps`, `models`, `smoke`.
- Tài liệu ngắn `deploy/compose/README.md` (cổng, tài khoản thử, yêu cầu RAM).

**Ngoài phạm vi:**
- Schema và migration → [T00-04](T00-04-db-baseline-migration.md) (task này chỉ tạo database và role).
- Compose staging, Nginx, TLS → [T00-07](T00-07-staging-deploy-nginx.md).
- Cấu hình OIDC trong ứng dụng → [T01-01](T01-01-oidc-session.md) (task này chỉ dựng realm Keycloak).
- Pipeline OTel trong code → [T00-08](T00-08-logging-tracing-errors.md); Prometheus/Grafana/Loki/Tempo đầy đủ → [T06-04](T06-04-metrics-dashboards-alerts.md).

## 4. Thiết kế chi tiết

### 4.1 Service

| Service | Image (ghim phiên bản, không `latest`) | Cổng host | Profile | Healthcheck |
|---|---|---|---|---|
| `postgres` | `pgvector/pgvector:0.8.x-pg16` | 5432 | core | `pg_isready -U postgres` |
| `valkey` | `valkey/valkey:8.x` | 6379 | core | `valkey-cli ping` |
| `seaweedfs` | `chrislusf/seaweedfs:<ver>` lệnh `server -s3 -s3.config=/etc/seaweedfs/s3.json` | 8333 (S3) | core | `wget -qO- localhost:8333/status` (đề xuất) |
| `s3-init` | `amazon/aws-cli:<ver>` (one-shot) | — | core | Tạo bucket `cwd-dev`, bật versioning |
| `keycloak` | `quay.io/keycloak/keycloak:26.x` `start-dev --import-realm` | 8180 | core | `/health/ready` |
| `tei-embed` | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.x` `--model-id /data/bge-m3 --auto-truncate` | 8080 | models | `GET /health` |
| `tei-rerank` | cùng image `--model-id /data/bge-reranker-v2-m3` | 8081 | models | `GET /health` |
| `otel-collector` | `otel/opentelemetry-collector-contrib:<ver>` | 4317, 4318 | obs | — |
| `jaeger` | `jaegertracing/all-in-one:<ver>` (UI) | 16686 | obs | — |
| `api` | build `backend/` → `cwd-app:dev`; `uvicorn --factory ... --reload`; mount `backend/cwd` | 8000 | app | `/healthz` |
| `worker` | `cwd-app:dev`; `celery -A cwd.entrypoints.worker.celery_app worker -Q ingest,maintenance -c 2` | — | app | `celery inspect ping` |
| `beat` | `cwd-app:dev`; `celery ... beat` | — | app | — |

- `make up` = mọi profile (`--profile core --profile models --profile obs --profile app`); `make up-core` = chỉ `core` (máy yếu, dùng `FakeEmbedding` sau này).
- `tei-embed`, `tei-rerank` dùng token tĩnh `--api-key` từ `CWD_TEI_TOKEN` (IF-04 "Mạng nội bộ + token tĩnh").
- Giới hạn tài nguyên theo SAD §12.1 thu nhỏ cho dev (đề xuất): TEI mỗi service `mem_limit: 4g`; worker `2g`; Valkey `--maxmemory 1gb --maxmemory-policy noeviction --appendonly yes --appendfsync everysec`.
- `worker` chạy `read_only: true`, `tmpfs: /tmp`, `security_opt: [no-new-privileges:true]` để gần với SAD §11.1 ngay từ dev.

### 4.2 PostgreSQL khởi tạo

`deploy/compose/postgres/init/01-roles.sql` (chạy một lần khi volume rỗng):

```sql
CREATE ROLE cwd_owner LOGIN PASSWORD :'owner_pw';   -- sở hữu schema, Alembic dùng
CREATE ROLE cwd_app   LOGIN PASSWORD :'app_pw';     -- runtime API/Worker, quyền DML do T00-04 cấp
CREATE DATABASE cwd OWNER cwd_owner;
CREATE DATABASE cwd_test OWNER cwd_owner;           -- cho test cục bộ không dùng Testcontainers
```

Mật khẩu dev lấy từ `.env.dev` (giá trị mẫu trong `.env.dev.example`, không commit `.env.dev`). Tách 2 role để T05-05 cấp `INSERT/SELECT` duy nhất trên `ops.audit_log` cho `cwd_app` (INV-05).

### 4.3 SeaweedFS

`deploy/compose/seaweedfs/s3.json`: một identity `cwd-app` với quyền `Read, Write, List, Tagging` chỉ trên bucket `cwd-dev` (IF-06: "quyền chỉ trên bucket"). Khoá truy cập dev trong `.env.dev`.

### 4.4 Keycloak realm `cwd`

`deploy/compose/keycloak/realm-cwd.json`:
- Client `cwd-bff`: confidential, Standard flow, PKCE `S256`, redirect `http://localhost:8000/auth/callback` và `http://localhost:5173/*`, mapper "Group Membership" → claim `groups` (full path tắt).
- Group: `cwd-users`, `cwd-leads`, `cwd-managers` (SAD §4.2, tên chờ OQ-026).
- Người dùng thử (hư cấu, như prototype): `ha.nguyen` (cwd-users), `bao.tran` (cwd-users + cwd-leads), `chau.le` (cwd-users + cwd-managers), `no.role` (không nhóm — để test 403), mật khẩu dev chung trong `.env.dev`.
- Session idle 30 phút, max 8 giờ (khớp SAD §11.1).

### 4.5 Mô hình TEI

`make models`: chạy container `python:3.12-slim` + `huggingface_hub` tải `BAAI/bge-m3` và `BAAI/bge-reranker-v2-m3` vào volume `tei-models` (`/data`). TEI chạy với `HF_HUB_OFFLINE=1` để không tải từ Internet lúc chạy (SAD §13.2). Dung lượng ~5 GB (đề xuất ước tính).

### 4.6 Biến môi trường app (`.env.dev.example`)

```dotenv
CWD_ENV=dev
CWD_DATABASE_URL=postgresql://cwd_app:dev_app_pw@postgres:5432/cwd
CWD_MIGRATION_DATABASE_URL=postgresql://cwd_owner:dev_owner_pw@postgres:5432/cwd
CWD_VALKEY_URL=redis://valkey:6379/0
CWD_S3_ENDPOINT=http://seaweedfs:8333
CWD_S3_BUCKET=cwd-dev
CWD_S3_ACCESS_KEY=...            CWD_S3_SECRET_KEY=...
CWD_TEI_EMBED_URL=http://tei-embed:80   CWD_TEI_RERANK_URL=http://tei-rerank:80   CWD_TEI_TOKEN=dev-tei-token
CWD_OIDC_ISSUER=http://localhost:8180/realms/cwd   CWD_OIDC_CLIENT_ID=cwd-bff   CWD_OIDC_CLIENT_SECRET=...
CWD_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
CWD_LLM_PROVIDER=fake            # fake | claude ; key dev đặt trong secrets/anthropic_api_key
```

Claude API key dev đặt ở `deploy/compose/secrets/anthropic_api_key` (gitignored, mount vào `/run/secrets`, quyền 0400) — không qua biến môi trường (SAD §11.1).

### 4.7 Lệnh Makefile

| Target | Hành vi |
|---|---|
| `up` / `up-core` | `docker compose -f deploy/compose/dev.yml --env-file deploy/compose/.env.dev --profile ... up -d --wait` |
| `down` | Dừng, giữ volume |
| `reset` | `down -v` (xoá dữ liệu dev, hỏi xác nhận) |
| `models` | §4.5 |
| `smoke` | Gọi `/readyz` = 200; `POST tei-embed /embed {"inputs":["xin chào"]}` → vector 1024; gửi task `maintenance.ping` → `pong`; `aws s3 ls s3://cwd-dev` OK; lấy token Keycloak bằng password grant của client test (đề xuất) |

## 5. Các bước thực hiện

- [ ] Viết `dev.yml` với service §4.1, network `cwd-dev`, volume `pg-data`, `valkey-data`, `seaweed-data`, `tei-models`.
- [ ] Viết script init PostgreSQL, cấu hình SeaweedFS, job `s3-init`.
- [ ] Xuất realm Keycloak §4.4 thành JSON, kiểm tra import.
- [ ] Viết `make models`, chạy và ghi lại thời gian/dung lượng.
- [ ] Viết `.env.dev.example`, thư mục `secrets/` có `.gitkeep` và `README` hướng dẫn.
- [ ] Viết `make smoke`; chạy trên macOS (Apple Silicon) và Linux x86.
- [ ] Viết `deploy/compose/README.md`: bảng cổng, tài khoản thử, yêu cầu ≥ 16 GB RAM khi bật profile `models`.

## 6. Tiêu chí hoàn thành

- [ ] Trên máy sạch: `make models && make up && make smoke` thành công trong ≤ 15 phút (không tính tải mô hình) (WP-02: "`make up` chạy toàn bộ cục bộ").
- [ ] `docker compose ps` mọi service `healthy`; `GET localhost:8000/readyz` = 200.
- [ ] TEI `/embed` trả vector 1024 chiều; `/rerank` trả `[{index, score}]` (IF-04, IF-05).
- [ ] Đăng nhập được vào Keycloak bằng 4 tài khoản thử; token có claim `groups` đúng nhóm.
- [ ] Không có secret thật trong repo; `git grep -i "sk-ant"` rỗng.
- [ ] Không image nào dùng tag `latest` (SAD §13.2).

## 7. Kiểm thử

| Kịch bản | Kỳ vọng |
|---|---|
| `make smoke` | Toàn bộ bước §4.7 pass |
| Restart `valkey` khi có task trong hàng đợi `ingest` (task giả `sleep`) | Task vẫn còn sau restart (AOF, `acks_late`) |
| Tắt `tei-embed` | `/readyz` = 503, `checks.tei_embed = fail` |
| Client S3 dùng khoá `cwd-app` truy cập bucket khác | AccessDenied |
| `make reset && make up` | Role và database tạo lại đúng |

## 8. Analytics / observability

Profile `obs` cung cấp OTel Collector (nhận OTLP gRPC 4317) xuất trace sang Jaeger UI `localhost:16686` — đủ cho WP-06 "Trace của spike xem được trên Tempo/Jaeger cục bộ". Collector config `deploy/observability/otel-collector.dev.yaml`: receiver `otlp`, processor `batch`, exporter `otlp/jaeger`, và `debug` cho log/metric (đề xuất).

## 9. Tham chiếu

- SAD §4.3, §6.1, §10.4 (IF-04..IF-07), §11.1, §12.1, §13.2
- IMPLEMENTATION_PLAN §3, §4 S0 WP-02, §2.1 PA-03, PA-04, §7
- USER_STORIES §8 EN-03

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Rủi ro | Image TEI CPU chủ yếu cho `linux/amd64`; trên Apple Silicon có thể phải chạy giả lập (chậm) hoặc dùng image arm64 nếu có. Phương án: profile `models` chạy trên VM dev dùng chung, hoặc `FakeEmbeddingAdapter` cho test. Cần kiểm tra ngày đầu. |
| Đề xuất | Jaeger all-in-one cho dev thay vì Tempo để nhẹ; staging/prod dùng Tempo (SAD §11.3). |
| Đề xuất | Tách role `cwd_owner` / `cwd_app` ngay ở dev. |
| OQ-016, OQ-026 | IdP thật và tên nhóm; Keycloak tạm dùng tên đề xuất. |
| OQ-030 | Giấy phép TEI, SeaweedFS, Keycloak cần Pháp chế xác nhận (dùng nội bộ). |
