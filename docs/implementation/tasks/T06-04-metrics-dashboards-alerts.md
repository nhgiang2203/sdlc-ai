# T06-04 — Metric, dashboard, cảnh báo

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | EN-04 (phần 2) · WP-62 |
| Loại | DevOps, BE |
| Ước lượng | 3 ngày công (BE 1,5 instrument metric; DevOps 1,5 dashboard + cảnh báo) |
| Phụ thuộc | [T00-08](T00-08-logging-tracing-errors.md) (structlog, OTel, request_id), [T05-08](T05-08-prod-provisioning.md) (prod, VM-OBS hoặc stack giám sát IT) |
| Chặn | Theo README: không có. Thực tế là đầu vào của [T07-01](T07-01-load-test.md) (đo tài nguyên), [T07-02](T07-02-backup-restore-drill.md) (cảnh báo backup) và [T07-06](T07-06-gate-review.md) (LG-09) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hoàn thiện EN-04: xuất đủ metric Prometheus theo SAD §11.3, dựng dashboard Grafana (độ trễ, lỗi, token, chi phí, hàng đợi, hạ tầng, sản phẩm), cấu hình 7 cảnh báo và bắn thử thành công từng cái, thiết lập ngưỡng chi phí tháng (LG-09, RSK-006), kiểm tra mẫu log không chứa nội dung câu hỏi/câu trả lời/tài liệu (PR-06).

## 2. Bối cảnh

- EN-04 tách đôi (IMPLEMENTATION_PLAN §2.3): S0 đã có log/trace cơ bản (T00-08); S6 làm dashboard + cảnh báo đầy đủ, cần trước Gate.
- Tiêu chí EN-04: "Dashboard độ trễ, lỗi, token, chi phí, hàng đợi; 7 cảnh báo bắn thử thành công; log không chứa nội dung câu hỏi (kiểm tra mẫu)".
- LG-09: "Giám sát mức sẵn sàng và lỗi; cảnh báo khi dịch vụ AI lỗi; ngưỡng chi phí theo tháng được thiết lập; quy trình xử lý sự cố đã có".
- NFR-004: sẵn sàng ≥ 99% trong 08:00–20:00 ngày làm việc.

## 3. Phạm vi

**Trong phạm vi:** module metric backend; collector `cwd_queue_depth`; exporter hạ tầng (node, postgres, valkey, blackbox, pgBackRest); dashboard JSON trong repo; 7 rule cảnh báo + 2 rule bổ sung (đề xuất); contact point; ngưỡng chi phí tháng; script kiểm tra log; mục runbook cho từng cảnh báo (1 đoạn/cảnh báo).

**Ngoài phạm vi:** tracing span (đã có T00-08); runbook vận hành tổng thể + DR → [T07-02](T07-02-backup-restore-drill.md); **tự động giảm hạn mức câu hỏi khi chạm 100% ngân sách** (SAD §11.2 "Bảo vệ chi phí") — chưa có task, xem OQ-166; dashboard sản phẩm cho PO trong ứng dụng → [T06-02](T06-02-fe-stats-page.md).

## 4. Thiết kế chi tiết

### 4.1 Metric (backend)

File `backend/cwd/adapters/observability/metrics.py` (prometheus-client, multiprocess mode cho Uvicorn worker — `PROMETHEUS_MULTIPROC_DIR`); application gọi qua port `backend/cwd/ports/metrics.py` (`MetricsPort`) để `domain`/`application` không import thư viện.

