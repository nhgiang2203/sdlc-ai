# T02-05 — Use case `AskQuestion` + endpoint SSE

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-008, US-010 · WP-21, WP-22 |
| Loại | BE |
| Ước lượng | 4 ngày công |
| Phụ thuộc | [T02-01](T02-01-conversations-ownership.md), [T02-02](T02-02-hybrid-retrieval-rerank.md), [T02-03](T02-03-claude-llm-adapter.md), [T02-04](T02-04-system-prompt-v1.md), [T01-10](T01-10-analytics-events.md) |
| Chặn | [T02-10](T02-10-golden-set-runner.md), [T03-02](T03-02-not-found-gate-calibration.md), [T04-03](T04-03-scope-filter-api.md), [T04-05](T04-05-english-language-support.md), [T05-01](T05-01-follow-up-rewrite-history.md), [T05-03](T05-03-document-removal-api.md), [T06-03](T06-03-answer-feedback.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Điều phối pipeline RAG bước 1, 3–11 (SAD §4.2) trong use case `AskQuestion` và phát kết quả qua `POST /api/v1/conversations/{id}/messages` dạng `text/event-stream` theo hợp đồng SAD §10.3 (`meta`, `delta`, `citation`, `done`, `error`, `: ping`). Đánh số trích dẫn `[n]`, áp INV-04 (không có citation → `partial`), ghi message + citations + usage trong một giao dịch, ghi sự kiện server-side EV-08, EV-09, EV-10. Đây là lõi của walking skeleton M2.

## 2. Bối cảnh

- Luồng tuần tự: SAD §8.1; vòng đời message assistant: §9.2; nhánh lỗi: bảng dưới §8.1.
- Các khối đã có: kiểm tra sở hữu + repository (T02-01), `RetrieveContext` (T02-02), `LLMPort` + `map_citation` (T02-03), `PromptRegistry` (T02-04), ghi sự kiện server-side `AnalyticsRecorder` (T01-10), middleware phiên/CSRF/rate limit (T01-02).
- Frontend đọc SSE bằng `fetch` + `ReadableStream` (ADR-008), làm ở [T02-06](T02-06-fe-chat-composer-stream.md).

## 3. Phạm vi

**Trong phạm vi:**
- Use case `AskQuestion`, router `messages`, bộ mã hoá SSE, ping 15 s, phát hiện client ngắt.
- Rate limit câu hỏi 10/phút + 60/giờ mỗi người (cấu hình bucket trên middleware T01-02).
- Semaphore toàn hệ thống 15 lời gọi Claude đồng thời.
- Đánh số citation, dựng `segments`, INV-04, lưu `llm_content` của lượt user và assistant.
- Chỗ gọi cổng "không tìm thấy" (`NotFoundGate`) với bản S2 tối giản.
- `meta.docs_in_scope`, `meta.docs_processing` (dữ liệu cho AC-US008-8).
- EV-08, EV-09, EV-10 server-side.

**Ngoài phạm vi:**
- Cổng τ_nf đầy đủ, nhận diện câu cố định, hiệu chỉnh τ → [T03-02](T03-02-not-found-gate-calibration.md).
- Bước 2 viết lại câu hỏi, gửi lịch sử, giới hạn 20 lượt (409 `CONVERSATION_TOO_LONG`), kiểm tra cache → [T05-01](T05-01-follow-up-rewrite-history.md). S2: mỗi câu hỏi xử lý độc lập, không gửi lịch sử.
- Lọc `scope_document_ids` → [T04-03](T04-03-scope-filter-api.md). S2 luôn tìm toàn kho.
- Phát hiện ngôn ngữ chuẩn cho EV-08 → [T04-05](T04-05-english-language-support.md) (S2 dùng heuristic §4.8).
- Circuit breaker, chế độ `degraded` → [T05-07](T05-07-circuit-breaker-degraded.md).
- Hiển thị ghi chú "N tài liệu đang xử lý" → [T03-03](T03-03-fe-not-found-processing-note.md). EV-11 (Dừng) phía client → [T02-06](T02-06-fe-chat-composer-stream.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `backend/cwd/application/qa/ask_question.py` | `AskQuestion` (async generator sự kiện ứng dụng) |
| `backend/cwd/application/qa/not_found_gate.py` | `NotFoundGate` Protocol + `EmptyPassagesGate` (S2) |
| `backend/cwd/domain/conversations/citation_numbering.py` | `CitationNumbering`, `SegmentBuilder`, `decide_answer_type` |
| `backend/cwd/ports/concurrency.py` | `LLMSlotLimiter` Protocol |
| `backend/cwd/adapters/valkey/llm_semaphore.py` | `ValkeyLLMSemaphore` |
| `backend/cwd/entrypoints/api/routers/messages.py` | Router `POST /conversations/{id}/messages` |
| `backend/cwd/entrypoints/api/sse.py` | `encode_event`, `with_pings`, `EventSourceResponse` |
| `backend/tests/contract/test_sse_contract.py`, `backend/tests/integration/test_ask_question.py` | Test |

### 4.2 Endpoint

`POST /api/v1/conversations/{id}/messages` — header `X-CSRF-Token`, cookie phiên.

Request (Pydantic):

```json
{ "question": "Điều khoản thanh toán của dự án Phú Hưng?", "scope_document_ids": null }
```

- `question`: `str`, `strip()` rồi 1..2.000 ký tự (đếm code point sau NFC). Rỗng/chỉ khoảng trắng → 400.
- `scope_document_ids`: `list[UUID] | None`, ≤ 200 phần tử. S2 nhận nhưng **bỏ qua** khi `FEATURE_SCOPE=false` (ghi log `scope_ignored=true`) — T04-03 bật.

Lỗi **trước khi mở stream** (HTTP + `application/problem+json`):

| Mã | `code` | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Câu hỏi rỗng, > 2.000 ký tự, scope > 200 |
| 401 / 403 | `UNAUTHENTICATED` / `CSRF_INVALID` | Middleware T01-02 |
| 404 | `CONVERSATION_NOT_FOUND` | Không tồn tại hoặc không phải chủ (INV-02) |
| 409 | `NO_READY_DOCUMENTS` | Không có tài liệu `READY` nào |
| 409 | `CONVERSATION_BUSY` (đề xuất) | Hội thoại đang có câu trả lời `RETRIEVING/STREAMING` |
| 429 | `RATE_LIMITED` | Vượt 10/phút hoặc 60/giờ; header `Retry-After` (giây), `RateLimit-Limit`, `RateLimit-Remaining` |

Thành công: `200`, header `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `X-Request-ID`.

### 4.3 Hợp đồng SSE (SAD §10.3)

Mỗi sự kiện: `event: <tên>\ndata: <JSON một dòng>\n\n`.

| Event | Data | Khi |
|---|---|---|
| `meta` | `{message_id, conversation_id, turn_index, docs_in_scope, docs_processing}` | Ngay sau giao dịch mở lượt (§4.4 bước 4) |
| `delta` | `{text}` | Mỗi `TextDelta` |
| `citation` | `{idx, document_id, document_title, page_start, page_end, cited_text}` | Khi khối văn bản có trích dẫn kết thúc; **phát cho mỗi lần xuất hiện**, `idx` lặp lại nếu cùng nguồn |
| `done` | `{answer_type, status: "COMPLETED", first_token_ms, total_ms, citation_count}` | Kết thúc thành công (`first_token_ms = null` khi `not_found` từ cổng) |
| `error` | `{code: "service_unavailable"\|"timeout"\|"refused"\|"internal", retryable}` | Kết thúc lỗi |
| `: ping` | — | Sau 15 s không có sự kiện nào |

- Thứ tự đảm bảo: `meta` luôn đầu tiên; đúng một `done` **hoặc** một `error` ở cuối; `citation` của một khối đến sau mọi `delta` của khối đó → FE đặt chip tại vị trí cuối văn bản hiện có.
- `citation_count` = số `idx` phân biệt. `cited_text` cắt tối đa 500 ký tự (đề xuất).
- Nginx đã cấu hình `proxy_buffering off; proxy_read_timeout 120s` (T00-07).

### 4.4 Luồng `AskQuestion`

```text
t0 = monotonic()
1. [middleware] phiên, CSRF, rate limit bucket "question" → có thể 429
2. Validate body
3. TX#1 (READ COMMITTED):
   conv = repo.lock_owned(id, user)              → None ⇒ 404
   nếu có message assistant status ∈ {RETRIEVING, STREAMING} ⇒ 409 CONVERSATION_BUSY
   counts = documents.count_by_status()           → ready = 0 ⇒ 409 NO_READY_DOCUMENTS
   turn = repo.next_turn_index(id)
   repo.add_user_message(turn, text=question)
   msg = repo.add_assistant_placeholder(turn, status=RETRIEVING, prompt_version,
             usage={"docs_in_scope": counts.ready, "docs_processing": counts.queued + counts.processing})
             # (đề xuất) để T03-03 hiển thị lại khi mở hội thoại
   repo.touch(id, title_if_empty=question[:80])
   analytics.record(EV-08 question_submitted …)   # cùng giao dịch
   COMMIT
4. → SSE meta {message_id, conversation_id, turn_index: turn,
               docs_in_scope: counts.ready, docs_processing: counts.queued + counts.processing}
5. result = retrieve.execute(question, scope_ids=None)       # T02-02
      RetrievalUnavailableError ⇒ error(service_unavailable, retryable=true)
6. decision = gate.evaluate(result)                           # S2: EmptyPassagesGate
      not_found ⇒ TX#2 lưu COMPLETED/not_found, text = câu cố định, EV-09 ⇒ done
7. async with slots.acquire(timeout=5 s)                      # semaphore 15
      hết chờ ⇒ error(service_unavailable, retryable=true)
8. async for ev in llm.stream_answer(AnswerRequest(...)):    # T02-03
      TextDelta      ⇒ (lần đầu: first_token_ms = now - t0; status STREAMING) → SSE delta
      CitationFound  ⇒ idx = numbering.assign(ref) → segments.cite(idx) → SSE citation
      BlockEnded     ⇒ segments.close_block()
      Completed      ⇒ giữ lại
9. answer_type = decide_answer_type(text, citation_count, stop_reason)   # INV-04
10. TX#2: repo.complete_assistant_message(...) + citations + EV-09 ⇒ COMMIT
11. → SSE done
```

- `t0` lấy khi handler bắt đầu (sau middleware) để `first_token_ms` gần với cảm nhận người dùng; FE đo thêm phía client ([T02-10](T02-10-golden-set-runner.md) báo cáo cả hai).
- `status` cập nhật `STREAMING` trong CSDL: không ghi ở mỗi delta; chỉ ghi khi kết thúc (đề xuất, giảm ghi). Placeholder `RETRIEVING` bị bỏ dở (tiến trình chết) được dọn bởi job dọn dẹp (§10 OQ).

### 4.5 Đánh số trích dẫn, segments, INV-04 (miền, thuần)

- `CitationNumbering.assign(ref) -> int`: khoá `(document_id, page_start, page_end)`; khoá mới → `idx` kế tiếp bắt đầu từ 1; khoá cũ → `idx` cũ. Lưu `cited_text` của lần đầu.
- `SegmentBuilder`: mỗi khối text LLM → một segment `{text, cites: [idx…]}` (giữ thứ tự, bỏ trùng trong segment). Kết quả lưu `conv.messages.segments`; `text` = nối các segment.
- `decide_answer_type(text, citation_count, stop_reason)`:
  - `text.strip() == ""` → lỗi `internal` (không lưu `answered`).
  - `citation_count ≥ 1` → `answered`; `stop_reason == "max_tokens"` → `partial` (đề xuất, T02-03 OQ-3).
  - `citation_count == 0` → `partial` (**INV-04**, AC-US010-4). Lưu ý S2: câu cố định "Không tìm thấy…" do LLM trả cũng thành `partial` cho tới khi T03-02 thêm nhận diện.
- `citation_count` cho EV-09 = số `idx`; `distinct_docs_cited` = số `document_id` phân biệt.

### 4.6 Lỗi, dừng, ngắt kết nối

| Tình huống | SSE | `status` lưu | EV |
|---|---|---|---|
| `LLMTimeoutError` (không ký tự đầu 30 s) | `error{timeout, retryable: true}` | `FAILED` | EV-10 `timeout` |
| `LLMUnavailableError`, hết chờ semaphore, `RetrievalUnavailableError` | `error{service_unavailable, retryable: true}` | `FAILED` | EV-10 `service_unavailable` |
| `LLMRefusedError` | `error{refused, retryable: false}` | `FAILED`, ghi `stop_details.category` vào `usage` | EV-10 `other` (PRD chưa có `refused` — §10) |
| Lỗi khác (CSDL, bug) | `error{internal, retryable: true}` | `FAILED` | EV-10 `other` |
| Client ngắt (nút Dừng, mất mạng) | — (không gửi được) | `STOPPED`, lưu văn bản + citation đã nhận, `answer_type = NULL` | Không ghi EV-10/EV-11 phía server |

- Phát hiện ngắt: Starlette huỷ generator (`asyncio.CancelledError`) khi ghi thất bại, kèm kiểm `await request.is_disconnected()` mỗi lần chờ ping. Trong `finally`: đóng stream LLM (thoát `async with` của adapter), trả slot semaphore, ghi TX#2 bằng `asyncio.shield(...)`.
- Phần đã lưu khi `FAILED` giữ nguyên văn bản đã nhận (Blueprint §3.7.1), trừ `refused` (xem T02-03 OQ-2).
- Mọi `error` sau khi đã mở stream đều HTTP 200; không bao giờ gửi stack trace.

### 4.7 Semaphore 15 lời gọi Claude (toàn hệ thống)

- Hai replica API → semaphore phân tán trong Valkey (đề xuất): ZSET `sem:llm` chứa `lease_id → expire_ts`; `acquire` = Lua script xoá lease hết hạn, `ZCARD < 15` thì `ZADD`; lease 130 s (> tổng 120 s), gia hạn không cần vì timeout tổng 120 s; `release` = `ZREM`. Chờ tối đa 5 s, poll 100 ms.
- Port: `LLMSlotLimiter.acquire(timeout_s: float) -> AsyncContextManager[None]`; `InMemorySlotLimiter` cho test.
- Giới hạn cấu hình `CWD_LLM_MAX_CONCURRENCY=15` (OQ-031).

### 4.8 Sự kiện server-side (qua `AnalyticsRecorder` của T01-10)

| EV | Thời điểm | `props` |
|---|---|---|
| EV-08 `question_submitted` | TX#1 | `conversation_id`, `turn_index`, `question_length`, `language` (S2: có ký tự dấu tiếng Việt → `vi`, chữ Latin không dấu ≥ 70% từ tiếng Anh thông dụng → `en`, còn lại `vi` — heuristic tạm, T04-05 thay), `scope_type: "all"`, `docs_in_scope` |
| EV-09 `answer_completed` | TX#2 khi `COMPLETED` | `conversation_id`, `turn_index`, `answer_type`, `first_token_ms`, `total_ms`, `citation_count`, `distinct_docs_cited` |
| EV-10 `answer_failed` | Ghi riêng một giao dịch khi lỗi | `error_type` ∈ `timeout`, `service_unavailable`, `other`; `elapsed_ms` |

Không có nội dung câu hỏi/câu trả lời trong `props` (PRD §6.2). `user_id`, `session_id` lấy từ phiên.

## 5. Các bước thực hiện

- [ ] Viết `citation_numbering.py` (numbering, segments, `decide_answer_type`) + unit test.
- [ ] Viết `NotFoundGate` Protocol (`evaluate(result: RetrievalResult) -> GateDecision`) và `EmptyPassagesGate` (not_found khi `passages` rỗng).
- [ ] Viết `LLMSlotLimiter` + `ValkeyLLMSemaphore` + `InMemorySlotLimiter`.
- [ ] Viết `AskQuestion` theo §4.4 dưới dạng async generator phát sự kiện ứng dụng (độc lập HTTP).
- [ ] Viết `sse.py`: mã hoá, chèn ping 15 s, phát hiện ngắt.
- [ ] Viết router, cấu hình bucket rate limit `question` (10/60 s và 60/3.600 s), đăng ký vào ma trận IDOR (T02-01).
- [ ] Nối DI: chọn `ClaudeLLMAdapter` hoặc `FakeLLMAdapter` theo `CWD_LLM_ADAPTER`.
- [ ] Test hợp đồng SSE, test tích hợp đầu-cuối với Fake, test IDOR, test ngắt kết nối.
- [ ] Demo trên staging với Claude thật (exit criteria M2).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US010-4:** câu trả lời có nội dung nhưng không có citation (`[fake:no_citation]`) được lưu `answer_type = partial`, `done.answer_type = "partial"`, EV-09 `answer_type = partial` (INV-04); cảnh báo hiển thị ở [T02-07](T02-07-fe-answer-citations.md).
- [ ] Hợp đồng SSE §4.3 đúng 100% trong test hợp đồng: `meta` đầu, đúng một `done`/`error` cuối, `citation` sau `delta` của khối, ping sau 15 s im lặng (`[fake:slow]`).
- [ ] 429 trả trước khi mở stream, có `Retry-After` chính xác (phục vụ thông báo AC-US008-6 ở T02-06).
- [ ] Không có ký tự đầu sau 30 s → `error{timeout}` và message `FAILED` (phục vụ AC-US008-9 ở T02-06).
- [ ] Client ngắt giữa stream → message `STOPPED` có văn bản đã nhận; stream Claude đóng (không còn token tính phí — kiểm qua span).
- [ ] `meta.docs_processing` đúng số tài liệu `QUEUED` + `PROCESSING` (dữ liệu cho AC-US008-8 ở T03-03).
- [ ] Không có tài liệu `READY` → 409 `NO_READY_DOCUMENTS`.
- [ ] Người dùng B gửi câu hỏi vào hội thoại của A → 404 (route có trong test IDOR tự sinh).
- [ ] Message, citations, usage, EV-09 ghi trong **một** giao dịch (test: lỗi giả khi chèn citation → không có EV-09, message vẫn `RETRIEVING` → được đánh dấu `FAILED`).
- [ ] EV-08, EV-09, EV-10 xuất hiện trong `ops.analytics_events` trên staging, `props` không chứa văn bản.
- [ ] Demo J1 trên staging với Claude thật; log mẫu không chứa nội dung câu hỏi/câu trả lời.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | Numbering: 2 citation cùng trang → cùng `idx`; khác trang → khác `idx`; segments; `decide_answer_type` mọi nhánh |
| Hợp đồng SSE | Parse toàn bộ stream (bộ parser giống FE) cho các kịch bản Fake: mặc định, `two_pages`, `multi_doc`, `no_citation`, `not_found` (passages rỗng), `timeout`, `unavailable`, `refusal`, `slow` |
| Integration (Testcontainers + Fake + TEI giả) | J1 đầy đủ: tạo hội thoại → hỏi → `GET /conversations/{id}` trả message có `segments`, `citations`, `prompt_version` |
| Đồng thời | Hai request cùng hội thoại → một 200, một 409 `CONVERSATION_BUSY`; 16 request song song với giới hạn 15 → request thứ 16 chờ hoặc `service_unavailable` sau 5 s |
| Ngắt kết nối | Client đóng sau `delta` thứ 3 → `STOPPED`, có 3 delta trong `text` |
| Rate limit | 11 câu trong 60 s → câu 11 nhận 429 với `Retry-After` > 0 |
| Bảo mật | IDOR; CSRF thiếu → 403; log không chứa câu hỏi (kiểm caplog) |
| E2E (Playwright, T02-06) | J1 với Fake trên CI, Claude thật trên staging |

## 8. Analytics / observability

- EV-08, EV-09, EV-10 theo §4.8.
- Trace: `http.request` → `qa.ask` (thuộc tính `turn_index`, `docs_in_scope`, `answer_type`, `status`) → `qa.retrieve` (T02-02) → `qa.gate` → `llm.slot_wait` → `llm.stream` (T02-03) → `db.persist`.
- Metric: `cwd_answer_total_seconds`, `cwd_answer_type_total{type}`, `cwd_answer_failed_total{code}`, `cwd_llm_slots_in_use`, `cwd_llm_slot_wait_seconds`.
- Log một dòng kết thúc mỗi câu hỏi: `message_id`, `status`, `answer_type`, `first_token_ms`, `total_ms`, `citation_count`, `error_code` — không có nội dung.

## 9. Tham chiếu

- [SAD.md](../../requirements/SAD.md) §4.2 (pipeline 11 bước), §5 INV-02/INV-03/INV-04, §8.1, §9.2, §10.2, §10.3, §11.2 (rate limit, semaphore), §11.3, ADR-002, ADR-005, ADR-006, ADR-008
- [USER_STORIES.md — US-008, US-010](../../requirements/USER_STORIES.md)
- [PRD.md](../../requirements/PRD.md) §6.2 EV-08..EV-10, §5.2 EC-03, EC-05, EC-07
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) S2 WP-21, WP-22

## 10. Giả định và câu hỏi mở

- Giả định middleware rate limit của T01-02 hỗ trợ nhiều bucket theo route và trả `Retry-After`.
- Giả định `AnalyticsRecorder` của T01-10 ghi được trong giao dịch của caller (nhận `Session`).
- **OQ-T0205-1:** PRD EV-10 `error_type` (`network | timeout | service_unavailable | other`) không có `refused`; SSE có `refused`, `internal`. Đề xuất bổ sung `refused` vào PRD hoặc giữ ánh xạ `refused → other`. `network` chỉ client biết → EV-10 `network` do FE gửi ([T02-06](T02-06-fe-chat-composer-stream.md)) — cần T01-10 cho phép EV-10 từ client.
- **OQ-T0205-2:** `409 CONVERSATION_BUSY` chưa có trong SAD §10.2 — cần Architect duyệt.
- **OQ-T0205-3:** Placeholder `RETRIEVING/STREAMING` bị bỏ dở khi tiến trình API chết: đề xuất `retention_sweep` (T06-06) chuyển sang `FAILED` sau 10 phút; trước S6 dọn khi khởi động replica.
- **OQ-T0205-4:** S2 xử lý câu hỏi tiếp theo trong cùng hội thoại như câu độc lập (không lịch sử). PO chấp nhận cho demo M2?
- **OQ-T0205-5:** Đo `first_token_ms` từ lúc handler nhận request (server) — NFR-001 đo ở đâu (client hay server)? Đề xuất báo cáo cả hai, nghiệm thu theo client.
