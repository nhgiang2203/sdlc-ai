# T05-02 — FE: hội thoại mới, cảnh báo hội thoại dài

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | US-014 · WP-50 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T02-06](T02-06-fe-chat-composer-stream.md) (composer, SSE, `ChatThread`), [T05-01](T05-01-follow-up-rewrite-history.md) (409 `CONVERSATION_TOO_LONG`) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Nút "Hội thoại mới" xoá ngữ cảnh hiện tại để câu hỏi tiếp theo không bị ảnh hưởng bởi hội thoại cũ; khi hội thoại đã đủ 20 lượt, hiển thị đề nghị bắt đầu hội thoại mới kèm nút, không làm mất câu hỏi đang soạn.

## 2. Bối cảnh

- PRD §5.1 bố cục (`[+ Mới]` ở đầu vùng hội thoại), EV-15 `conversation_started` ("Bấm Hội thoại mới hoặc câu hỏi đầu tiên", `conversation_id`).
- Blueprint §3.4 UF-02 (hội thoại > 20 lượt → đề nghị hội thoại mới), §3.6.2 `ChatThread` trạng thái `long-conversation`, `HistoryList.onNew()`, UXD-06 (không xác nhận thao tác không phá huỷ).
- Prototype `workspace.html` nút `#new-chat`; `assets/workspace.js` `newConversation()` (dừng stream nếu đang chạy, xoá tin nhắn, đặt tiêu đề "Hội thoại mới", đóng viewer, focus ô hỏi) và `ask()` khi `state.turns >= MAX_TURNS` (callout `callout-info` "Hội thoại đã dài … Câu hỏi của bạn vẫn được giữ trong ô soạn." + nút "Hội thoại mới").
- SAD §4.1 route `/` và `/c/:conversationId`; §10.2 `POST /conversations` → 201 `{id, created_at}`.

## 3. Phạm vi

**Trong phạm vi:** nút "Hội thoại mới" ở header vùng hội thoại; reset state client; tạo hội thoại lười khi gửi câu đầu; xử lý 409 `CONVERSATION_TOO_LONG`; callout hội thoại dài; EV-15; test.

**Ngoài phạm vi:** logic viết lại/lịch sử ([T05-01](T05-01-follow-up-rewrite-history.md)); danh sách hội thoại gần đây và mở lại ([T06-06](T06-06-conversation-history-retention.md)).

## 4. Thiết kế chi tiết

### 4.1 File

| File | Thay đổi |
|---|---|
| `frontend/src/features/chat/ChatHeader.tsx` | Tiêu đề hội thoại + nút `Button variant="secondary" size="sm"` biểu tượng `plus` "Hội thoại mới" |
| `frontend/src/features/chat/useNewConversation.ts` | Hook `startNewConversation()` |
| `frontend/src/features/chat/LongConversationNotice.tsx` | Callout info + nút "Hội thoại mới" |
| `frontend/src/features/chat/useAskQuestion.ts` (T02-06) | Tạo hội thoại lười; xử lý 409 |
| `frontend/src/lib/state/chatStore.ts` | Thêm `conversationId | null`, `turnCount`, `longConversation: boolean` |

### 4.2 "Hội thoại mới"

`startNewConversation()`:

1. Nếu đang stream → `abort()` (như nút Dừng, phát EV-11 theo T02-06).
2. Xoá tin nhắn trong `chatStore`, `conversationId = null`, `turnCount = 0`, `longConversation = false`; tiêu đề "Hội thoại mới".
3. `viewerStore.close()`; **giữ** phạm vi đã chọn (`scopeStore`) và **giữ** bản nháp trong ô soạn (đề xuất — giống prototype; người dùng thường bấm sau khi đã gõ câu mới).
4. `navigate("/")`; focus ô hỏi; thông báo `aria-live` "Đã bắt đầu hội thoại mới".
5. Không gọi API ngay. Không hiện hộp thoại xác nhận (UXD-06; hội thoại cũ vẫn lưu ở server).

Gửi câu hỏi khi `conversationId === null`: `POST /api/v1/conversations` → nhận `id` → `navigate("/c/{id}", { replace: true })` → phát EV-15 `{conversation_id}` → `POST /conversations/{id}/messages`. Lỗi khi tạo → hiển thị lỗi như lỗi gửi câu hỏi, giữ câu hỏi (T02-06). Như vậy EV-15 phát đúng một lần cho mỗi hội thoại có ít nhất một câu hỏi (đề xuất, tránh đếm hội thoại rỗng).

### 4.3 Hội thoại dài