| Metric | Loại | Nhãn | Ghi ở |
|---|---|---|---|
| `http_server_request_duration_seconds` | histogram | `route`, `method`, `status` | middleware (RED) |
| `cwd_llm_first_token_seconds` | histogram (bucket 0.5,1,1.5,2,2.5,3,4,5,8,13,30) | `model`, `effort`, `turn` (`first`/`follow_up`) | `ClaudeLLMAdapter` |
| `cwd_answer_total_seconds` | histogram (1..60 s) | `answer_type` | `AskQuestion` |
| `cwd_answer_type_total` | counter | `type` = answered/partial/not_found | `AskQuestion` |
| `cwd_answer_status_total` (đề xuất) | counter | `status` = completed/failed/stopped, `error_type` | `AskQuestion` — mẫu số cảnh báo tỷ lệ lỗi |
| `cwd_llm_tokens_total` | counter | `kind` = input/output/cache_read/cache_write, `purpose` = answer/rewrite | adapter, từ `usage` |
| `cwd_llm_cost_usd_total` | counter | `purpose` | adapter: `usage × bảng giá` trong `config/llm_pricing.yaml` |
| `cwd_retrieval_seconds` | histogram | `stage` = embed/vector/fts/rerank | retrieval |
| `cwd_retrieval_degraded_total` | counter | — | retrieval (EN-06) |
| `cwd_ingest_seconds` | histogram | `pages_bucket` = ≤50/≤200/≤500 | worker |
| `cwd_ingest_total` (đề xuất) / `cwd_ingest_failures_total` | counter | `reason` | worker |
| `cwd_queue_depth` | gauge | `queue` = ingest/maintenance | custom collector `LLEN` Valkey khi scrape |
| `cwd_circuit_state` | gauge (0 closed, 1 half_open, 2 open) | `target` = claude/tei | pybreaker listener (T05-07) |
| `cwd_llm_inflight` (đề xuất) | gauge | — | semaphore 15 lời gọi |
| `cwd_llm_monthly_budget_usd` | gauge | — | đọc từ cấu hình `LLM_MONTHLY_BUDGET_USD` |

Endpoint `/metrics` chỉ mở trong mạng nội bộ (bind cổng riêng `:9100` hoặc Nginx `deny all` cho `/metrics` từ ngoài) — kiểm tra lại ở [T07-03](T07-03-security-testing.md). Không nhãn nào chứa `user_id`, tên file, nội dung (tránh cardinality và PR-06).

### 4.2 Exporter và cấu hình

`deploy/observability/`:

```text
prometheus/prometheus.yml        # scrape api-1, api-2, worker (pushgateway hoặc /metrics worker), exporter
prometheus/rules/cwd-alerts.yml  # 7 + 2 rule
grafana/provisioning/{datasources,dashboards,alerting}/
grafana/dashboards/cwd-overview.json, cwd-llm.json, cwd-ingest.json, cwd-infra.json, cwd-product.json
blackbox/blackbox.yml            # probe https://<host>/readyz mỗi 30 s
```

Exporter: `node_exporter` (3 VM), `postgres_exporter`, `redis_exporter` (Valkey), `blackbox_exporter`, textfile collector `pgbackrest_last_success_timestamp` do cron `pgbackrest info --output=json` sinh mỗi 15 phút (đề xuất).

### 4.3 Dashboard

| Dashboard | Panel chính |
|---|---|
| **Tổng quan** | Sẵn sàng `/readyz` 08:00–20:00 (tỷ lệ % tuần), RPS, tỷ lệ 5xx, p50/p90 ký tự đầu và tổng thời gian, trạng thái circuit, tỷ lệ `degraded`, link tới Tempo theo `trace_id` |
| **LLM & chi phí** | Token theo `kind`/`purpose`, `cache_read` ÷ input (hiệu quả cache — T05-01), chi phí hôm nay / tháng này / dự báo cuối tháng vs ngân sách, `stop_reason=refusal`, inflight/semaphore |
| **Nạp tài liệu** | `cwd_queue_depth`, p90 `cwd_ingest_seconds` theo bucket trang (NFR-005), thất bại theo lý do |
| **Hạ tầng** | CPU/RAM/đĩa từng VM, kết nối PG/PgBouncer, kích thước DB, Valkey memory, thời điểm backup thành công gần nhất |
| **Sản phẩm (PostgreSQL datasource, chỉ đọc)** | Phễu kích hoạt EV-01→EV-05→EV-08→EV-09→EV-12/EV-17, tỷ lệ kiểm chứng, tỷ lệ lỗi trả lời, độ sâu hội thoại (PRD §6.2); user DB `grafana_ro` chỉ `SELECT` trên `ops.analytics_events`, `ops.weekly_stats` |

