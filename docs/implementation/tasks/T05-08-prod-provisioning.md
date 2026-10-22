# T05-08 — Dựng môi trường prod

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | WP-54 (EN-03 phần prod) |
| Loại | DevOps |
| Ước lượng | 5 ngày công |
| Phụ thuộc | [T00-07](T00-07-staging-deploy-nginx.md) (Compose, Nginx, deploy một lệnh); điều kiện ngoài: IT cấp VM prod trước 04/01/2027 (PA-03, OQ-034), secret store (OQ-032), DNS + chứng chỉ CA nội bộ, bucket S3, egress proxy (OQ-029), client OIDC prod |
| Chặn | [T06-04](T06-04-metrics-dashboards-alerts.md), [T07-01](T07-01-load-test.md), [T07-02](T07-02-backup-restore-drill.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Dựng môi trường production pilot (VM-APP, VM-MODEL, VM-DATA, kết nối VM-OBS/giám sát IT) bằng Ansible lặp lại được; bật PgBouncer, LUKS, TLS nội bộ `verify-full`, secret store, sao lưu pgBackRest; deploy bản S4 lên prod theo quy trình rolling có duyệt thủ công và chạy smoke test — **chưa mở cho người dùng**.

## 2. Bối cảnh

- SAD §13.1 (sơ đồ: VLAN app / data, proxy egress allowlist), §13.2 (image `cwd-app:<git-sha>`, TEI image + volume mô hình tải sẵn, key Claude riêng cho prod), §12.1 (CPU/RAM từng container), §12.2 (300 GB SSD VM-DATA), §4.3 (cấu hình PostgreSQL, pgvector, Valkey `appendonly yes`, `maxmemory 1gb`, `noeviction`; Celery `acks_late`), §11.1 (TLS 1.3, HSTS, `sslmode=verify-full`, LUKS, secret store hoặc Docker secrets 0400, xoay vòng key), §11.2 (2 replica API `least_conn` + `/readyz`, 2 Worker, rolling, migration expand/contract, pgBackRest full tuần / differential đêm / WAL liên tục → RPO ≤ 15 phút), ADR-009 (Compose + Ansible, không Kubernetes).
- IMPLEMENTATION_PLAN §7: prod duyệt thủ công, rolling từng replica, tag `vYYYY.MM.DD-N`; từ S5 deploy prod mỗi cuối sprint để tập dượt.
- Dữ liệu thật chỉ được đưa vào sau OQ-005; giai đoạn này chỉ dùng PDF mẫu.

## 3. Phạm vi

**Trong phạm vi:** inventory + role Ansible; hardening OS; LUKS cho volume dữ liệu; PostgreSQL 16 + pgvector + PgBouncer + TLS; pgBackRest tới kho IT; Compose prod-app / prod-model; Nginx prod; secret; firewall/VLAN; exporter cho giám sát; job CI deploy prod có duyệt; smoke test; runbook deploy.

**Ngoài phạm vi:** dashboard + 7 cảnh báo ([T06-04](T06-04-metrics-dashboards-alerts.md)); diễn tập khôi phục ([T07-02](T07-02-backup-restore-drill.md)); test tải ([T07-01](T07-01-load-test.md)); GPU cho rerank (quyết định ở S7, RSK-009); HA PostgreSQL (SPOF được chấp nhận, SAD §11.2).

## 4. Thiết kế chi tiết

### 4.1 Cấu trúc `deploy/`

```text
deploy/
├── ansible/
│   ├── inventories/prod/{hosts.yml, group_vars/{all,app,model,data}.yml}
│   ├── roles/{common, luks, docker, postgres, pgbouncer, pgbackrest, valkey_host,
│   │          app_stack, model_stack, nginx_tls, secrets, exporters}
│   ├── site.yml            # dựng toàn bộ (idempotent)
│   ├── deploy.yml          # rolling deploy ứng dụng theo tag image
│   └── smoke.yml           # gọi deploy/smoke/prod_smoke.sh
├── compose/{prod-app.yml, prod-model.yml}
├── nginx/prod.conf
└── smoke/prod_smoke.sh
```

### 4.2 Node và container

| VM | Container / dịch vụ | Giới hạn (SAD §12.1) |
|---|---|---|
| VM-APP (8 vCPU, 16 GB) | `nginx` (443), `api-1`, `api-2` (`uvicorn --workers 2`), `worker-1`, `worker-2` (`celery -Q ingest,maintenance -c 2`), `beat`, `valkey`, `otel-collector` | 0,5/256M; 1,5/1,5G ×2; 1,5/2G ×2; —; 0,5/1G; 0,5/512M |
| VM-MODEL (8 vCPU, 16 GB) | `tei-embed` (:8080, `BAAI/bge-m3`), `tei-rerank` (:8081, `BAAI/bge-reranker-v2-m3`), volume mô hình `/opt/models` tải sẵn (không tải Internet lúc chạy), `--api-key` từ secret (IF-04 token tĩnh) | 4/5G mỗi container |
| VM-DATA (4 vCPU, 16 GB, SSD 300 GB) | PostgreSQL 16 + pgvector ≥ 0.8 (gói PGDG hoặc `pgvector/pgvector:pg16`), PgBouncer :6432 | 3/12G |

Mọi container: non-root, `read_only: true` (trừ volume dữ liệu), `security_opt: [no-new-privileges:true]`, `restart: unless-stopped`, healthcheck; image theo `git-sha` (không `latest`).

### 4.3 PostgreSQL / PgBouncer

- `postgresql.conf`: `shared_buffers=4GB`, `effective_cache_size=10GB`, `maintenance_work_mem=1GB`, `max_connections=100`, `ssl=on`, `ssl_min_protocol_version=TLSv1.2`, `password_encryption=scram-sha-256`, `archive_mode=on`, `archive_command='pgbackrest --stanza=cwd archive-push %p'`.
- `pg_hba.conf`: chỉ `hostssl` từ IP VM-APP (và VM-OBS cho exporter), `scram-sha-256`; cấm `host` không TLS.
- Role: `cwd_owner` (migration), `cwd_app` (runtime, quyền theo migration — gồm quyền chỉ thêm `ops.audit_log` của T05-05), `cwd_monitor` (`pg_monitor`).
- PgBouncer: `pool_mode=transaction`, `default_pool_size=40`, `max_client_conn=400`, `client_tls_sslmode=require`, `server_tls_sslmode=verify-full`, `auth_type=scram-sha-256`. Ứng dụng kết nối `postgresql://cwd_app@pgbouncer.data.internal:6432/cwd?sslmode=verify-full&sslrootcert=/run/secrets/internal_ca.pem`. Lưu ý: SQLAlchemy dùng `NullPool` hoặc `prepare_threshold=None` (psycopg 3) để tương thích transaction pooling.
- Migration (`alembic upgrade head`) chạy trực tiếp tới PostgreSQL (không qua PgBouncer) bằng `cwd_owner`, một lần trước rolling.

### 4.4 Sao lưu

pgBackRest repo tại kho backup IT (S3 hoặc NFS — theo IT), `repo1-cipher-type=aes-256-cbc`, `repo1-retention-full=4`; lịch: full Chủ nhật 01:00, differential 01:00 các ngày khác, WAL liên tục (`archive_timeout=300` → RPO ≤ 15 phút); `pgbackrest check` trong `site.yml`. Bucket object: bật versioning + sao chép đêm (IT cấu hình, task này xác minh).

### 4.5 Bảo mật hạ tầng

| Mục | Thiết kế |
|---|---|
| LUKS | Volume dữ liệu riêng: VM-DATA `/var/lib/postgresql`, VM-APP `/var/lib/docker/volumes` (Valkey AOF), VM-MODEL `/opt/models`; khoá mở bằng keyfile do IT giữ (escrow) hoặc Clevis/Tang nếu IT có (đề xuất) |
| TLS | Chứng chỉ CA nội bộ cho `cwd.<domain>` (Nginx), `pgbouncer.data.internal`, `postgres.data.internal`, TEI (đề xuất TLS cả TEI nếu IT yêu cầu); Nginx TLS 1.3 (tối thiểu 1.2), HSTS `max-age=31536000`, CSP như staging (gồm `worker-src 'self' blob:`) |
| Secret | Vault agent render file vào `/run/secrets/*` 0400 nếu OQ-032 có Vault; dự phòng Docker secrets 0400. Danh mục: `anthropic_api_key` (workspace prod riêng), `oidc_client_secret`, `db_password_cwd_app`, `s3_access_key/secret`, `tei_api_key`, `session_signing_key`, `pgbackrest_cipher_pass` |
| Mạng | nftables: VM-APP → VM-DATA 6432/5432 (5432 chỉ cho migration từ host deploy), → VM-MODEL 8080/8081, → S3 443, → IdP 443, → proxy egress 3128 (allowlist `api.anthropic.com` duy nhất); người dùng → VM-APP 443; SSH chỉ từ bastion IT |
| OS | `common`: người dùng deploy riêng, SSH key-only, tắt root login, chrony, cập nhật bảo mật tự động ngoài 08:00–20:00 |

### 4.6 Rolling deploy (`deploy.yml`)

1. Tham số `image_tag` (git-sha của tag `vYYYY.MM.DD-N`); kéo image trên VM-APP.
2. Chạy migration bằng container một lần (`cwd-app:<sha> alembic upgrade head`, kết nối `cwd_owner`).
3. Với `api-1` rồi `api-2`: `docker compose up -d --no-deps <svc>`; chờ `/readyz` 200 tối đa 60 s; lỗi → dừng, giữ replica còn lại (bản cũ).
4. Worker: gửi `SIGTERM` (Celery warm shutdown, `acks_late` đảm bảo job không mất), khởi động bản mới lần lượt; `beat` cuối cùng.
5. Nginx: chỉ reload khi cấu hình đổi (`nginx -t` trước).

CI: job `deploy-prod` (GitHub Actions `environment: production` hoặc GitLab `when: manual`) chỉ chạy trên tag, cần duyệt của Tech lead; gọi `ansible-playbook deploy.yml smoke.yml`.

### 4.7 Smoke test (`prod_smoke.sh`)

| # | Kiểm tra | Kỳ vọng |
|---|---|---|
| 1 | `GET /healthz`, `/readyz` qua 443 | 200 |
| 2 | TLS: `openssl s_client` | TLS 1.3, chuỗi CA nội bộ hợp lệ, HSTS |
| 3 | `GET /auth/login` | 302 tới IdP prod |
| 4 | Tài khoản smoke (nhóm `cwd-users` dành cho đội dev) tải `eval/samples/smoke.pdf` | 201 → `READY` ≤ 3 phút |
| 5 | Hỏi câu mẫu có đáp án | SSE `done answered`, ≥ 1 citation |
| 6 | `GET /documents/{id}/file` với `Range: bytes=0-1023` | 206 |
| 7 | `DELETE /documents/{id}` | 204; object bị purge ≤ 1 giờ (kiểm tra sau) |
| 8 | `psql "sslmode=disable"` từ VM-APP tới VM-DATA | Bị từ chối |
| 9 | `curl https://example.com` qua proxy từ VM-APP | Bị chặn (chỉ allowlist Anthropic) |
| 10 | `pgbackrest info` | Có bản full gần nhất, WAL archive OK |

"Chưa mở cho người dùng": IdP prod chỉ gán nhóm `cwd-users` cho đội dev/QA (đề xuất), hoặc Nginx `allow` dải IP đội dự án.

## 5. Các bước thực hiện

- [ ] Xác nhận với IT: VM (OS, IP, VLAN), DNS, chứng chỉ, bucket, proxy, kho backup, client OIDC prod, Vault (checklist gửi trước 04/01).
- [ ] Viết inventory + role `common`, `luks`, `docker`, `exporters`; chạy trên 3 VM.
- [ ] Role `postgres`, `pgbouncer`, `pgbackrest`; tạo stanza, bản full đầu tiên.
- [ ] Role `secrets`; nạp secret prod (không qua git, không qua log CI).
- [ ] `prod-model.yml`: chép volume mô hình (checksum), TEI healthy.
- [ ] `prod-app.yml`, `nginx/prod.conf`; role `app_stack`, `nginx_tls`.
- [ ] `deploy.yml` rolling + job CI có duyệt; deploy bản S4 (`v2027.01.xx-1`).
- [ ] `prod_smoke.sh`; chạy smoke; lưu kết quả.
- [ ] Chạy `site.yml` lần hai để xác nhận idempotent (0 changed ngoài dự kiến).
- [ ] Runbook `docs/runbooks/prod-deploy.md` (deploy, rollback về tag trước, xoay secret) — review với IT vận hành.

## 6. Tiêu chí hoàn thành

- [ ] **Exit S5 "prod chạy được smoke test":** 10/10 mục §4.7 đạt, biên bản đính kèm.
- [ ] **EN-03 (phần prod):** deploy prod bằng một lệnh qua job CI có duyệt; image tag `git-sha`; migration tự động trước rolling; rolling không làm gián đoạn SSE trên replica còn lại (kiểm tra bằng một stream dài trong lúc deploy).
- [ ] `site.yml` idempotent; dựng lại VM-APP từ đầu ≤ 1 giờ (SAD §11.2 SPOF) — đo một lần.
- [ ] Kết nối API → PostgreSQL bắt buộc `verify-full`; volume dữ liệu mã hoá LUKS (`cryptsetup status`); không secret nào trong image, git hay `docker inspect` env.
- [ ] pgBackRest có bản full + WAL archive liên tục; `archive_timeout` ≤ 300 s.
- [ ] Exporter (node, postgres, valkey) và OTel Collector gửi dữ liệu tới giám sát (để T06-04 dựng dashboard).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Lint | `ansible-lint`, `yamllint`, `docker compose config` trong CI |
| Molecule (đề xuất) | Role `postgres`, `pgbouncer` trên VM tạm/container |
| Smoke | §4.7 sau mỗi deploy prod |
| Rolling | Mở một SSE dài (FakeLLM không dùng ở prod → câu hỏi dài với Claude) qua `api-1`, deploy → stream không đứt nếu Nginx đang định tuyến tới replica còn sống; request mới đi `api-2` |
| Bảo mật | Quét cổng từ VLAN người dùng (chỉ 443 mở); `testssl.sh` trên Nginx; kiểm tra proxy allowlist |

## 8. Analytics / observability

- Prod dùng bảng `ops.analytics_events` riêng của prod; sự kiện của tài khoản smoke có `user_id` thuộc danh sách loại trừ khỏi thống kê (đề xuất: cờ `access.users.is_test` hoặc cấu hình `CWD_STATS_EXCLUDED_USERS`) để không làm méo WAU (US-019).
- Log/trace/metric prod gửi về VM-OBS hoặc stack IT; nhãn `env="prod"`.

## 9. Tham chiếu

SAD §4.3, §11.1, §11.2, §12.1–12.3, §13.1–13.2, ADR-009, ADR-010; IMPLEMENTATION_PLAN S5 WP-54, §5.1 (OQ-034, OQ-032), §5.2, §7; USER_STORIES EN-03, EN-05; PRD NFR-003, NFR-004.

## 10. Giả định và câu hỏi mở

- Giả định: IT cung cấp VM Linux (Ubuntu 24.04 LTS hoặc RHEL 9) có quyền sudo cho tài khoản deploy; object storage là dịch vụ S3 của IT (không tự host SeaweedFS ở prod).
- **OQ-T0508-01:** LUKS mở khoá khi khởi động như thế nào (nhập tay, keyfile của IT, Clevis/Tang)? Ảnh hưởng RTO và khởi động lại tự động.
- **OQ-T0508-02:** Vault có sẵn không (OQ-032)? Nếu không, ai giữ và xoay vòng secret (Claude key 90 ngày, DB 180 ngày)?
- **OQ-T0508-03:** VM-OBS riêng hay dùng stack giám sát IT? Ảnh hưởng role `exporters` và T06-04.
- **OQ-T0508-04:** Kho backup IT hỗ trợ giao thức nào cho pgBackRest (S3, SFTP, NFS)?
- **OQ-T0508-05:** Chặn truy cập người dùng trước Gate bằng nhóm IdP hay allowlist IP?
