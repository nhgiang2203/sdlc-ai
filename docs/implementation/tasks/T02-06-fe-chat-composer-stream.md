# T02-06 — FE: ô hỏi, đọc SSE, khung hội thoại, Dừng, lỗi

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-008 (+ AC-US018-1) · WP-21 |
| Loại | FE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T01-03](T01-03-fe-auth-api-client.md) (hợp đồng SSE từ [T02-05](T02-05-ask-question-sse.md), làm song song bằng MSW) |
| Chặn | [T02-07](T02-07-fe-answer-citations.md), [T05-02](T05-02-fe-new-conversation.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Xây vùng hội thoại của màn hình chính: `QuestionComposer` (Enter gửi, Shift+Enter xuống dòng, đếm 2.000 ký tự, vô hiệu khi trống/chưa có tài liệu sẵn sàng/offline/rate limit), bộ đọc SSE `fetch` + `ReadableStream` trong `lib/api`, máy trạng thái câu trả lời (Blueprint §3.7.1), `ChatThread` tự cuộn, nút "Dừng" bằng `AbortController`, xử lý lỗi + "Thử lại" không mất câu hỏi, route `/c/:conversationId` với trạng thái "Không tìm thấy hội thoại".

## 2. Bối cảnh

- Prototype: [workspace.html](../../design/UI_UX_design/workspace.html), [workspace.js](../../design/UI_UX_design/assets/workspace.js) (hàm `renderComposer`, `ask`, `stopStreaming`, `renderMessage`), lớp CSS `.composer`, `.send-btn.is-stop`, `.thread`, `.msg-user`, `.msg-answer`, `.answer-status`, `.skeleton`, `.cursor` trong [components.css](../../design/UI_UX_design/assets/components.css).
- Blueprint §3.1.2 (`features/chat`, `lib/api` SSE reader), §3.6.2 (props/states `QuestionComposer`, `ChatThread`, `AnswerMessage`), §3.7.1, §3.7.4, §3.8 (≤ 1 cập nhật DOM / 50 ms), UXD-04.
- T01-03 đã có API client (cookie, CSRF, problem+json), guard và lưu bản nháp `sessionStorage` khi hết phiên (AC-US001-4).
- Hợp đồng SSE: SAD §10.3 / [T02-05](T02-05-ask-question-sse.md) §4.3.

## 3. Phạm vi

**Trong phạm vi:**
- `lib/api/sse.ts` (parser SSE), `features/chat/api.ts`, store/hook máy trạng thái câu trả lời.
- `QuestionComposer`, `ChatThread`, khung `AnswerMessage` cho trạng thái Submitting/Retrieving/Streaming (văn bản thuần)/Stopped/Failed.
- Route `/` và `/c/:conversationId`; tạo hội thoại khi gửi câu đầu; nạp lại hội thoại theo URL.
- Banner offline (EC-06), rate limit đếm ngược, empty state hội thoại có gợi ý câu hỏi (UXD-12).
- EV-11 `answer_stopped`, EV-10 `answer_failed` với `error_type = network` (phía client).
- MSW handler giả lập SSE cho dev/test.

**Ngoài phạm vi:**
- Markdown, chip `[n]`, `SourceList`, cảnh báo `partial` → [T02-07](T02-07-fe-answer-citations.md).
- Khối "Không tìm thấy" và ghi chú "N tài liệu đang xử lý" → [T03-03](T03-03-fe-not-found-processing-note.md) (S2 hiển thị tạm `not_found` bằng văn bản thuần).
- Thanh phạm vi / chọn tài liệu → [T04-04](T04-04-fe-scope-selection.md).
- Nút "Hội thoại mới", cảnh báo hội thoại dài, EV-15 → [T05-02](T05-02-fe-new-conversation.md).
- Danh sách lịch sử → [T06-06](T06-06-conversation-history-retention.md). Đánh giá 👍/👎 → [T06-03](T06-03-answer-feedback.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/lib/api/sse.ts` | `streamSSE(url, init, onEvent): Promise<SSEEnd>` |
| `frontend/src/lib/api/queries/documents.ts` | `useDocumentCounts()` dùng chung query key `documents` (đề xuất, để `chat` không import `documents`) |
| `frontend/src/features/chat/api.ts` | `createConversation`, `getConversation`, `askQuestion` |
| `frontend/src/features/chat/model/answerMachine.ts` | Reducer máy trạng thái + `MessageVM` |
| `frontend/src/features/chat/model/useAskQuestion.ts` | Hook điều phối gửi/dừng/thử lại |
| `frontend/src/features/chat/components/QuestionComposer.tsx` | Ô hỏi |
| `frontend/src/features/chat/components/ChatThread.tsx` | Danh sách lượt, tự cuộn |
| `frontend/src/features/chat/components/AnswerMessage.tsx` | Khung trạng thái (T02-07 mở rộng phần nội dung) |
| `frontend/src/features/chat/ChatPage.tsx` | Trang `/`, `/c/:conversationId` |
| `frontend/src/lib/api/mocks/sse.ts` | MSW: phát SSE theo kịch bản |

### 4.2 Bộ đọc SSE (`lib/api/sse.ts`)

```ts
export type SSEEvent =
  | { type: "meta"; data: { message_id: string; conversation_id: string; turn_index: number;
                            docs_in_scope: number; docs_processing: number } }
  | { type: "delta"; data: { text: string } }
  | { type: "citation"; data: CitationDTO }
  | { type: "done"; data: { answer_type: AnswerType; status: "COMPLETED"; first_token_ms: number | null;
                            total_ms: number; citation_count: number } }
  | { type: "error"; data: { code: "service_unavailable" | "timeout" | "refused" | "internal"; retryable: boolean } };

export type SSEEnd = "terminal" | "eof";   // "eof" = stream đóng mà không có done/error ⇒ coi như mất kết nối

export function streamSSE(url: string, init: { body: unknown; signal: AbortSignal },
                          onEvent: (e: SSEEvent) => void): Promise<SSEEnd>;
```

- `fetch(url, {method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json", "Accept": "text/event-stream", "X-CSRF-Token": csrf}, body, signal})`.
- Không 2xx → đọc problem+json → ném `ApiError {status, code, retryAfterSec}` (dùng lớp lỗi của T01-03; 401 đi qua luồng hết phiên của T01-03).
- Parser: `TextDecoderStream`, tách theo dòng (`\n`, `\r\n`), gom `data:` nhiều dòng, `event:` mặc định `message`, bỏ dòng bắt đầu bằng `:` (ping), sự kiện lạ bỏ qua (tương thích tiến). JSON lỗi → `ApiError("internal")`.
- Watchdog phía client (đề xuất): không nhận `meta` trong 10 s hoặc không nhận byte nào (kể cả ping) trong 35 s → `abort()` và coi là `timeout`.

### 4.3 Máy trạng thái câu trả lời (Blueprint §3.7.1)

`submitting → retrieving (meta) → streaming (delta đầu) → answered | partial (done)`; `retrieving → not_found (done)`; `streaming → stopped (Dừng)`; `* → failed (error | HTTP lỗi | eof | watchdog)`; `failed → submitting (Thử lại)`.

```ts
interface MessageVM {
  localId: string; serverId?: string; turnIndex?: number;
  state: "submitting" | "retrieving" | "streaming" | "answered" | "partial" | "not_found" | "stopped" | "failed";
  text: string;                       // T02-07 thay bằng segments + citations
  docsInScope?: number; docsProcessing?: number;
  failure?: { kind: "network" | "timeout" | "busy" | "refused" | "internal"; requestId?: string };
  startedAt: number;
}
```

- Gộp `delta` vào bộ đệm, flush theo `requestAnimationFrame` và tối thiểu 50 ms/lần (Blueprint §3.8).
- Chỉ một câu trả lời được stream mỗi lúc; khi đang stream nút Gửi thành "Dừng" (UX-02).

### 4.4 `QuestionComposer` (Blueprint §3.7.4)

| Trạng thái | Điều kiện | Hiển thị |
|---|---|---|
| Disabled | 0 tài liệu, hoặc 0 `READY` nhưng có `QUEUED/PROCESSING` | Placeholder "Thêm tài liệu để bắt đầu hỏi" / "Tài liệu đang được xử lý, vui lòng chờ"; nút Gửi vô hiệu (EC-01, EC-02) |
| Empty | Ô trống hoặc chỉ khoảng trắng | Nút Gửi `disabled`, Enter không gửi (EC-12) |
| NearLimit | ≥ 1.800 ký tự | Bộ đếm "1.850 / 2.000" (định dạng `vi-VN`) |
| OverLimit | > 2.000 | Viền đỏ, "Câu hỏi tối đa 2.000 ký tự (2.105 / 2.000)", nút Gửi vô hiệu, `aria-invalid="true"` (EC-13) |
| Streaming | Đang stream | Nút "Dừng" (`aria-label="Dừng tạo câu trả lời"`), gợi ý "Đang trả lời… Nhấn nút vuông để dừng." |
| RateLimited | 429 | "Bạn đang hỏi quá nhanh, vui lòng thử lại sau X giây" đếm ngược từ `Retry-After`; câu hỏi giữ trong ô |
| Offline | `navigator.onLine === false` | Banner "Mất kết nối. Câu hỏi của bạn vẫn được giữ lại."; nút Gửi vô hiệu (EC-06) |

- Đếm độ dài bằng `[...value.normalize("NFC")].length` để khớp server.
- Không chặn gõ quá 2.000 (prototype `maxlength=2400`) để người dùng thấy và tự rút gọn.
- `textarea` tự giãn tới 168 px; Enter gửi trừ khi `e.isComposing` (bộ gõ tiếng Việt Telex/VNI) hoặc Shift.
- Bản nháp: đồng bộ `sessionStorage` khoá `cwd.draft.<conversationId|new>` (dùng `useDraft` của T01-03); xoá khi gửi thành công (nhận `meta`), khôi phục vào ô khi gửi thất bại.
- Focus sẵn vào ô khi mở màn hình (UX-01).

### 4.5 Gửi, dừng, thử lại

1. Chưa có `conversationId` → `POST /api/v1/conversations` → `navigate("/c/{id}", {replace: true})`.
2. Thêm bubble câu hỏi + `MessageVM(submitting)`; gọi `streamSSE(.../messages, {question})`.
3. Dừng: `controller.abort()` → `state = stopped`, giữ văn bản, nhãn "Đã dừng" (badge `.tag-stopped`), phát EV-11 `{elapsed_ms}`.
4. Lỗi — thông điệp (UX writing Blueprint §3.6.4):

| Nguồn | `failure.kind` | Thông điệp |
|---|---|---|
| `error.service_unavailable` / `error.timeout` / watchdog | `busy` / `timeout` | "Hệ thống đang bận, vui lòng thử lại sau ít phút." + [Thử lại] (EC-07) |
| `fetch` reject, `eof` không do Dừng | `network` | "Câu trả lời chưa hoàn chỉnh do mất kết nối." + [Thử lại] (EC-05) |
| `error.refused` | `refused` | "Không thể trả lời câu hỏi này. Hãy diễn đạt lại câu hỏi." (đề xuất); ẩn phần đã nhận (T02-03 OQ-2) |
| `error.internal`, HTTP 5xx | `internal` | "Đã có lỗi khi tạo câu trả lời." + "Mã tham chiếu: {X-Request-ID}" + [Thử lại] |
| HTTP 409 `NO_READY_DOCUMENTS` | — | Toast + chuyển composer sang Disabled, câu hỏi giữ trong ô |
| HTTP 404 `CONVERSATION_NOT_FOUND` | — | Trạng thái trang "Không tìm thấy hội thoại" |

- Phần đã nhận được giữ (trừ `refused`); câu hỏi không mất: "Thử lại" gửi lại đúng câu hỏi thành **lượt mới**, bubble lỗi cũ được thay bằng lượt mới (đề xuất, như prototype).
- EV-10 phía client chỉ khi `kind = network` (`error_type: "network"`, `elapsed_ms`) — các lỗi khác server đã ghi (T02-05 OQ-1).

### 4.6 Route `/c/:conversationId`

- Nạp `GET /api/v1/conversations/{id}` (TanStack Query key `["conversation", id]`); hiển thị các lượt đã có (T02-07 hiển thị citations).
- 404 → `EmptyState` tiêu đề "Không tìm thấy hội thoại", thân "Hội thoại không tồn tại hoặc bạn không có quyền xem.", nút "Bắt đầu hội thoại mới" → `/`. Không hiển thị bất kỳ dữ liệu nào từ response (EC-21).

### 4.7 Accessibility

- Vùng `aria-live="polite"` (ẩn) thông báo: "Đang tìm trong N tài liệu", "Đã có câu trả lời", "Đã dừng tạo câu trả lời", lỗi; không đọc từng delta.
- `ChatThread` chỉ tự cuộn khi người dùng đang ở gần đáy (≤ 160 px), như prototype.
- Nút Gửi/Dừng có `aria-label` đổi theo trạng thái; axe-core không lỗi nghiêm trọng.

## 5. Các bước thực hiện

- [ ] Viết `lib/api/sse.ts` + test parser (chia chunk ngẫu nhiên, CRLF, ping, nhiều dòng `data`).
- [ ] Viết MSW handler phát SSE theo kịch bản (`default`, `slow`, `error_timeout`, `error_busy`, `eof`, `rate_limited`, `no_ready`, `not_found_conv`) từ fixture [mock-data.js](../../design/UI_UX_design/assets/mock-data.js).
- [ ] Viết `answerMachine.ts` (reducer thuần) + test bảng chuyển trạng thái.
- [ ] Viết `QuestionComposer`, `ChatThread`, `AnswerMessage` (khung), `ChatPage`, route.
- [ ] Viết `useDocumentCounts` trong `lib/api/queries` (dùng lại query key của T01-09).
- [ ] Phát EV-11, EV-10 (`network`) qua `lib/analytics` (T01-10).
- [ ] Viết Playwright J1 (Fake LLM) + kịch bản lỗi; axe-core.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US008-1:** kho có ≥ 1 tài liệu `READY`, gõ câu hỏi tiếng Việt có dấu và không dấu, nhấn Enter hoặc nút Gửi → câu hỏi hiện trong khung, trạng thái "Đang tìm trong N tài liệu…" hiện ngay khi có `meta`, văn bản hiện dần (E2E).
- [ ] **AC-US008-3:** ô trống/chỉ khoảng trắng → nút Gửi vô hiệu, Enter không gửi, không có request mạng (kiểm bằng `page.on("request")`).
- [ ] **AC-US008-4:** nhấn "Dừng" khi đang stream → stream bị huỷ, phần đã hiện giữ nguyên, nhãn "Đã dừng"; EV-11 được gửi.
- [ ] **AC-US008-5:** > 2.000 ký tự → bộ đếm hiện, nút Gửi vô hiệu (EC-13).
- [ ] **AC-US008-6:** câu thứ 11 trong 1 phút (MSW 429 `Retry-After: 42`, và staging thật) → "Bạn đang hỏi quá nhanh, vui lòng thử lại sau 42 giây", đếm ngược, câu hỏi còn trong ô.
- [ ] **AC-US008-7:** 0 tài liệu → ô vô hiệu "Thêm tài liệu để bắt đầu hỏi"; chỉ có tài liệu đang xử lý → "Tài liệu đang được xử lý, vui lòng chờ" (EC-01, EC-02).
- [ ] **AC-US008-9:** mất mạng giữa stream hoặc dịch vụ AI không phản hồi 30 s (`error.timeout` / watchdog) → phần đã nhận giữ, thông báo dễ hiểu + "Thử lại", câu hỏi không mất (EC-05, EC-07).
- [ ] **AC-US018-1:** người dùng B mở `/c/{idA}` → "Không tìm thấy hội thoại", không lộ nội dung; A mở cùng URL thấy hội thoại bình thường (E2E hai tài khoản Keycloak).
- [ ] Không quá 1 lần cập nhật DOM / 50 ms khi stream (test hiệu năng với 2.000 delta).
- [ ] eslint-boundaries xanh (`features/chat` không import `features/documents`).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit (Vitest) | Parser SSE; reducer: mọi cạnh của Blueprint §3.7.1; composer: các trạng thái §4.4; đếm ký tự NFC; Enter khi `isComposing` |
| Component (Testing Library + MSW) | Gửi → meta → delta → done; Dừng; 429 đếm ngược; 409 NO_READY; eof; refused ẩn phần đã nhận |
| E2E (Playwright) | J1 với `FakeLLMAdapter` trên CI; với Claude thật trên staging; offline giả lập (`context.setOffline(true)`) giữa stream; hai người dùng cho AC-US018-1 |
| Accessibility | axe-core trên màn hình chính ở trạng thái rỗng, đang stream, lỗi |

## 8. Analytics / observability

- Client: EV-11 `answer_stopped {elapsed_ms}`; EV-10 `answer_failed {error_type: "network", elapsed_ms}` (đề xuất — cần T01-10 nhận EV-10 từ client).
- EV-08, EV-09 và EV-10 các loại khác do server ghi (T02-05) — không gửi trùng từ client.
- Không đưa nội dung câu hỏi vào sự kiện; `X-Request-ID` hiển thị làm mã tham chiếu khi lỗi.

## 9. Tham chiếu

- [USER_STORIES.md — US-008, US-018](../../requirements/USER_STORIES.md)
- [Blueprint_Design.md](../../design/Blueprint_Design.md) §3.1.2, §3.4.2 UF-01/UF-02, §3.6.2, §3.6.4, §3.7.1, §3.7.4, §3.8, §5 UXD-04, UXD-12
- [SAD.md](../../requirements/SAD.md) §4.1, §8.1, §10.3, ADR-008
- [PRD.md](../../requirements/PRD.md) §5.1 UX-01, UX-02, §5.2 EC-01..EC-07, EC-12, EC-13, EC-21
- Prototype [workspace.html](../../design/UI_UX_design/workspace.html), [workspace.js](../../design/UI_UX_design/assets/workspace.js)

## 10. Giả định và câu hỏi mở

- Giả định T01-03 cung cấp `apiFetch`, lớp `ApiError`, đọc cookie CSRF, `useDraft` (`lib/state/draftStore.ts`).
- **OQ-T0206-1:** Watchdog client 10 s/35 s là đề xuất; cần thống nhất với ping 15 s và timeout 30 s của server.
- **OQ-T0206-2:** "Thử lại" tạo lượt mới (server giữ lượt `FAILED` trong lịch sử) hay ghi đè? Đề xuất lượt mới; khi mở lại hội thoại, lượt `FAILED` hiển thị như Failed không có nút Thử lại.
- **OQ-T0206-3:** AC-US018-1 (giao diện) gắn vào task này dù README chỉ ghi US-008 — xác nhận với PO/QA.