### 4.4 Cảnh báo

Giờ làm việc 08:00–20:00 ICT = 01:00–13:00 UTC, thứ Hai–Sáu. Recording rule `cwd:business_hours` = `vector(1) and on() (hour() >= 1 and hour() < 13) and on() (day_of_week() >= 1 and day_of_week() <= 5)`; trong bảng dưới viết tắt là `BH` (nghĩa là `and on() cwd:business_hours`).

| # | Cảnh báo | Biểu thức (rút gọn) | for | Mức |
|---|---|---|---|---|
| A1 | Độ trễ ký tự đầu | `histogram_quantile(0.9, sum by (le)(rate(cwd_llm_first_token_seconds_bucket[15m]))) > 3 and BH` | 15m | Warning |
| A2 | Tỷ lệ lỗi trả lời | `sum(rate(cwd_answer_status_total{status="failed"}[10m])) / sum(rate(cwd_answer_status_total[10m])) > 0.05` | 10m | Critical |
| A3 | Circuit mở | `max(cwd_circuit_state{target="claude"}) == 2` | 2m | Critical |
| A4 | Hàng đợi ứ | `max(cwd_queue_depth{queue="ingest"}) > 50` | 10m | Warning |
| A5 | Ingest thất bại | `sum(increase(cwd_ingest_failures_total[1h])) / sum(increase(cwd_ingest_total[1h])) > 0.2` | 0m | Warning |
| A6 | Chi phí | `sum(cwd_llm_cost_usd_total) - sum(cwd_llm_cost_usd_total offset <đầu tháng>) > 0.8 * cwd_llm_monthly_budget_usd` (dùng recording rule `cwd:llm_cost_month_to_date`) | 0m | Warning |
| A7 | Hạ tầng | đĩa > 80% **hoặc** `time() - pgbackrest_last_success_timestamp > 26h` **hoặc** `probe_success{job="readyz"} == 0` | 2m | Critical |
| A8 (đề xuất) | Thống kê không refresh | `time() - cwd_stats_last_refresh_timestamp > 3h` | 0m | Warning |
| A9 (đề xuất) | Model server suy giảm | `max(cwd_circuit_state{target="tei"}) == 2` | 5m | Warning |

- Contact point: kênh chat của đội + email trực (OQ-167); Critical cũng gửi SMS/điện thoại người trực nếu tổ chức có. Mỗi rule có annotation `runbook_url` trỏ `docs/runbooks/alerts.md#a1` …
- **Ngưỡng chi phí tháng:** `LLM_MONTHLY_BUDGET_USD` = 500 (đề xuất, ≈ 1,4 × ước tính $360/tháng SAD §12.4), PO xác nhận (OQ-011). Ghi vào biên bản LG-09.

### 4.5 Kiểm tra log không có nội dung

Script `deploy/observability/scripts/check_log_content.py`: lấy 20 câu hỏi canary từ golden set (`eval/golden_set.v1.yaml`) + 20 câu trích từ PDF mẫu, chạy chúng trên staging, sau 10 phút truy vấn Loki (`{app="cwd"} |~ "<chuỗi con 30 ký tự>"`) cho mọi chuỗi; đạt khi 0 kết quả. Đồng thời quét Tempo attributes của 50 trace `qa.*`. Chạy trong CI sau deploy staging (job `log-content-check`, không chặn release ở S6, chặn từ S7 — đề xuất).

## 5. Các bước thực hiện

