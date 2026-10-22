# T02-03 — `ClaudeLLMAdapter` streaming + citations + `FakeLLMAdapter`

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-008, US-010 · WP-21, WP-22 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T00-05](T00-05-spike-llm-latency.md) |
| Chặn | [T02-05](T02-05-ask-question-sse.md), [T05-07](T05-07-circuit-breaker-degraded.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Triển khai `LLMPort` bằng `ClaudeLLMAdapter` gọi Claude Messages API (`claude-opus-5-5`, streaming) với mỗi đoạn truy xuất là một `document` block `source.type = "content"` (một block con mỗi trang) và `citations.enabled = true`; chuyển stream của SDK thành chuỗi sự kiện miền (văn bản, trích dẫn, kết thúc, lỗi có kiểu). Cung cấp hàm miền ánh xạ `content_block_location` → `(chunk_id, document_id, page_start, page_end)` và `FakeLLMAdapter` xác định cho CI/E2E.

## 2. Bối cảnh

- ADR-005: Claude sau một LLM gateway (port/adapter) để đổi nhà cung cấp chỉ thay adapter (RSK-002, OQ-005).
- ADR-006: dùng citations gốc thay vì để LLM tự viết `[n]`; mỗi block con là một trang nên trích dẫn trỏ đúng trang (AC-US010-2, AC-US010-3).
- Spike [T00-05](T00-05-spike-llm-latency.md) đã xác nhận ánh xạ `content_block_location` → trang và chọn effort (`low` mặc định, OQ-028). Task này đóng gói kết quả spike thành adapter chuẩn.
- Hợp đồng gọi LLM ở SAD §4.2; IF-03 ở §10.4.

## 3. Phạm vi

**Trong phạm vi:**
- `LLMPort.stream_answer(...)`, DTO sự kiện, lỗi có kiểu.
- `ClaudeLLMAdapter` (SDK `anthropic` async, beta fallback, prompt caching tự động, timeout ký tự đầu 30 s).
- Hàm miền `map_citation(...)` và kiểm tra hợp lệ vị trí trích dẫn.
- `FakeLLMAdapter` có kịch bản cấu hình được; bộ contract test chung cho hai adapter.
- Ước tính chi phí từ `usage` (bảng giá trong cấu hình).

**Ngoài phạm vi:**
- Điều phối pipeline, semaphore 15 lời gọi, đánh số `[n]`, ghi CSDL, SSE → [T02-05](T02-05-ask-question-sse.md).
- Nội dung system prompt → [T02-04](T02-04-system-prompt-v1.md) (adapter chỉ nhận `SystemPrompt`).
- Gửi lịch sử hội thoại và bước viết lại câu hỏi (`rewrite_question`, `max_tokens` 256) → [T05-01](T05-01-follow-up-rewrite-history.md). Chữ ký đã có tham số `history` nhưng S2 luôn truyền `[]`.
- Circuit breaker (pybreaker) → [T05-07](T05-07-circuit-breaker-degraded.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `backend/cwd/ports/llm.py` | `LLMPort`, `AnswerRequest`, sự kiện, lỗi |
| `backend/cwd/domain/conversations/citation_mapping.py` | `map_citation`, `CitationRef` |
| `backend/cwd/adapters/claude/llm_adapter.py` | `ClaudeLLMAdapter` |
| `backend/cwd/adapters/claude/request_builder.py` | Dựng `system`, `messages`, document blocks |
| `backend/cwd/adapters/claude/pricing.py` | Ước tính chi phí từ `usage` |
| `backend/cwd/adapters/fake/llm_adapter.py` | `FakeLLMAdapter` |
| `backend/cwd/config/llm.py` | `LLMSettings` (`CWD_LLM_*`) |
| `backend/tests/contract/test_llm_port_contract.py` | Contract test chạy cho cả hai adapter |

### 4.2 Port

```python
@dataclass(frozen=True)
class AnswerRequest:
    question: str
    passages: Sequence[Passage]          # từ T02-02, thứ tự = document_index
    system_prompt: SystemPrompt          # từ T02-04: version, text
    history: Sequence[dict] = ()         # llm_content các lượt trước (T05-01); S2 = ()
    effort: Literal["low", "medium"] = "low"
    max_tokens: int = 4096

# Sự kiện miền phát ra theo thứ tự
@dataclass(frozen=True)
class TextDelta:        text: str; block_index: int
@dataclass(frozen=True)
class CitationFound:    ref: CitationRef; block_index: int     # phát khi khối text chứa nó KẾT THÚC
@dataclass(frozen=True)
class BlockEnded:       block_index: int
@dataclass(frozen=True)
class FallbackStarted:  model: str                             # khi gặp content block "fallback"
@dataclass(frozen=True)
class Completed:
    stop_reason: str                      # end_turn | max_tokens
    model: str                            # model thực sự phục vụ (message_start)
    usage: dict                           # input/output/cache_read/cache_creation tokens, iterations
    cost_usd: float
    llm_content: list[dict]               # content của assistant nguyên văn (kể cả thinking)
    user_content: list[dict]              # khối user đã gửi (documents + câu hỏi) — cho T05-01

LLMEvent = TextDelta | CitationFound | BlockEnded | FallbackStarted | Completed

class LLMError(Exception): ...
class LLMTimeoutError(LLMError): ...        # không có text_delta đầu trong 30 s / tổng > 120 s
class LLMUnavailableError(LLMError): ...    # 429/5xx/kết nối sau retry SDK
class LLMRefusedError(LLMError):            # stop_reason == "refusal"
    category: str | None
class LLMBadResponseError(LLMError): ...    # citation trỏ sai chỉ số, stream cụt

class LLMPort(Protocol):
    def stream_answer(self, req: AnswerRequest) -> AsyncIterator[LLMEvent]: ...
```

Hủy: khi consumer ngừng lặp (client ngắt kết nối), adapter phải đóng stream upstream trong `finally` (thoát `async with`) để dừng sinh token và tính phí.

### 4.3 Dựng request (`request_builder.py`)

Mỗi `Passage` → một document block; thứ tự trong mảng = `document_index`:

```python
{
  "type": "document",
  "source": {"type": "content",
             "content": [{"type": "text", "text": seg.text} for seg in p.page_segments]},
  "title": f"{p.document_title} — tr. {p.page_start}–{p.page_end}",
  "citations": {"enabled": True},
}
```

Lời gọi (SDK `anthropic`, client async dùng chung):

```python
async with client.beta.messages.stream(
    model=settings.model,                       # "claude-opus-5-5"
    max_tokens=req.max_tokens,                  # 4096
    system=req.system_prompt.text,
    messages=[*req.history, {"role": "user", "content": [*document_blocks,
                                                          {"type": "text", "text": req.question}]}],
    output_config={"effort": req.effort},       # "low"
    cache_control={"type": "ephemeral"},        # auto caching cấp request
    betas=["server-side-fallback-2026-07-01"],
    fallbacks="default",
    **({"inference_geo": settings.inference_geo} if settings.inference_geo else {}),
) as stream:
    ...
```

- Không đặt `thinking` (Opus 5.5 luôn adaptive; `disabled` trả 400). Không có `tools` (SAD §11.1: LLM không có tool).
- Không dùng `output_config.format` (không kết hợp được với citations — ADR-006).
- Client: `AsyncAnthropic(max_retries=2, timeout=httpx.Timeout(120.0, connect=10.0))`; API key đọc từ secret file (`CWD_ANTHROPIC_API_KEY_FILE`), không từ biến môi trường hiển thị trong log.
- Giá trị `model`, `effort`, `max_tokens`, `inference_geo`, bật/tắt `fallbacks` là cấu hình.

### 4.4 Chuyển sự kiện stream → sự kiện miền

| Sự kiện SDK | Xử lý |
|---|---|
| `message_start` | Ghi `model` thực tế |
| `content_block_start` type `text` | Mở khối, nhớ `block_index` |
| `content_block_start` type `thinking` | Bỏ qua hiển thị; giữ để đưa vào `llm_content` |
| `content_block_start` type `fallback` | Phát `FallbackStarted(model)`; metric `cwd_llm_fallback_total` |
| `content_block_delta` `text_delta` | Phát `TextDelta`; lần đầu → huỷ đồng hồ 30 s |
| `content_block_delta` `citations_delta` | `map_citation(...)` → lưu tạm theo `block_index` |
| `content_block_stop` (khối text) | Phát lần lượt `CitationFound` của khối, rồi `BlockEnded` |
| `message_stop` | Đọc `stream.get_final_message()`; nếu `stop_reason == "refusal"` → ném `LLMRefusedError(stop_details.category)`; ngược lại phát `Completed` |

- Đồng hồ ký tự đầu: `asyncio.timeout(30)` bao quanh phần chờ `text_delta` đầu tiên (thời gian suy luận adaptive tính vào đây); tổng 120 s (IF-03).
- Lỗi SDK: `anthropic.RateLimitError`, `InternalServerError`, `APIConnectionError`, `APITimeoutError` → `LLMUnavailableError`; `BadRequestError` → `LLMBadResponseError` (log `error.type`, không log body).
- Luôn kiểm `stop_reason` trước khi coi nội dung là hoàn chỉnh. `max_tokens` → vẫn `Completed` (T02-05 quyết định cách hiển thị).

### 4.5 Ánh xạ trích dẫn (miền, thuần)

```python
@dataclass(frozen=True)
class CitationRef:
    chunk_id: UUID; document_id: UUID; document_title: str
    page_start: int; page_end: int; cited_text: str

def map_citation(passages: Sequence[Passage], c: Mapping[str, Any]) -> CitationRef:
    """c.type == "content_block_location": document_index, start_block_index, end_block_index (exclusive), cited_text."""
```

- `p = passages[document_index]`; trang = `p.page_segments[start_block_index].page_no` … `p.page_segments[end_block_index - 1].page_no`.
- Chỉ số ngoài phạm vi, `end ≤ start`, hoặc `type` khác `content_block_location` → `LLMBadResponseError` cho citation đó: **bỏ citation, không bỏ câu trả lời**, tăng `cwd_llm_citation_invalid_total` (đề xuất).
- Ngữ nghĩa `end_block_index` (exclusive) theo tài liệu API — spike T00-05 phải xác nhận lại; test unit khoá hành vi.

### 4.6 `FakeLLMAdapter`

- Bật bằng `CWD_LLM_ADAPTER=fake` (chỉ dev/CI/staging-e2e; khởi động thất bại nếu `CWD_ENV=prod`).
- Mặc định: với 2 đoạn đầu, phát 2 khối văn bản tiếng Việt mỗi khối trích 1 đoạn (`cited_text` = 80 ký tự đầu của trang đầu), độ trễ `CWD_FAKE_LLM_FIRST_TOKEN_MS` (300) và `CWD_FAKE_LLM_TOKEN_DELAY_MS` (20) giữa các delta.
- Kịch bản theo tiền tố câu hỏi (chỉ khi fake): `[fake:no_citation]` (INV-04), `[fake:not_found]` (trả câu cố định), `[fake:timeout]`, `[fake:unavailable]`, `[fake:refusal]`, `[fake:slow]` (40 s, để test Dừng/ping), `[fake:two_pages]` (trích dẫn 2 trang liên tiếp), `[fake:multi_doc]`.

### 4.7 Chi phí

`cost_usd = Σ tokens × đơn giá` theo bảng cấu hình (`CWD_LLM_PRICE_*`): input 4,00 USD/MTok, output 20,00 USD/MTok, cache read 0,20 USD/MTok, cache write theo bảng giá hiện hành (đề xuất 1,25 × input). Khi có `usage.iterations` (fallback) cộng từng lượt theo giá model tương ứng.

## 5. Các bước thực hiện

- [ ] Chuyển code spike T00-05 thành `request_builder.py` + test snapshot JSON request (không gọi mạng).
- [ ] Định nghĩa `ports/llm.py`.
- [ ] Viết `map_citation` + test đơn vị (1 trang, 2 trang liên tiếp, chỉ số sai).
- [ ] Viết `ClaudeLLMAdapter` với bảng chuyển §4.4, đồng hồ 30 s, đóng stream khi huỷ.
- [ ] Viết `FakeLLMAdapter` + các kịch bản.
- [ ] Viết contract test chung; chạy với Fake trong CI, với Claude thật bằng marker `@pytest.mark.live` (job nightly trên staging, key staging).
- [ ] Ghi `docs` ngắn trong docstring về cấu hình `CWD_LLM_*`.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US010-2:** với PDF mẫu, mỗi citation ánh xạ về đúng `(document_id, page_start, page_end)` chứa `cited_text` — kiểm tự động bằng contract test live (≥ 20 câu golden set v0: `cited_text` xuất hiện trong văn bản trang tương ứng ở ≥ 95% citation); tỷ lệ đạt chính thức do SME chấm ở [T03-01](T03-01-golden-set-v1-scoring.md).
- [ ] Nội dung trải 2 trang liên tiếp trả `page_start=12, page_end=13` (dữ liệu cho AC-US010-3, hiển thị ở T02-07).
- [ ] Không có `text_delta` trong 30 s → `LLMTimeoutError` (test với fake server httpx `MockTransport`).
- [ ] `stop_reason == "refusal"` → `LLMRefusedError(category)`, không phát `Completed`.
- [ ] Client ngắt → stream upstream đóng trong ≤ 1 s (test: consumer `aclose()` giữa chừng, transport ghi nhận đóng kết nối).
- [ ] Request gửi đi chỉ gồm system prompt, câu hỏi, ≤ 8 document block (PR-02) — test snapshot.
- [ ] Contract test xanh cho cả `FakeLLMAdapter` và `ClaudeLLMAdapter` (live).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `map_citation` các trường hợp biên; dựng request: title, số block con = số trang, `citations.enabled` ở mọi document; chi phí với/không có `iterations` |
| Unit (stream giả) | Chuỗi sự kiện SDK ghi sẵn (fixture JSON từ spike) → đúng chuỗi `TextDelta`/`CitationFound`/`BlockEnded`/`Completed`; khối `fallback` giữa stream giữ phần đã nhận và phát `FallbackStarted` |
| Unit (lỗi) | 429 sau retry → `LLMUnavailableError`; 400 → `LLMBadResponseError`; timeout |
| Contract | Cùng bộ kiểm cho Fake và Claude: thứ tự sự kiện, citation chỉ phát sau text của khối, `Completed` cuối cùng |
| Live (nightly, staging) | 20 câu golden set v0; ghi `first_token_ms`, `usage.cache_read_input_tokens` |

## 8. Analytics / observability

- Span `llm.stream`: `model`, `effort`, `first_token_ms`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `stop_reason`, `fallback_used`, `stop_details.category` (khi refusal). **Không** gắn câu hỏi, đoạn trích, câu trả lời.
- Metric (khai báo; dashboard ở T06-04): `cwd_llm_first_token_seconds`, `cwd_llm_tokens_total{kind}`, `cwd_llm_cost_usd_total`, `cwd_llm_errors_total{type}`, `cwd_llm_fallback_total`, `cwd_llm_citation_invalid_total`.
- Sự kiện EV-08/09/10 do T02-05 ghi.

## 9. Tham chiếu

- [SAD.md](../../requirements/SAD.md) §4.2 (hợp đồng gọi LLM), §7.3 (dữ liệu ra ngoài), §10.4 (IF-03, ánh xạ trích dẫn), §11.1, §11.2, ADR-005, ADR-006
- [USER_STORIES.md — US-008, US-010](../../requirements/USER_STORIES.md)
- Kết quả spike [T00-05](T00-05-spike-llm-latency.md)
- Tài liệu Claude API: citations (custom content documents), streaming, `output_config.effort`, refusals & fallback, prompt caching

## 10. Giả định và câu hỏi mở

- Giả định OQ-005/OQ-029 cho phép gọi `api.anthropic.com` (hoặc nền tảng cloud được duyệt) cho staging; nếu đổi nền tảng (Bedrock/Vertex), `fallbacks` phía server không có → dùng middleware phía client của SDK, chỉ đổi adapter.
- Giả định system prompt + 8 đoạn ngắn hơn ngưỡng prefix tối thiểu để cache ở lượt đầu; lợi ích cache chỉ rõ từ lượt thứ hai (T05-01).
- **OQ-T0203-1:** Bật `fallbacks: "default"` nghĩa là khi bị từ chối, dữ liệu được gửi tới một model Claude khác của cùng nhà cung cấp. Bảo mật thông tin cần xác nhận phạm vi phê duyệt OQ-005 bao gồm việc này.
- **OQ-T0203-2:** Khi refusal xảy ra giữa stream, tài liệu API khuyên bỏ phần đã nhận. Đề xuất T02-05/T02-06 ẩn phần đã hiển thị với mã `refused` — khác Blueprint §3.7.1 ("Failed: phần đã nhận nếu có"). Cần UX chốt.
- **OQ-T0203-3:** `stop_reason == "max_tokens"` (câu trả lời bị cắt ở 4.096 token): hiển thị như `answered` kèm ghi chú "Câu trả lời bị cắt ngắn" hay coi là `partial`? Đề xuất `partial`.
