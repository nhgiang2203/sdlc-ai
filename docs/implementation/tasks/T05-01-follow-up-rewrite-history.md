# T05-01 — Hỏi tiếp: viết lại câu hỏi, lịch sử append-only, prompt caching

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | US-014 · WP-50 |
| Loại | BE |
| Ước lượng | 4 ngày công |
| Phụ thuộc | [T02-05](T02-05-ask-question-sse.md); liên quan [T02-03](T02-03-claude-llm-adapter.md) (`ClaudeLLMAdapter`), [T02-10](T02-10-golden-set-runner.md) (runner), [T04-05](T04-05-english-language-support.md) (`language`) |
| Chặn | [T05-02](T05-02-fe-new-conversation.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hỗ trợ hỏi tiếp trong một hội thoại: (1) bước 2 pipeline viết lại câu hỏi nối tiếp thành câu độc lập để truy xuất đúng; (2) gửi lịch sử hội thoại tới Claude **nguyên văn, chỉ nối thêm** từ `messages.llm_content` có prompt caching; (3) giới hạn 20 lượt → 409 `CONVERSATION_TOO_LONG`; (4) đo lại độ trễ ký tự đầu cho lượt ≥ 2.

## 2. Bối cảnh

- SAD §4.2 bước 2 (chỉ khi `turn_index > 0`, LLM effort `low`, `max_tokens` 256, 800–1.500 ms), hợp đồng LLM (prompt caching `cache_control: {type: "ephemeral"}` cấp request, kiểm tra `usage.cache_read_input_tokens`; fallbacks khi từ chối); §7.2 `conv.messages.llm_content jsonb` (khối nội dung gửi/nhận nguyên văn); §7.3 (Q2 là một trong hai điểm dữ liệu ra ngoài); §8.1 (`meta` phát trước bước viết lại); PR-07; ADR-005 (lưu `llm_content` đầy đủ kể cả khối suy luận; 20 lượt; không gửi lịch sử đã rút gọn/chỉnh sửa); RSK-008, IR-03.
- Claude Opus 5.5: thinking adaptive luôn bật, không tắt được; khối thinking gắn với model và hội thoại (preserved thinking) — sửa lịch sử cũ làm vô hiệu khối thinking và cache. Tối thiểu cacheable 512 token; TTL mặc định 5 phút; cache read $0,20/MTok.
- T02-05 hiện gửi mỗi lượt độc lập (không lịch sử), luôn toàn kho; T04-03 đã thêm phạm vi.

## 3. Phạm vi

**Trong phạm vi:** `QueryRewriter` + prompt viết lại; `ConversationHistoryBuilder`; ghi `llm_content` (user + assistant) đúng nguyên văn; cấu hình cache; kiểm tra 20 lượt; cột `retrieval_query`; metric/trace; 10 cặp câu hỏi nối tiếp trong golden set + runner đa lượt; đo độ trễ.

**Ngoài phạm vi:** nút "Hội thoại mới", hiển thị đề nghị khi hội thoại dài ([T05-02](T05-02-fe-new-conversation.md)); circuit breaker cho lời gọi viết lại ([T05-07](T05-07-circuit-breaker-degraded.md) bọc chung `LLMPort`); mở lại hội thoại cũ ([T06-06](T06-06-conversation-history-retention.md)).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/ports/llm.py` | Thêm `complete(request: LLMCompleteRequest) -> LLMCompletion` (không stream) cho bước viết lại; `stream(...)` nhận thêm `history: list[LLMTurn]` |
| `backend/cwd/application/qa/query_rewriter.py` | `QueryRewriter.rewrite(question, recent_turns, language) -> RewriteResult(query, used_fallback, latency_ms, usage)` |
| `backend/cwd/application/qa/history_builder.py` | `build_history(messages) -> list[{"role", "content"}]` từ `llm_content` |
| `backend/prompts/rewrite_v1.md` | System prompt viết lại (có `prompt_version`) |
| `backend/cwd/adapters/claude/llm_adapter.py` | Gửi `history + user turn`; trả `llm_content` của user turn đã gửi và `response.content` đã serialize |
| `backend/cwd/application/qa/ask_question.py` | Thêm bước kiểm tra lượt, bước 2, dùng `retrieval_query` cho bước 3–8 |

### 4.2 Giới hạn 20 lượt

- Trước khi mở SSE: `n = COUNT(*) FROM conv.messages WHERE conversation_id = :id AND role = 'user'`. `n ≥ 20` → 409 `CONVERSATION_TOO_LONG` (problem+json, `detail` "Hội thoại đã dài, hãy bắt đầu hội thoại mới để có kết quả tốt nhất", `extensions.max_turns = 20`). Câu hỏi thứ 21 bị từ chối, 20 lượt đầu được phục vụ.
- `MAX_TURNS` cấu hình (`CWD_MAX_TURNS=20`).
- Đua hai request đồng thời: `turn_index` lấy trong giao dịch `SELECT … FOR UPDATE` trên `conv.conversations`; UNIQUE(`conversation_id`, `turn_index`, `role`) là chốt cuối.

### 4.3 Bước 2 — viết lại câu hỏi

- Chỉ chạy khi `turn_index > 0`. Đầu vào: tối đa 3 lượt gần nhất **đã hoàn tất** (đề xuất), mỗi lượt gồm câu hỏi và `text` câu trả lời cắt ≤ 1.000 ký tự (không gửi đoạn trích — PR-02 tối thiểu dữ liệu), cộng câu hỏi hiện tại.
- Gọi `LLMPort.complete`: `model = claude-opus-5-5`, `output_config.effort = "low"`, không stream, không tool, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) như lời gọi trả lời; timeout 5 s (đề xuất).
- System prompt `rewrite_v1`: "Viết lại câu hỏi cuối thành một câu hỏi độc lập, đủ ngữ cảnh (tên dự án, tài liệu, đối tượng được nhắc trước đó), cùng ngôn ngữ với câu hỏi cuối. Nếu câu hỏi đã độc lập, trả lại nguyên văn. Chỉ trả về câu hỏi, không giải thích, không trả lời." — nội dung hội thoại đặt trong thẻ `<conversation>` và được nêu là dữ liệu.
- `max_tokens`: SAD ghi 256. Với Opus 5.5 thinking không tắt được và token suy luận tính vào `max_tokens`, nguy cơ `stop_reason = "max_tokens"` trước khi có chữ. Đề xuất cấu hình `CWD_REWRITE_MAX_TOKENS` mặc định 1.024, đo phân phối `output_tokens` trên 10 cặp golden set rồi chốt (OQ-T0501-01).
- Fallback (không làm hỏng lượt hỏi): lỗi API, timeout, `refusal`, `max_tokens`, kết quả rỗng hoặc > 2.000 ký tự → dùng câu hỏi gốc, `used_fallback = true`, ghi metric.
- Kết quả lưu vào cột mới `conv.messages.retrieval_query text NULL` của message user (dữ liệu hội thoại, cùng retention; không đưa vào log/trace/analytics — PR-06).
- `retrieval_query` dùng cho embedding, toàn văn, rerank và cổng τ_nf. Lời gọi trả lời vẫn dùng **câu hỏi gốc** + lịch sử (mô hình có đủ ngữ cảnh).

### 4.4 Lịch sử append-only (PR-07)

Lưu khi kết thúc lượt (cùng giao dịch ghi message ở bước 11):

| Message | `llm_content` |
|---|---|
| user | Đúng mảng `content` đã gửi ở lượt đó: các `document` block (đoạn trích, `citations.enabled`) + khối `text` câu hỏi gốc |
| assistant | `[block.model_dump(mode="json", exclude_none=True) for block in final_message.content]` — giữ nguyên khối `thinking` (kể cả `signature`), `text` kèm `citations`; không sửa, không lọc |

`build_history` (deterministic):

1. Lấy các lượt theo `turn_index` tăng dần; **chỉ** đưa lượt có assistant `status = COMPLETED` (`answered`, `partial`, `not_found`). Lượt `STOPPED`/`FAILED` bị loại cả cặp user/assistant — quy tắc cố định nên tiền tố các lần sau vẫn ổn định.
2. Lượt `not_found` từ cổng ngưỡng (không gọi LLM): user = `[{"type":"text","text": câu hỏi}]`, assistant = `[{"type":"text","text": NOT_FOUND_TEXT[lang]}]` — được ghi vào `llm_content` lúc tạo, không dựng lại (đề xuất, OQ-T0501-02).
3. Không bao giờ cập nhật `llm_content` sau khi ghi (kiểm tra bằng test + không có code path UPDATE cột này).

Request lượt N: `system = [system prompt cố định, cache_control ephemeral]` (breakpoint tường minh, dùng chung mọi hội thoại cùng `prompt_version`), `messages = history + [user turn mới]`, `cache_control: {"type": "ephemeral"}` cấp request (tự đặt breakpoint ở khối cuối, lượt sau đọc lại toàn bộ tiền tố). Thứ tự khối, JSON và system prompt phải byte-identical giữa các lượt (không chèn thời gian, id request).

Đổi `prompt_version` hoặc model giữa hội thoại → mất cache từ đầu; chấp nhận (hiếm), ghi metric.

### 4.5 Kích thước lịch sử

Mỗi lượt user mang ≤ 8 đoạn (~4.000–5.000 token); 20 lượt có thể > 100k token đầu vào (phần lớn là cache read). Đo `input_tokens + cache_read_input_tokens` theo `turn_index`; chi phí ước tính ở lượt 20 cần báo cáo cho PO (RSK-006, OQ-T0501-03).

## 5. Các bước thực hiện

- [ ] Migration expand: `retrieval_query text NULL` (và `language` nếu T04-05 chưa có).
- [ ] Kiểm tra 20 lượt + test đua đồng thời.
- [ ] `QueryRewriter`, `rewrite_v1.md`, fallback, cấu hình `max_tokens`.
- [ ] Ghi `llm_content` user/assistant; `build_history`; truyền `history` qua `LLMPort`.
- [ ] `FakeLLMAdapter`: hỗ trợ `complete()` và kiểm tra tiền tố lịch sử append-only (assert lượt N là tiền tố của lượt N+1).
- [ ] Test hợp đồng trên staging với Claude thật: 3 lượt, kiểm tra không lỗi 400 khi gửi lại khối thinking/citations, `cache_read_input_tokens > 0` từ lượt 2.
- [ ] Mở rộng runner golden set (T02-10) cho mục đa lượt; thêm 10 cặp câu hỏi nối tiếp (đại từ thay thế, ví dụ AC-US014-1) cùng SME.
- [ ] Đo p50/p90 ký tự đầu cho `turn_index ≥ 1` vs lượt đầu; báo cáo trong PR (RSK-008).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US014-1:** hỏi "Điều khoản thanh toán của dự án X là gì?" rồi "Còn thời hạn bảo hành thì sao?" → `retrieval_query` chứa "dự án X", câu trả lời về bảo hành của dự án X có trích dẫn tài liệu dự án X (E2E staging, PDF mẫu).
- [ ] **AC-US014-3:** 10 cặp nối tiếp trong golden set, tỷ lệ câu thứ hai SME chấm đúng ngữ cảnh ≥ ngưỡng OQ-010 (đề xuất ≥ 80%); phiếu chấm đính kèm.
- [ ] Hỗ trợ AC-US014-4 (nghiệm thu ở T05-02): câu hỏi thứ 21 nhận 409 `CONVERSATION_TOO_LONG` trước khi mở SSE, không ghi message.
- [ ] Hỗ trợ AC-US014-2: hội thoại mới (`turn_index = 0`) không gọi bước viết lại và `history` rỗng (test).
- [ ] `usage.cache_read_input_tokens > 0` ở ≥ 90% lượt `turn_index ≥ 1` cách lượt trước < 5 phút trên staging.
- [ ] p90 ký tự đầu lượt ≥ 2 ≤ 3 s, **hoặc** báo cáo + phương án giảm thiểu được Tech lead/PO chấp thuận (IR-03).
- [ ] Log/trace/analytics không chứa câu hỏi hay `retrieval_query` (kiểm tra mẫu log).

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `build_history`: loại lượt STOPPED/FAILED; lượt not_found cổng ngưỡng; thứ tự; lượt N là tiền tố lượt N+1 (property test); `QueryRewriter` fallback với 5 loại lỗi |
| Integration (`FakeLLMAdapter`, Testcontainers) | 20 lượt OK, lượt 21 → 409; hai request đồng thời lượt 20 → một 200, một 409; `retrieval_query` được dùng cho truy xuất (spy `EmbeddingPort`) |
| Hợp đồng (staging, Claude thật) | Hội thoại 3 lượt: không 400; `cache_read_input_tokens` tăng; khối `thinking` gửi lại không đổi |
| Chất lượng | Golden set đa lượt (10 cặp) + toàn bộ golden set không hồi quy > 3 điểm % |
| Hiệu năng | Script 30 hội thoại × 3 lượt đo `first_token_ms` theo lượt |

## 8. Analytics / observability

- EV-08 `turn_index` (đã có) — xác nhận đúng với lượt ≥ 1.
- Span `qa.rewrite` (thuộc tính `latency_ms`, `used_fallback`, `output_tokens`, `stop_reason`); span `llm.stream` thêm `history_turns`, `cache_read_tokens`, `cache_write_tokens`.
- Metric `cwd_llm_tokens_total{kind="cache_read"|"cache_write"}` (SAD §11.3), `cwd_rewrite_seconds` (histogram), `cwd_rewrite_fallback_total{reason}`, `cwd_conversation_too_long_total` (đề xuất).

## 9. Tham chiếu

SAD §2.3 PR-02/PR-07, §4.2, §7.2, §7.3, §8.1, §12.4, §16.1 RSK-008, ADR-005; USER_STORIES US-014; BRD AC-012; IMPLEMENTATION_PLAN S5 WP-50, IR-03; tài liệu Claude API: prompt caching (auto cache cấp request, tối thiểu 512 token với Opus 5.5, TTL 5 phút / 1 giờ), preserved thinking.

## 10. Giả định và câu hỏi mở

- Giả định: lời gọi trả lời của T02-03 đã có `fallbacks: "default"`, `effort: "low"`, `max_tokens` 4.096.
- **OQ-T0501-01:** `max_tokens` của bước viết lại (SAD: 256) đủ khi thinking không tắt được? Chốt sau đo; đề xuất 1.024.
- **OQ-T0501-02:** Đưa lượt `not_found` (cổng ngưỡng) vào lịch sử dưới dạng văn bản tổng hợp, hay loại bỏ? Đề xuất đưa vào để mô hình biết câu trước không có đáp án.
- **OQ-T0501-03:** Lịch sử nguyên văn kèm đoạn trích của mọi lượt trước làm đầu vào lượt 20 có thể > 100k token, lớn hơn giả định ~5.000 token của SAD §12.4 — PO/Tech lead chấp nhận chi phí hay hạ giới hạn lượt?
- **OQ-T0501-04:** TTL cache 5 phút có đủ khi người dùng đọc trích dẫn lâu hơn 5 phút giữa hai câu? Đề xuất đo khoảng cách giữa các lượt (EV-08) trong 2 tuần pilot rồi quyết `ttl: "1h"`.
