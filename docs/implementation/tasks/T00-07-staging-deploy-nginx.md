# T00-07 — Deploy staging một lệnh + Nginx (TLS, SSE, CSP)

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | EN-03, WP-05 |
| Loại | DevOps |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T00-03](T00-03-dev-docker-compose.md), [T00-06](T00-06-ci-pipeline.md) |
| Chặn | [T05-08](T05-08-prod-provisioning.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Staging chạy trên một VM bằng Docker Compose, được dựng và cập nhật bằng **một lệnh** (`make deploy-staging SHA=<git-sha>`, và tự động sau merge vào `main`): chạy migration, khởi động lại dịch vụ, kiểm tra `/readyz`. Nginx 1.26 kết thúc TLS, phục vụ SPA, proxy API với cấu hình SSE (`proxy_buffering off`), CSP và giới hạn kích thước upload đúng SAD.

## 2. Bối cảnh

- SAD §13.2 cột Staging: "VM staging đơn", API × 1, Worker × 1, TEI dùng chung VM-MODEL staging (hoặc chạy trên cùng VM tạm), bucket staging riêng, key Claude staging hạn mức thấp.
- SAD §10.3: location SSE `proxy_buffering off; proxy_read_timeout 120s; X-Accel-Buffering no`; `: ping` 15 s.
- SAD §11.1: TLS 1.3 (tối thiểu 1.2), HSTS, CSP `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:`, `client_max_body_size 51m`.
- SAD §4.1: asset có hash `Cache-Control: public, max-age=31536000, immutable`; `index.html` `no-cache`.
- PA-03: IT cấp VM staging trước 02/11; nếu trễ dùng VM tạm.

## 3. Phạm vi

**Trong phạm vi:**
- `deploy/nginx/`: `Dockerfile` (image `cwd-web:<git-sha>` = `nginx:1.26` + `frontend/dist` + cấu hình), `nginx.conf`, `conf.d/cwd.conf`, `snippets/security-headers.conf`.
- `deploy/compose/staging.yml` + `.env.staging.example`.
- `deploy/ansible/`: inventory `staging`, playbook `bootstrap.yml` (Docker, user deploy, firewall, thư mục secrets) và `deploy.yml` (kéo image, migrate, up, verify).
- Job `image-web` và `deploy-staging` trong pipeline của T00-06.
- Runbook ngắn `deploy/README.md` (deploy, rollback, xem log).

**Ngoài phạm vi:**
- Prod (3 VM, 2 replica, PgBouncer, LUKS, rolling) → [T05-08](T05-08-prod-provisioning.md).
- Prometheus/Grafana/cảnh báo → [T06-04](T06-04-metrics-dashboards-alerts.md); staging S0 chỉ có OTel Collector → Tempo/Jaeger.
- E2E và golden set sau deploy → task S1/S2, [T02-10](T02-10-golden-set-runner.md).
- Endpoint SSE thật → [T02-05](T02-05-ask-question-sse.md); ở đây kiểm bằng endpoint thử (§4.6).

## 4. Thiết kế chi tiết

### 4.1 Service staging (`staging.yml`)

| Service | Image | Ghi chú |
|---|---|---|
| `nginx` | `cwd-web:${SHA}` | Cổng 443 (và 80 → 301 HTTPS); upstream `api:8000` |
| `api` | `cwd-app:${SHA}` | `uvicorn --factory ... --workers 2 --proxy-headers --forwarded-allow-ips=<ip nginx>`; `restart: unless-stopped` |
| `worker` | `cwd-app:${SHA}` | `-Q ingest,maintenance -c 2`; non-root, `read_only`, `no-new-privileges`, `mem_limit 2g` (SAD §11.1, §12.1) |
| `beat` | `cwd-app:${SHA}` | |
| `migrate` | `cwd-app:${SHA}` | One-shot `alembic upgrade head` với `CWD_MIGRATION_DATABASE_URL`; `profiles: [migrate]` |
| `valkey` | `valkey/valkey:8.x` | Như dev (AOF, `maxmemory 1gb`, `noeviction`) |
| `postgres` | `pgvector/pgvector:0.8.x-pg16` | Trên cùng VM staging (SAD §13.2: "VM staging"); volume trên đĩa mã hoá nếu IT cấp |
| `tei-embed`, `tei-rerank` | TEI CPU | Nếu không có VM-MODEL staging riêng |
| `seaweedfs` | Chỉ khi IT chưa có bucket S3 staging | |
| `keycloak` | Chỉ khi chưa có IdP thật (PA-04) | |
| `otel-collector` | | Xuất tới Tempo/Jaeger staging |

Secret (Claude key staging, mật khẩu DB, S3 key, OIDC client secret, TEI token) là file trong `/opt/cwd/secrets/` quyền `0400`, mount `/run/secrets` (SAD §11.1, OQ-032).

### 4.2 Nginx — `conf.d/cwd.conf` (rút gọn)

```nginx
upstream cwd_api { server api:8000; keepalive 16; }
server { listen 80; server_name ${CWD_HOST}; return 301 https://$host$request_uri; }
server {
  listen 443 ssl; http2 on; server_name ${CWD_HOST};
  ssl_certificate /etc/nginx/tls/fullchain.pem; ssl_certificate_key /etc/nginx/tls/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3; ssl_prefer_server_ciphers off; ssl_session_cache shared:TLS:10m;
  include snippets/security-headers.conf;
  client_max_body_size 51m;                                   # SAD §11.1
  server_tokens off;

  location = /index.html { root /usr/share/nginx/html; add_header Cache-Control "no-cache"; include snippets/security-headers.conf; }
  location /assets/      { root /usr/share/nginx/html; add_header Cache-Control "public, max-age=31536000, immutable"; include snippets/security-headers.conf; }
  location ~ \.map$      { return 404; }                       # không lộ sourcemap (đề xuất)
  location /             { root /usr/share/nginx/html; try_files $uri /index.html; }

  location ~ ^/api/v1/conversations/[^/]+/messages$ {          # SSE — SAD §10.3
    proxy_pass http://cwd_api; proxy_http_version 1.1; proxy_set_header Connection "";
    proxy_buffering off; proxy_cache off; proxy_read_timeout 120s;
    add_header X-Accel-Buffering no;
    include snippets/proxy-headers.conf;
  }
  location /api/  { proxy_pass http://cwd_api; proxy_read_timeout 60s; include snippets/proxy-headers.conf; }
  location /auth/ { proxy_pass http://cwd_api; include snippets/proxy-headers.conf; }
  location = /healthz { proxy_pass http://cwd_api; access_log off; }
  location = /readyz  { allow 127.0.0.1; allow ${CWD_MONITOR_CIDR}; deny all; proxy_pass http://cwd_api; }
}
```

`proxy-headers.conf`: `X-Request-ID $request_id` (nếu client không gửi — SAD §10.1), `X-Forwarded-For`, `X-Forwarded-Proto https`, `Host`. Log Nginx định dạng JSON có `request_id`, **không** log query string của `/api/v1/documents?q=` (tên tài liệu có thể nhạy cảm — PR-06) (đề xuất: log `$uri` thay vì `$request_uri`).

### 4.3 Header bảo mật (`security-headers.conf`)

| Header | Giá trị |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000` (chưa `includeSubDomains` cho tới khi IT xác nhận domain) |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:; base-uri 'self'; form-action 'self'` (SAD §11.1 + 2 chỉ thị bổ sung đề xuất) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

Tất cả dùng `add_header ... always`. Vì `add_header` trong location ghi đè cấp server, mọi location có `add_header` phải `include` lại snippet (đã thể hiện ở §4.2).

### 4.4 Lệnh deploy

`make deploy-staging SHA=<sha>` → `ansible-playbook -i deploy/ansible/inventory/staging deploy/ansible/deploy.yml -e sha=<sha>`:

1. `docker login` registry; `docker compose pull` với `SHA`.
2. `docker compose --profile migrate run --rm migrate` (dừng nếu lỗi — không khởi động bản mới).
3. `docker compose up -d --remove-orphans --wait`.
4. Verify: `curl -fsS https://${CWD_HOST}/healthz` trả `version == SHA`; `/readyz` 200 (từ VM); kiểm tra SSE (§4.6).
5. Ghi `/opt/cwd/DEPLOYED_SHA` và `PREVIOUS_SHA`.

**Rollback:** `make rollback-staging` = deploy lại `PREVIOUS_SHA` (không downgrade migration; migration phải expand/contract — SAD §11.2).

**CI:** job `deploy-staging` chạy sau `image-app`, `image-web`, `trivy` xanh trên `push main`, `environment: staging`, dùng SSH key deploy (secret CI). Không chạy trên PR.

### 4.5 TLS

Chứng chỉ từ CA nội bộ của tổ chức (SAD §3.4). Tạm thời (nếu IT chưa cấp): chứng chỉ tự ký do Ansible sinh, chỉ cho staging, ghi rõ trong runbook. Không dùng Let's Encrypt (ứng dụng nội bộ).

### 4.6 Endpoint thử SSE

Thêm `GET /api/v1/_diag/sse?n=5&interval_ms=1000` (chỉ bật khi `CWD_ENV in {dev, staging}`, yêu cầu header `X-Diag-Token` từ secret) phát 5 sự kiện `delta` cách 1 s và `: ping` (đề xuất). Dùng để kiểm chứng Nginx không buffer trước khi T02-05 có endpoint thật; xoá hoặc giữ sau cờ khi lên prod.

## 5. Các bước thực hiện

- [ ] Gửi IT yêu cầu VM staging (8 vCPU, 16–32 GB RAM nếu chạy cả TEI), DNS `cwd-staging.<nội bộ>`, chứng chỉ, bucket S3, mở egress tới `api.anthropic.com` (OQ-029, OQ-034) — ngày 1.
- [ ] Viết `deploy/nginx/` + Dockerfile `cwd-web`; thêm job `image-web` vào CI (build từ artifact `frontend/dist`).
- [ ] Viết `staging.yml`, `.env.staging.example`.
- [ ] Viết Ansible `bootstrap.yml` (Docker Engine + compose plugin, user `deploy`, ufw chỉ mở 443/80/22 nội bộ, `/opt/cwd/{secrets,tls}`) và `deploy.yml` (§4.4).
- [ ] Viết endpoint thử SSE §4.6 (BE nhỏ, trong `cwd/entrypoints/api/diag.py`).
- [ ] Thêm job `deploy-staging` vào pipeline.
- [ ] Chạy bootstrap + deploy lần đầu; chạy kiểm thử §7; viết runbook.

## 6. Tiêu chí hoàn thành

- [ ] `make deploy-staging SHA=<sha>` từ máy có quyền đưa staging lên đúng phiên bản; merge vào `main` tự deploy (EN-03: "Deploy staging bằng một lệnh"; WP-05).
- [ ] Migration chạy tự động trong deploy; lỗi migration → bản cũ vẫn chạy (EN-03: "migration tự động").
- [ ] `https://cwd-staging…/` phục vụ SPA, TLS 1.2+/1.3, header §4.3 có mặt trên `/`, `/assets/*`, `/api/*`.
- [ ] SSE qua Nginx: sự kiện thử đến trình duyệt cách nhau ~1 s (không dồn cục), kết nối giữ ≥ 60 s nhờ `: ping`.
- [ ] Upload 50 MB qua Nginx không bị 413; 52 MB → 413.
- [ ] Không image tag `latest`; `/healthz` trả `version` = SHA đã deploy.

## 7. Kiểm thử

| Kịch bản | Lệnh / cách | Kỳ vọng |
|---|---|---|
| SSE không buffer | `curl -N -H "X-Diag-Token: …" https://…/api/v1/_diag/sse?n=5` | 5 dòng xuất hiện lần lượt mỗi ~1 s |
| Header | `curl -sI https://…/` và `/assets/<file>.js` | CSP, HSTS, nosniff; asset có `immutable`, `index.html` `no-cache` |
| Giới hạn body | `curl -F file=@52mb.bin https://…/api/v1/_diag/echo-size` (đề xuất) hoặc bất kỳ POST | 413 từ Nginx |
| TLS | `testssl.sh` hoặc `openssl s_client -tls1_1` | TLS 1.1 bị từ chối |
| Sourcemap | `curl -o /dev/null -w "%{http_code}" https://…/assets/x.js.map` | 404 |
| Rollback | Deploy SHA B rồi `make rollback-staging` | `/healthz.version` = SHA A |
| Migration lỗi | Deploy image có migration hỏng (nhánh thử) | Deploy dừng ở bước 2, bản cũ vẫn phục vụ |
| CSP với SPA | Mở staging, DevTools Console | Không có vi phạm CSP (xem §10 về Radix) |

## 8. Analytics / observability

- Access log Nginx JSON: `ts`, `request_id`, `status`, `uri` (không query), `request_time`, `upstream_response_time`, `bytes_sent` — không có cookie, header xác thực, body (PR-06).
- `X-Request-ID` sinh tại Nginx và chuyển cho API để log/trace nối được (SAD §10.1, T00-08).
- Ghi lại SHA và thời điểm mỗi lần deploy (file + log Ansible) phục vụ đối chiếu sự cố.

## 9. Tham chiếu

- SAD §3.4, §4.1 (cache asset), §10.1, §10.3 (SSE Nginx), §11.1 (TLS, CSP, upload, secret), §11.2 (expand/contract, rolling), §12.1, §13.2, ADR-009
- USER_STORIES §8 EN-03
- IMPLEMENTATION_PLAN §4 S0 WP-05, §5.1 (OQ-034, OQ-032), §7

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Thiếu phụ thuộc | Deploy chạy migration nên cần [T00-04](T00-04-db-baseline-migration.md); README chỉ ghi T00-03, T00-06. Image `cwd-web` cần build FE (T00-02, qua T00-06). |
| Rủi ro CSP | `style-src` không khai báo nên rơi về `default-src 'self'`: thẻ `<style>` do thư viện chèn lúc chạy (ví dụ `react-remove-scroll` dùng trong Radix Dialog) sẽ bị chặn. Cần kiểm tra với T00-10; phương án: thêm `style-src 'self' 'unsafe-inline'` (rủi ro thấp vì `script-src` vẫn chặt) hoặc nonce — cần Bảo mật thông tin duyệt vì lệch SAD §11.1. |
| Đề xuất | `add_header X-Accel-Buffering no` ở Nginx không có tác dụng điều khiển buffer (đó là header Nginx đọc từ upstream); việc tắt buffer do `proxy_buffering off`. Giữ header theo SAD, đồng thời API nên tự gửi `X-Accel-Buffering: no` trong phản hồi SSE (ghi chú cho T02-05). |
| Đề xuất | Endpoint chẩn đoán `/_diag/*` chỉ ở dev/staging. |
| OQ-034 | VM staging và tài nguyên (có chạy TEI trên cùng VM không). |
| OQ-029 | Egress tới Claude API từ staging qua proxy. |
| OQ-032 | Secret store; tạm Docker secrets file 0400. |
| OQ-016 | IdP thật cho staging; tạm Keycloak trong compose. |
