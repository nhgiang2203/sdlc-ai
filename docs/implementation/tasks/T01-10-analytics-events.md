# T01-10 — Thu sự kiện analytics (server + client)

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | EN-07 · WP-13 |
| Loại | BE, FE |
| Ước lượng | 2,5 ngày công (BE 1,5 · FE 1) |
| Phụ thuộc | [T00-04](T00-04-db-baseline-migration.md), [T01-02](T01-02-csrf-rbac-ratelimit-me.md) |
| Chặn | [T02-05](T02-05-ask-question-sse.md), [T06-01](T06-01-weekly-stats-api.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Dựng hạ tầng analytics tự lưu (ADR-013) gồm bốn phần: bảng `ops.analytics_events` phân vùng theo tháng; danh mục sự kiện EV-01..EV-19 có schema chặt (từ chối khoá lạ, không chứa nội dung); `AnalyticsPort` để use case ghi sự kiện phía server; endpoint `POST /api/v1/events` và thư viện `lib/analytics` phía client (hàng đợi, gửi lô 10 s, gửi khi rời trang). Story từ S1 trở đi chỉ cần gọi `record(...)` hoặc `track(...)`.

## 2. Bối cảnh

- PRD §6.2: nguyên tắc không ghi nội dung; thuộc tính chung `event_id`, `timestamp`, `user_id`, `session_id`, `app_version`, `viewport_width`; danh mục 19 sự kiện; LG-08 (100% sự kiện P0 ghi được trên staging).
- SAD §7.2 (`ops.analytics_events`, khoá `(ts, event_id)`, phân vùng tháng, btree `(name, ts)`, `(user_id, ts)`), §10.2 (`POST /events` ≤ 50 sự kiện, 202, 400, từ chối khoá ngoài danh mục), §4.1 (client gửi lô 10 s hoặc khi `visibilitychange`), §11.3 (server ghi EV-05, EV-06, EV-08, EV-09, EV-10).
- IMPLEMENTATION_PLAN §2.3: EN-07 kéo lên S1 vì DoD của mọi story yêu cầu phát sự kiện.

## 3. Phạm vi

**Trong phạm vi:** migration bảng + phân vùng; `cwd/domain/analytics/catalog.py` (19 schema); `AnalyticsPort` + `PgAnalyticsRecorder`; use case `RecordClientEvents`; router `POST /api/v1/events`; xuất catalog ra JSON để FE dùng; `frontend/src/lib/analytics/*`; nối các điểm phát của S1: EV-01, EV-02 (T01-01, T01-03), EV-03, EV-04 (T01-08), EV-05, EV-06 (T01-06).

**Ngoài phạm vi:** phát EV-07..EV-19 tại từng tính năng (task của story tương ứng: T02-05, T02-06, T02-07, T04-02…); materialized view `ops.weekly_stats` (T06-01); dashboard Grafana (T06-04); xoá dữ liệu analytics theo retention (T06-06).

## 4. Thiết kế chi tiết

### 4.1 Migration `backend/migrations/versions/0105_ops_analytics_events.py`

```sql
CREATE TABLE ops.analytics_events (
  ts timestamptz NOT NULL,
  event_id uuid NOT NULL,
  name text NOT NULL,
  user_id uuid,                     -- NULL cho EV-02 not_authorized
  session_id uuid,                  -- analytics_session_id (T01-01), không phải session cookie
  source text NOT NULL CHECK (source IN ('client','server')),
  props jsonb NOT NULL DEFAULT '{}',
  app_version text,
  viewport_width int,               -- (đề xuất) thuộc tính chung PRD §6.2; NULL với sự kiện server
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts, event_id)
) PARTITION BY RANGE (ts);
CREATE INDEX ON ops.analytics_events (name, ts);
CREATE INDEX ON ops.analytics_events (user_id, ts);
-- Tạo phân vùng 2026-11 … 2027-12 + DEFAULT (đề xuất); job tạo phân vùng tháng sau làm ở T06-01
CREATE TABLE ops.analytics_events_2026_11 PARTITION OF ops.analytics_events FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
-- … lặp theo tháng …
CREATE TABLE ops.analytics_events_default PARTITION OF ops.analytics_events DEFAULT;
```

### 4.2 Danh mục (`backend/cwd/domain/analytics/catalog.py`)

Mỗi sự kiện là một model Pydantic `extra="forbid"`, kèm `sources` và `priority`. Chuỗi tự do **bị cấm**: mọi `str` phải là `Literal[...]` hoặc UUID. Số có giới hạn `ge/le`.

| ID | `name` | `sources` | Props (kiểu) |
|---|---|---|---|
| EV-01 | `session_started` | server (đề xuất, OQ-103) | `is_first_session: bool` |
| EV-02 | `access_denied` | server (`not_authorized`), client (`session_expired`) | `reason: Literal["not_authorized","session_expired"]` |
| EV-03 | `document_upload_started` | client | `document_id: UUID`, `file_size_mb: float(0..50)`, `batch_size: int(1..50)` |
| EV-04 | `document_upload_rejected` | client | `reason: Literal["not_pdf","too_large","too_many_pages","duplicate_cancelled"]` |
| EV-05 | `document_processing_completed` | server | `document_id`, `page_count: int`, `processing_seconds: float`, `unreadable_pages: int` |
| EV-06 | `document_processing_failed` | server | `document_id`, `reason: Literal["password","corrupted","scanned","other"]` |
| EV-07 | `document_removed` | server (đề xuất, T05-03) | `document_id`, `age_days: int` |
| EV-08 | `question_submitted` | server | `conversation_id`, `turn_index`, `question_length`, `language: Literal["vi","en","other"]`, `scope_type: Literal["all","selected"]`, `docs_in_scope` |
| EV-09 | `answer_completed` | server | `conversation_id`, `turn_index`, `answer_type: Literal["answered","partial","not_found"]`, `first_token_ms`, `total_ms`, `citation_count`, `distinct_docs_cited` |
| EV-10 | `answer_failed` | server, client (`network`) (đề xuất) | `error_type: Literal["network","timeout","service_unavailable","other"]`, `elapsed_ms` |
| EV-11 | `answer_stopped` | client | `elapsed_ms` |
| EV-12 | `citation_clicked` | client | `conversation_id`, `turn_index`, `citation_index`, `document_id`, `page` |
| EV-13 | `source_viewer_loaded` | client | `document_id`, `load_ms`, `highlight_found: bool` |
| EV-14 | `scope_changed` | client | `docs_selected: int` |
| EV-15 | `conversation_started` | client | `conversation_id` |
| EV-16 | `conversation_reopened` | client | `conversation_id`, `age_days` |
| EV-17 | `answer_rated` | client | `conversation_id`, `turn_index`, `rating: Literal["up","down"]`, `reason: Literal[...] \| None` |
| EV-18 | `answer_copied` | client | `conversation_id`, `turn_index` |
| EV-19 | `stats_viewed` | client | `period: str` dạng ISO week `^\d{4}-W\d{2}(\.\.\d{4}-W\d{2})?$` |

Lệnh `python -m cwd.domain.analytics.export > frontend/src/lib/analytics/catalog.json` xuất JSON Schema. CI so khớp file đã commit với kết quả xuất để FE và BE không lệch nhau.

### 4.3 Phía server

```python
class AnalyticsPort(Protocol):
    def record(self, name: str, props: Mapping[str, Any], *, user_id: UUID | None,
               session_id: UUID | None = None, ts: datetime | None = None) -> None: ...
```

- `PgAnalyticsRecorder`: kiểm schema theo catalog (sai → **raise** trong test, log `error` và bỏ qua ở runtime, để analytics hỏng không làm hỏng nghiệp vụ). `INSERT … ON CONFLICT DO NOTHING`, `source='server'`, `event_id = uuid7()`.
- Ghi **sau khi** giao dịch nghiệp vụ commit (không dùng chung giao dịch). Lỗi ghi → log `warning`, metric `cwd_analytics_write_errors_total`.
- `NoopAnalytics` dùng cho test và trước khi wiring.

### 4.4 `POST /api/v1/events`

Bảo vệ: `require_roles("user")`, CSRF (T01-02), `rate_limit(EVENTS_POLICY)` (60/phút, đề xuất), body ≤ 256 KB.

```json
{ "context": { "app_version": "2026.11.12-3f9c2ab", "viewport_width": 1440 },
  "events": [ { "event_id": "0193…", "name": "document_upload_rejected", "ts": "2026-11-12T02:10:03.120Z",
                "props": { "reason": "too_large" } } ] }
```

- 1..50 sự kiện. Mỗi sự kiện: `name` có trong catalog **và** `"client"` thuộc `sources`; `props` hợp lệ theo schema; `ts` trong khoảng [now − 24 h, now + 5 phút].
- Có bất kỳ sự kiện sai → **400 cả lô** `VALIDATION_ERROR` kèm `errors: [{index, field, code}]`, không ghi gì (đề xuất; SAD chỉ ghi 400).
- Server tự điền `user_id` (từ phiên), `session_id` (= `analytics_session_id`), `source='client'`. Client **không** gửi các trường này; nếu gửi thì 400 vì khoá lạ.
- 202, không có body. Trùng `event_id` + `ts` thì bỏ qua (client gửi lại an toàn).

### 4.5 Phía client (`frontend/src/lib/analytics/`)

| File | Nội dung |
|---|---|
| `catalog.json`, `types.ts` | Kiểu sinh từ catalog: `track<N extends EventName>(name: N, props: EventProps[N])` |
| `queue.ts` | Hàng đợi bộ nhớ ≤ 500 sự kiện (tràn thì bỏ cũ nhất); `flush()` |
| `transport.ts` | `fetch("/api/v1/events", {method: "POST", keepalive: true, headers: {X-CSRF-Token, X-CWD-Background: "1"}})` |
| `index.ts` | `initAnalytics({appVersion})`, `track`, `flushNow` |

- Flush mỗi 10 s, khi đủ 50 sự kiện, và khi `visibilitychange → hidden` hoặc `pagehide`.
- **Dùng `fetch(..., {keepalive: true})` thay cho `navigator.sendBeacon`** vì `sendBeacon` không gắn được header `X-CSRF-Token` (đề xuất, khác SAD §4.1; xem OQ-116).
- Kết quả: 202 → xoá khỏi hàng đợi; lỗi mạng/5xx → giữ lại, thử lại ở chu kỳ sau; 400 → bỏ lô và `console.error` (lỗi lập trình); 401 → chuyển hàng đợi sang `sessionStorage` khoá `cwd.analytics.pending` (chỉ metadata, không có nội dung). Sau khi đăng nhập lại, `initAnalytics` đọc khoá này, gửi lại rồi xoá. EV-02 `session_expired` đi theo đường này.
- `event_id` = `crypto.randomUUID()`; `ts` = `new Date().toISOString()`; `viewport_width` = `window.innerWidth`.
- `track` không bao giờ ném lỗi ra caller.

## 5. Các bước thực hiện

- [ ] BE: viết migration 0105 và test chèn vào phân vùng đúng tháng và DEFAULT.
- [ ] BE: viết `catalog.py` (19 model) + lệnh export + test "không có `str` tự do".
- [ ] BE: viết `AnalyticsPort`, `PgAnalyticsRecorder`, `NoopAnalytics`; wiring vào container DI cho API và Worker.
- [ ] BE: viết `RecordClientEvents` + router `/api/v1/events`.
- [ ] BE: nối điểm phát server: EV-01, EV-02 (T01-01), EV-05, EV-06 (T01-06).
- [ ] FE: viết `lib/analytics` (queue, transport, pending qua 401) + unit test.
- [ ] FE: nối EV-02 `session_expired` (T01-03), EV-03, EV-04 (T01-08).
- [ ] Thêm job CI so khớp `catalog.json`.
- [ ] Viết script kiểm tra trên staging `scripts/check_events.sql`: đếm theo `name` trong 24 giờ, phục vụ LG-08.

## 6. Tiêu chí hoàn thành

- [ ] **EN-07 / LG-08 (phần S1):** trên staging, sau một lượt E2E J1 phần S1 (đăng nhập → tải lên → sẵn sàng; tải file sai; huỷ trùng; outsider bị từ chối; hết phiên), bảng có đủ EV-01, EV-02 (2 lý do), EV-03, EV-04, EV-05, EV-06 với thuộc tính đúng schema.
- [ ] **EN-07:** sự kiện có khoá ngoài schema (ví dụ `props.question_text`) → 400, không ghi; `name` lạ → 400; sự kiện chỉ-server (`answer_completed`) gửi từ client → 400.
- [ ] **EN-07:** test tự động duyệt catalog: không trường nào nhận chuỗi tự do, nên không thể chứa nội dung câu hỏi hay tài liệu. Kiểm mẫu 100 dòng trên staging không có tên file hay văn bản.
- [ ] Client gửi lô ≤ 50, cách nhau ~10 s; đóng tab vẫn gửi được (Playwright: `page.close()` → request `keepalive` tới server).
- [ ] Analytics lỗi (DB phân vùng thiếu, server 500) không làm hỏng luồng tải lên hay đăng nhập.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit (BE) | Mỗi schema: props hợp lệ OK; thiếu trường bắt buộc, sai kiểu, khoá lạ, enum lạ → lỗi; `ts` lệch 2 ngày → lỗi |
| Unit (BE) | Test thuộc tính catalog: mọi field `str` phải là Literal/UUID/pattern |
| Integration (BE) | `POST /events` 50 sự kiện → 202 và 50 dòng; 51 → 400; gửi lại cùng lô → vẫn 50 dòng; user không có phiên → 401; thiếu CSRF → 403 |
| Integration (BE) | `PgAnalyticsRecorder` từ Worker: EV-05 với `user_id = uploaded_by` |
| Unit (FE) | Queue: flush theo 10 s (fake timers), theo 50 sự kiện, khi `visibilitychange`; 5xx giữ lại; 400 bỏ lô; 401 chuyển sang `sessionStorage` rồi gửi lại sau `initAnalytics` |
| Hợp đồng | `catalog.json` commit khớp kết quả export; kiểu TS biên dịch được với mọi lời gọi `track` hiện có |

## 8. Analytics / observability

- Metric: `cwd_analytics_events_total{name,source}`, `cwd_analytics_rejected_total{reason}`, `cwd_analytics_write_errors_total`.
- Log không chứa `props` (chỉ `name`, số lượng).

## 9. Tham chiếu

PRD §6.2 (nguyên tắc, danh mục, phễu), §6.1 LG-08; SAD §4.1 (Analytics), §7.1, §7.2, §10.2 (`POST /events`), §11.3 (analytics sản phẩm), ADR-013; USER_STORIES EN-07, §10 DoD; IMPLEMENTATION_PLAN §2.3, WP-13.

## 10. Giả định và câu hỏi mở

- Phân vùng tạo sẵn tới 2027-12 cộng phân vùng DEFAULT. Job tạo phân vùng tháng mới gắn vào `celery-beat` ở T06-01 (đề xuất).
- Cột `source`, `viewport_width`, `received_at` và object `context` trong request là đề xuất, chưa có trong SAD §7.2/§10.2.
- **OQ-116:** SAD §4.1 chỉ định `navigator.sendBeacon`, nhưng `sendBeacon` không gửi được header CSRF. Đề xuất dùng `fetch keepalive` (§4.5). Phương án khác: miễn CSRF cho `/events` và chỉ kiểm `Origin`. Cần Architect chốt.
- **OQ-117:** EV-10 `answer_failed` có `error_type = network` mà chỉ client phát hiện được, trong khi SAD §11.3 xếp EV-10 là sự kiện server. Đề xuất cho phép cả hai nguồn (server: `timeout`/`service_unavailable`/`other`; client: `network`). T02-05/T02-06 cần tránh đếm trùng.
- **OQ-118:** `props` của EV-17 `reason` và EV-19 `period` cần chốt định dạng cuối cùng khi làm T06-03 và T06-02. Schema hiện tại là đề xuất.
