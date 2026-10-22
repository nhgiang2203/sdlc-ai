# T00-08 — Log có cấu trúc, tracing OTel, lỗi RFC 9457

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | EN-04 (phần cơ bản), WP-06 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T00-01](T00-01-backend-scaffold.md) |
| Chặn | [T01-01](T01-01-oidc-session.md), [T06-04](T06-04-metrics-dashboards-alerts.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp ba thứ dùng chung cho mọi endpoint và task Worker từ S1: (1) log JSON bằng structlog có `request_id`, `trace_id`, **không chứa nội dung** (PR-06); (2) tracing OpenTelemetry cho FastAPI, SQLAlchemy, httpx, Celery xuất OTLP; (3) chuẩn hoá mọi lỗi thành `application/problem+json` theo RFC 9457 với danh mục mã lỗi của SAD §10.

## 2. Bối cảnh

- SAD §11.3: trường log `ts, level, request_id, trace_id, user_id, route, status, duration_ms, error_code`; span `http.request → qa.retrieve → llm.stream → db.persist`; trace ID xuyên sang Worker qua header Celery; không gắn nội dung vào span.
- SAD §10.1: lỗi `{type, title, status, code, detail, request_id}`; header `X-Request-ID` nhận hoặc sinh, trả lại trong phản hồi và log.
- SAD §4.4: thứ tự middleware — **request ID + OTel tracing** đứng đầu, **chuẩn hoá lỗi (RFC 9457)** đứng cuối. Task này dựng hai đầu chuỗi; các middleware giữa (body size, session, CSRF, RBAC, rate limit) do T01-01/T01-02 chèn.
- IMPLEMENTATION_PLAN §2.3: EN-04 tách đôi — log/trace cơ bản ở S0 để đo spike; dashboard + cảnh báo ở S6.

## 3. Phạm vi

**Trong phạm vi:**
- Deps: `structlog`, `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-grpc`, `opentelemetry-instrumentation-{fastapi,sqlalchemy,httpx,celery,logging}`.
- `cwd/entrypoints/observability/{logging.py, tracing.py, context.py}`; `cwd/entrypoints/api/{middleware/request_context.py, errors.py}`.
- Ngoại lệ ứng dụng `AppError` trong `cwd/application/errors.py` (thuần, không phụ thuộc FastAPI).
- Bộ lọc khoá cấm trong log; test kiểm tra.
- Đường ống trace hoạt động trên Compose dev (Collector → Jaeger) và staging.

**Ngoài phạm vi:**
- Metric Prometheus, dashboard, 7 cảnh báo → [T06-04](T06-04-metrics-dashboards-alerts.md).
- Span nghiệp vụ `qa.retrieve`, `llm.stream` → task pipeline ([T02-02](T02-02-hybrid-retrieval-rerank.md), [T02-03](T02-03-claude-llm-adapter.md), [T02-05](T02-05-ask-question-sse.md)); task này cung cấp helper.
- Log audit đăng nhập → [T01-01](T01-01-oidc-session.md) (dùng logger `audit` định nghĩa ở đây).
- Sự kiện analytics → [T01-10](T01-10-analytics-events.md).

## 4. Thiết kế chi tiết

### 4.1 Ngữ cảnh request (`context.py`)

```python
request_id_var: ContextVar[str | None]; user_id_var: ContextVar[UUID | None]; route_var: ContextVar[str | None]
def bind_user(user_id: UUID) -> None        # T01-01 gọi sau khi xác thực phiên
```

### 4.2 Middleware `RequestContextMiddleware` (ASGI thuần, đứng đầu)

1. Đọc `X-Request-ID`; hợp lệ nếu khớp `^[A-Za-z0-9._-]{8,64}$`, ngược lại sinh UUID v7.
2. Gán `request_id_var`; thêm thuộc tính `cwd.request_id` vào span hiện tại (span do instrumentation FastAPI tạo — instrumentation bọc ngoài middleware này).
3. Gắn `X-Request-ID` vào mọi phản hồi (kể cả lỗi và SSE).
4. Cuối request: một dòng log `http.request` mức INFO với `route` (template, ví dụ `/api/v1/documents/{id}`, **không** path thật), `method`, `status`, `duration_ms`. Bỏ qua `/healthz`, `/readyz` (log DEBUG).

### 4.3 Logging (`logging.py`)

```python
def configure_logging(level: str, env: str, app_version: str) -> None
```

- structlog → `stdlib` → stdout JSON một dòng/sự kiện (`JSONRenderer`, `ensure_ascii=False`); ở `CWD_ENV=dev` dùng `ConsoleRenderer` màu (đề xuất).
- Processor theo thứ tự: `merge_contextvars` → thêm `request_id`, `user_id`, `route` từ ContextVar → thêm `trace_id`, `span_id` từ span hiện tại (hex) → `TimeStamper(fmt="iso", utc=True, key="ts")` → `add_log_level` → **`redact_content`** → `format_exc_info` → renderer.
- Gắn trường tĩnh `service` (`api` | `worker` | `beat`), `version`, `env`.
- Bắt log của `uvicorn`, `celery`, `sqlalchemy` qua `ProcessorFormatter`; tắt `uvicorn.access` (đã có `http.request`).
- Logger `audit` (`structlog.get_logger("audit")`) gắn `level="audit"` cho sự kiện bảo mật (SAD §11.3).

**`redact_content` (PR-06):** danh sách khoá cấm → giá trị bị thay bằng `"[REDACTED len=<n>]"`:
`question, answer, text, content, cited_text, llm_content, prompt, system, messages, document_text, page_text, chunk_text, note, filename, title, q, authorization, cookie, set-cookie, x-csrf-token, password, secret, api_key, access_token, id_token, refresh_token, code`.
Áp dụng đệ quy cho dict lồng. `filename`/`title` bị che vì tên tài liệu có thể chứa thông tin kinh doanh (đề xuất; audit log trong CSDL vẫn lưu tên — SAD §7.2). Exception message do thư viện ngoài sinh (ví dụ lỗi Pydantic có `input`) phải được log qua `error_code` + loại ngoại lệ, không log `str(exc)` của lỗi validation.

### 4.4 Tracing (`tracing.py`)

```python
def configure_tracing(service_name: str, settings: Settings) -> None
```

- `Resource`: `service.name = cwd-api | cwd-worker`, `service.version = <sha>`, `deployment.environment`.
- `BatchSpanProcessor(OTLPSpanExporter(endpoint=CWD_OTEL_EXPORTER_OTLP_ENDPOINT, insecure=<dev>))` — exporter bất đồng bộ, không chặn luồng chính (IF-07). Tắt hoàn toàn khi `CWD_OTEL_ENABLED=false` (mặc định `false` trong test).
- Sampler: `ParentBased(TraceIdRatioBased(CWD_OTEL_SAMPLE_RATIO))`, mặc định 1.0 ở dev/staging (đề xuất).
- Instrumentation: `FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz")`, `SQLAlchemyInstrumentor` (engine, `enable_commenter=False`), `HTTPXClientInstrumentor` (TEI, Claude SDK dùng httpx), `CeleryInstrumentor` (lan truyền context qua header task — SAD §11.3).
- **Không nội dung trong span:** SQLAlchemy instrumentation ghi `db.statement` dạng có placeholder, không ghi giá trị bind — chấp nhận (test §7 xác nhận giá trị bind không xuất hiện). Với httpx: hook `request_hook`/`response_hook` không thêm body. FastAPI: không bật capture header request/response.
- Helper cho task sau:

```python
@contextmanager
def span(name: str, **attrs: str | int | float | bool) -> Iterator[Span]   # kiểm tra khoá attrs không thuộc danh sách cấm §4.3
```

### 4.5 Lỗi RFC 9457 (`errors.py`)

```python
# cwd/application/errors.py  (không import FastAPI)
class AppError(Exception):
    code: ClassVar[str]; status: ClassVar[int]; title: ClassVar[str]
    def __init__(self, detail: str | None = None, **extra: Any) -> None   # extra: ví dụ existing_document_id
class NotFound(AppError): code="NOT_FOUND"; status=404; title="Không tìm thấy"
...
```

| `code` | HTTP | `title` (tiếng Việt) | Nguồn SAD §10.2 |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | Cần đăng nhập | `/me` và mọi endpoint |
| `FORBIDDEN` | 403 | Không có quyền truy cập | audit, stats |
| `NOT_FOUND` | 404 | Không tìm thấy | documents, conversations (cả khi không phải chủ — INV-02) |
| `VALIDATION_ERROR` | 400 | Dữ liệu không hợp lệ | messages, events |
| `DUPLICATE_DOCUMENT` | 409 | Tài liệu đã có trong kho | POST documents (kèm `existing_document_id`) |
| `ALREADY_REMOVED` | 409 | Tài liệu đã được gỡ | DELETE documents |
| `NO_READY_DOCUMENTS` | 409 | Chưa có tài liệu sẵn sàng | messages |
| `CONVERSATION_TOO_LONG` | 409 | Hội thoại quá dài | messages (> 20 lượt) |
| `DOCUMENT_REMOVED` | 410 | Tài liệu đã bị gỡ | file |
| `FILE_TOO_LARGE` | 413 | Tệp vượt quá 50 MB | POST documents |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Chỉ hỗ trợ PDF | POST documents |
| `RATE_LIMITED` | 429 | Quá nhiều yêu cầu | kèm `Retry-After` (đề xuất tên mã; SAD chỉ ghi "429") |
| `SERVICE_UNAVAILABLE` | 503 | Hệ thống đang bận | phụ thuộc lỗi ngoài SSE |
| `INTERNAL` | 500 | Lỗi hệ thống | ngoại lệ không lường trước |

- `type` = `https://cwd.internal/problems/<code-kebab>` (đề xuất; URI định danh, không cần truy cập được).
- Handler FastAPI: `AppError` → problem với `code`, `title`, `status`, `detail`, `request_id` + trường mở rộng; `RequestValidationError` → `VALIDATION_ERROR`, `errors: [{loc, type}]` (**không** kèm `input`/`msg` chứa giá trị người dùng); `StarletteHTTPException` 404/405 → `NOT_FOUND`/`METHOD_NOT_ALLOWED`; `Exception` → `INTERNAL`, `detail` chung, log `error` có stacktrace + `error_code`.
- Content-Type `application/problem+json`; luôn có header `X-Request-ID`.
- `detail` là câu cho người dùng (tiếng Việt), không chứa stacktrace hay SQL (Blueprint §2.5 "không hiển thị mã lỗi kỹ thuật thô"; `request_id` hiển thị như "Mã tham chiếu").

### 4.6 Worker

`cwd/entrypoints/worker/celery_app.py` gọi `configure_logging(service="worker")`, `configure_tracing("cwd-worker")` trong signal `worker_process_init` (mỗi tiến trình con). Signal `task_prerun` gán `request_id_var = task.request.headers.get("cwd_request_id")` (API thêm header khi enqueue — helper `enqueue_with_context()` trong `cwd/adapters/celery/` (đề xuất)).

## 5. Các bước thực hiện

- [ ] Thêm deps; viết `context.py`, `logging.py` (gồm `redact_content`), `tracing.py`.
- [ ] Viết `RequestContextMiddleware`, đăng ký trong `create_app()` ở vị trí đầu; handler lỗi ở cuối.
- [ ] Viết `AppError` và lớp con theo bảng §4.5; handler `errors.py`.
- [ ] Nối vào Worker (§4.6) và task `maintenance.ping`.
- [ ] Viết test §7; chạy trên Compose dev profile `obs`, xem trace API → Worker trong Jaeger.
- [ ] Viết `docs`-ngắn trong docstring module: cách thêm mã lỗi mới, danh sách khoá cấm.

## 6. Tiêu chí hoàn thành

- [ ] Mọi dòng log của API/Worker là JSON có `ts, level, service, request_id, trace_id` (khi có span), `route`, `status`, `duration_ms` cho dòng `http.request` (SAD §11.3, WP-06).
- [ ] Phản hồi luôn có `X-Request-ID`; giá trị client gửi hợp lệ được giữ nguyên (SAD §10.1).
- [ ] Mọi lỗi trả `application/problem+json` đủ 6 trường `{type, title, status, code, detail, request_id}`.
- [ ] Trace của một request gọi task Celery hiển thị liền một trace (API span → worker span) trên Jaeger cục bộ (WP-06).
- [ ] Test chứng minh khoá cấm không xuất hiện trong log (EN-04: "log không chứa nội dung câu hỏi (kiểm tra mẫu)").

## 7. Kiểm thử

| Loại | Kịch bản | Kỳ vọng |
|---|---|---|
| Unit | `log.info("x", question="Giá hợp đồng?", doc_id="…")` qua `capture_logs` | `question` = `[REDACTED len=13]`, `doc_id` giữ |
| Unit | Dict lồng `{"payload": {"text": "…"}}` | `text` bị che |
| Unit | Request không có `X-Request-ID` | Phản hồi có ID dạng UUID v7 |
| Unit | Request có `X-Request-ID: abc` (quá ngắn) / `<script>` | Bị thay bằng ID mới |
| Unit | Route ném `NotFound()` | 404, `code=NOT_FOUND`, `request_id` khớp header |
| Unit | Body sai schema chứa chuỗi `"Bí mật"` | 400 `VALIDATION_ERROR`; phản hồi và log **không** chứa "Bí mật" |
| Unit | Route ném `ZeroDivisionError` | 500 `INTERNAL`, `detail` không có stacktrace; log có `exc_info` |
| Unit | `span("x", question="…")` | Ném `ValueError` (khoá cấm) |
| Unit | `InMemorySpanExporter`: `GET /api/v1/_test` | 1 span server có `http.route`, có `cwd.request_id` |
| Integration | Compose dev: endpoint thử enqueue `maintenance.ping` | Jaeger hiển thị trace gồm span API và span worker cùng `trace_id`; log worker có cùng `request_id` |

## 8. Analytics / observability

Task này **là** nền observability: định nghĩa trường log, tên service, helper span cho mọi task sau. Metric RED, histogram, cảnh báo thêm ở T06-04 trên cùng `Resource`. Mẫu log staging được kiểm định kỳ (DoD) bằng script `grep` khoá cấm — script đặt ở `deploy/observability/check_log_content.sh` (đề xuất).

## 9. Tham chiếu

- SAD §2.3 PR-06, §4.4 (thứ tự middleware), §10.1, §10.2 (mã lỗi), §10.4 IF-07, §11.3
- USER_STORIES §8 EN-04, §10 DoD
- Blueprint_Design §2.5 (Error Messaging), §3.6.4
- IMPLEMENTATION_PLAN §2.3, §4 S0 WP-06
- RFC 9457 Problem Details for HTTP APIs

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Thiếu phụ thuộc | Kiểm chứng trace "trên Jaeger cục bộ" cần Collector/Jaeger của [T00-03](T00-03-dev-docker-compose.md) (profile `obs`); README chỉ ghi T00-01. Test unit dùng `InMemorySpanExporter` nên vẫn làm song song được. |
| Đề xuất | Mã `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `INTERNAL`, `METHOD_NOT_ALLOWED`, URI `type` — SAD chưa đặt tên. |
| Đề xuất | Che `filename`/`title`/`q` trong log; cần Bảo mật thông tin xác nhận mức độ (tên file có thể là thông tin mật). |
| Đề xuất | `user_id` trong log là UUID nội bộ, không phải email/subject IdP. |
| OQ-019 | Nếu Pháp chế coi `user_id` là dữ liệu cá nhân, retention log 30 ngày (SAD §7.4) cần được xác nhận. |