- Nguồn sự thật là server: nhận 409 `CONVERSATION_TOO_LONG` (problem+json, trước khi có SSE) → `longConversation = true`, không thêm bong bóng câu hỏi, khôi phục câu hỏi vào ô soạn.
- Chủ động (đề xuất, tránh một lượt gửi bị từ chối): khi `turnCount ≥ 20` (đếm câu hỏi user trong hội thoại hiện tại, gồm cả khi mở lại từ `GET /conversations/{id}`), nhấn gửi hiển thị callout luôn, không gọi API.
- `LongConversationNotice` (cuối `ChatThread`, `role="status"`):
  - Tiêu đề: "Hội thoại đã dài"
  - Thân: "Hội thoại đã dài, hãy bắt đầu hội thoại mới để có kết quả tốt nhất. Câu hỏi của bạn vẫn được giữ trong ô soạn."
  - Nút chính "Hội thoại mới" → `startNewConversation()`; focus chuyển vào nút khi callout xuất hiện.
- Composer không bị vô hiệu (người dùng có thể sửa câu hỏi rồi bấm "Hội thoại mới").

## 5. Các bước thực hiện

- [ ] `ChatHeader` với nút "Hội thoại mới"; hook `startNewConversation`.
- [ ] Tạo hội thoại lười trong `useAskQuestion`; EV-15.
- [ ] Đếm `turnCount`; xử lý 409; `LongConversationNotice`.
- [ ] MSW handler 409 `CONVERSATION_TOO_LONG`; fixture hội thoại 20 lượt.
- [ ] Vitest + Playwright + axe.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US014-2:** sau khi bấm "Hội thoại mới", câu hỏi kế tiếp tạo hội thoại mới (`conversation_id` khác, `turn_index = 0`) và không mang ngữ cảnh cũ — E2E staging: hỏi về dự án X, bấm "Hội thoại mới", hỏi "Còn thời hạn bảo hành thì sao?" → câu trả lời không giả định dự án X (not_found hoặc hỏi lại / trả lời chung theo tài liệu).
- [ ] **AC-US014-4:** hội thoại đã có 20 lượt, gửi câu thứ 21 → hiển thị "Hội thoại đã dài, hãy bắt đầu hội thoại mới để có kết quả tốt nhất" kèm nút "Hội thoại mới"; câu hỏi còn trong ô soạn; bấm nút → hội thoại mới, gửi được câu đó.
- [ ] Bấm "Hội thoại mới" khi đang stream → stream dừng, không lỗi console, không còn request treo.
- [ ] EV-15 phát một lần mỗi hội thoại có câu hỏi đầu tiên; không phát khi chỉ bấm nút mà không hỏi.
- [ ] axe không có lỗi serious/critical; nút thao tác được bằng bàn phím.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `chatStore` reset; đếm `turnCount` khi nạp hội thoại có lượt FAILED (vẫn tính vì server đếm mọi câu hỏi user) |
| Component (MSW) | 409 → callout, câu hỏi khôi phục; `turnCount = 20` → callout không gọi API; nút trong callout gọi reset |
| E2E (`FakeLLMAdapter`) | Hỏi → URL `/c/:id`; "Hội thoại mới" → URL `/`, thread trống, viewer đóng, phạm vi giữ nguyên; seed hội thoại 20 lượt qua API test → lượt 21 → callout |
| E2E (staging) | Kịch bản AC-US014-2 với Claude thật |

## 8. Analytics / observability

- EV-15 `conversation_started` `{conversation_id}` (P1).
- Không thêm sự kiện cho callout; số lần 409 đo bằng metric server `cwd_conversation_too_long_total` (T05-01).

## 9. Tham chiếu

USER_STORIES US-014; PRD §5.1, §6.2 EV-15; Blueprint §3.4 UF-02, §3.6.2 (`ChatThread`, `HistoryList`), UXD-06; prototype `workspace.html` (`#new-chat`), `assets/workspace.js` (`newConversation`, `ask`); SAD §4.1, §10.2.

## 10. Giả định và câu hỏi mở

- Giả định: T02-06 tạo hội thoại trước câu hỏi đầu (hoặc lười); nếu T02-06 đã tạo hội thoại ngay khi vào `/`, chuyển sang tạo lười ở task này để không sinh hội thoại rỗng.
- **OQ-T0502-01:** Giữ bản nháp và phạm vi khi bấm "Hội thoại mới" (đề xuất) hay xoá cả hai? UX xác nhận.
- **OQ-T0502-02:** Có cần nhắc sớm (ví dụ từ lượt 18 "Còn 2 câu hỏi trong hội thoại này") không? Không có trong nguồn; mặc định không làm.