- [ ] BE: `MetricsPort` + adapter; instrument theo bảng 4.1; multiprocess; test unit tên/nhãn metric.
- [ ] BE: bảng giá `config/llm_pricing.yaml` (input, output, cache read, cache write theo model) + test tính chi phí từ `usage` mẫu của spike T00-05.
- [ ] DevOps: exporter, scrape config, provisioning Grafana, 5 dashboard (commit JSON).
- [ ] DevOps: rule A1–A9, recording rules, contact point, giờ làm việc.
- [ ] Viết `docs/runbooks/alerts.md`: mỗi cảnh báo gồm ý nghĩa, kiểm tra đầu tiên, cách giảm thiểu, khi nào leo thang.
- [ ] **Bắn thử** từng cảnh báo trên staging (bảng §7), lưu ảnh chụp thông báo nhận được + thời điểm → `docs/evidence/LG-09/alerts-firing-<ngày>.md`.
- [ ] Chạy script kiểm tra log, lưu kết quả vào cùng thư mục bằng chứng.
- [ ] Triển khai cấu hình lên prod (T05-08), xác nhận scrape xanh.

## 6. Tiêu chí hoàn thành

- [ ] **EN-04:** dashboard độ trễ, lỗi, token, chi phí, hàng đợi có dữ liệu thật trên staging và prod.
- [ ] **EN-04:** 7 cảnh báo SAD §11.3 (A1–A7) bắn thử thành công, mỗi cái có bằng chứng thông báo đến kênh và tự resolve.
- [ ] **EN-04:** kiểm tra mẫu log + trace: 0 chuỗi canary xuất hiện.
- [ ] **LG-09:** panel sẵn sàng giờ làm việc; cảnh báo khi dịch vụ AI lỗi (A2, A3); ngưỡng chi phí tháng cấu hình và có cảnh báo 80% (A6).
- [ ] `/metrics` không truy cập được từ mạng người dùng.

## 7. Kiểm thử

| Cảnh báo | Cách bắn thử trên staging |
|---|---|
| A1 | Bật `FakeLLMAdapter` chế độ trễ 4 s (cờ `FAKE_LLM_FIRST_TOKEN_MS=4000`) + tải nhẹ 15 phút; hoặc hạ ngưỡng tạm `> 0.1` |
| A2, A3 | Đặt `ANTHROPIC_BASE_URL` trỏ tới stub trả 503 → 5 lỗi → circuit mở |
| A4 | Dừng worker, enqueue 60 job giả |
| A5 | Tải 10 PDF hỏng từ bộ file lỗi QA (DEP-002) |
| A6 | Đặt `LLM_MONTHLY_BUDGET_USD=1` tạm thời |
| A7 | Tạo file lớn đẩy đĩa staging > 80%; dừng container API 3 phút; sửa timestamp textfile backup |
| A8, A9 | Dừng `celery-beat` 3 giờ (hoặc chỉnh timestamp); dừng TEI |

## 8. Analytics / observability

Task này *là* observability. Không thêm sự kiện EV mới. Dashboard sản phẩm đọc EV-01..EV-19 từ `ops.analytics_events`.

## 9. Tham chiếu

- USER_STORIES EN-04, §10 DoD (kiểm tra mẫu log); PRD §4.7 NFR-001/004/005, §6.1 LG-09, §6.2.
- SAD §9.4, §11.2 (bảo vệ chi phí, SPOF), §11.3 (metric, cảnh báo), §12.1, §12.4, §13.
- IMPLEMENTATION_PLAN §4 S6 WP-62.

## 10. Giả định và câu hỏi mở

- Giả định: có VM-OBS hoặc stack Grafana của IT đã dựng trong T05-08; nếu dùng stack IT, rule cảnh báo nhập qua API của IT.
- Giả định: worker xuất metric qua `/metrics` riêng của tiến trình Celery (cổng nội bộ) thay cho Pushgateway.
- **OQ-166 (mới):** Ai triển khai "chạm 100% ngân sách → giảm hạn mức câu hỏi/người" (SAD §11.2)? Không có task nào trong README. Đề xuất: PO chấp nhận chỉ cảnh báo 80% + thao tác thủ công giảm rate limit qua cấu hình cho MVP.
- **OQ-167 (mới):** Kênh nhận cảnh báo (Teams/Slack/email) và lịch trực ngoài giờ, kể cả kỳ Tết? Owner: Trưởng nhóm Dev + IT.
- OQ-011 (kế thừa): ngân sách chi phí tháng chính thức.
