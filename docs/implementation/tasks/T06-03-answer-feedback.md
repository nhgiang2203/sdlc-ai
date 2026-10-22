# T06-03 — Đánh giá câu trả lời (API + UI)

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | US-021 · WP-61 (EV-17 là **P0** dù story P2) |
| Loại | BE, FE |
| Ước lượng | 2 ngày công (BE 1, FE 1) |
| Phụ thuộc | [T02-05](T02-05-ask-question-sse.md) (AskQuestion, message assistant), [T02-07](T02-07-fe-answer-citations.md) (`AnswerMessage`), [T02-01](T02-01-conversations-ownership.md) (bảng `conv.feedback`, repository lọc owner), [T01-10](T01-10-analytics-events.md) (emitter server) |
| Chặn | [T07-03](T07-03-security-testing.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cho người dùng đánh giá 👍/👎 một câu trả lời đã hoàn tất, kèm lý do và ghi chú tuỳ chọn khi 👎; lưu một bản ghi duy nhất mỗi câu trả lời (cập nhật khi đổi ý) qua `PUT /api/v1/messages/{id}/feedback`, chỉ chủ hội thoại được đánh giá; phát EV-17 để đo MET-004 (KR3.2 ≥ 70%).

## 2. Bối cảnh

- PRD §6.2: "EV-17 là P0 dù US-021 là P2: không có nó thì không đo được MET-004". IMPLEMENTATION_PLAN §5.3: story P0 và EV-17 không bị cắt.
- SAD §7.2 `conv.feedback` (PK `message_id`, `user_id`, `rating`, `reason`, `note`, `updated_at`) đã được tạo ở T02-01 nhưng chưa có endpoint; §10.2 hợp đồng `PUT /api/v1/messages/{id}/feedback`; §10.1 "PUT /feedback idempotent"; INV-02 lọc owner → 404.
- Blueprint §3.6.2 `FeedbackControl` (states none, up, down, down-with-reason), §3.7.1 (Answered/Partial/NotFound đều có 👍/👎), UXD-10 (ít ma sát, lý do tuỳ chọn). Prototype [workspace.js](../../design/UI_UX_design/assets/workspace.js) (`answer-actions`, `feedback-panel`, chip lý do, textarea 500 ký tự, "Bỏ qua"/"Gửi phản hồi", "Cảm ơn phản hồi của bạn").

## 3. Phạm vi

**Trong phạm vi:** domain + use case `RateAnswer`, repository upsert, router `feedback`, trường `feedback` trong `Message` của `GET /conversations/{id}`, EV-17 phía server, `FeedbackControl` + panel lý do, feature flag `FEATURE_FEEDBACK`, test.

**Ngoài phạm vi:** tổng hợp tỷ lệ hữu ích → [T06-01](T06-01-weekly-stats-api.md)/[T06-02](T06-02-fe-stats-page.md); nút Sao chép trong cùng thanh hành động → [T06-07](T06-07-copy-answer.md); test IDOR tổng thể → [T07-03](T07-03-security-testing.md); xem/xuất ghi chú phản hồi cho đội sản phẩm (chưa có yêu cầu — OQ-165).

**Phương án khi cắt US-021 (§5.3):** giữ API + 2 nút 👍/👎 (không panel lý do/ghi chú) để EV-17 vẫn có dữ liệu; ước lượng còn ~1,2 ngày. Nếu cắt hẳn UI → PO lên kế hoạch khảo sát cuối pilot (PRD §6.2).

## 4. Thiết kế chi tiết

### 4.1 Backend

| Lớp | File | Nội dung |
|---|---|---|
| domain | `backend/cwd/domain/conversations/feedback.py` | `Rating = Literal["up","down"]`; `FeedbackReason` enum `wrong_info`, `wrong_citation`, `missing_info`, `other`; `Feedback(message_id, user_id, rating, reason, note, updated_at)`; quy tắc: `rating == "up"` → `reason = note = None`; `note` ≤ 500 ký tự sau `strip()`, rỗng → `None` |
| application | `backend/cwd/application/qa/rate_answer.py` | `RateAnswer.execute(user_id, message_id, rating, reason, note) -> RateResult(feedback, changed: bool)` |
| ports | `backend/cwd/ports/repositories.py` | `MessageRepository.get_owned_assistant_message(user_id, message_id)`; `FeedbackRepository.get(message_id)`, `upsert(feedback)` |
| adapters | `backend/cwd/adapters/postgres/feedback_repository.py` | Upsert SQL bên dưới |
| entrypoints | `backend/cwd/entrypoints/api/routers/feedback.py` | `PUT /api/v1/messages/{message_id}/feedback`; schema `FeedbackIn`, `FeedbackOut` |
| entrypoints | `backend/cwd/entrypoints/api/schemas/conversations.py` | Bổ sung `feedback: FeedbackOut \| None` cho `Message` assistant (hydrate khi mở lại hội thoại) |

Kiểm tra sở hữu (một câu SQL, INV-02):

```sql
SELECT m.id, m.conversation_id, m.turn_index, m.status, m.answer_type
FROM conv.messages m JOIN conv.conversations c ON c.id = m.conversation_id
WHERE m.id = :message_id AND m.role = 'assistant' AND c.owner_id = :user_id;
```

Upsert:

```sql
INSERT INTO conv.feedback (message_id, user_id, rating, reason, note, updated_at)
VALUES (:message_id, :user_id, :rating, :reason, :note, now())
ON CONFLICT (message_id) DO UPDATE
  SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, note = EXCLUDED.note, updated_at = now()
  WHERE (conv.feedback.rating, conv.feedback.reason, conv.feedback.note)
        IS DISTINCT FROM (EXCLUDED.rating, EXCLUDED.reason, EXCLUDED.note)
RETURNING message_id, rating, reason, note, updated_at, (xmax = 0) AS inserted;
```

Không có hàng trả về → không thay đổi (`changed = false`), đọc lại bản ghi hiện tại để trả 200.

### 4.2 Hợp đồng API

`PUT /api/v1/messages/{id}/feedback` · header `X-CSRF-Token` · body:

```json
{"rating": "down", "reason": "wrong_citation", "note": "Trang 12 không có số này"}
```

| Kết quả | Điều kiện |
|---|---|
| 200 `{"message_id","rating","reason","note","updated_at"}` | Tạo mới hoặc cập nhật hoặc không đổi (idempotent) |
| 400 `VALIDATION_ERROR` | `rating` ngoài `up/down`; `reason` ngoài danh mục; `note` > 500 ký tự; `reason`/`note` khi `rating = up` (đề xuất: server tự bỏ và không báo lỗi — chọn một, xem OQ-164) |
| 403 `CSRF_FAILED` | Thiếu/sai token CSRF (middleware T01-02) |
| 404 `NOT_FOUND` | Message không tồn tại, không phải assistant, hoặc **không thuộc hội thoại của người gọi** (AC-US018-2 — không phân biệt) |
| 409 `MESSAGE_NOT_COMPLETED` (đề xuất) | `status` ≠ `COMPLETED` (đang `RETRIEVING`/`STREAMING`, hoặc `STOPPED`/`FAILED`) |
| 429 | Rate limit chung (đề xuất 60 PUT/phút/người) |

`note` là văn bản tự do của người dùng: lưu trong `conv.feedback` (xoá theo hội thoại — SAD §7.4 cascade), **không đưa vào analytics, log hay span** (PR-06).

### 4.3 EV-17 phía server (đề xuất)

Phát trong `RateAnswer` khi `changed = true`, cùng giao dịch ghi (outbox của T01-10): `name = "answer_rated"`, `props = {conversation_id, turn_index, rating, reason}` (không `note`). FE **không** gọi `track("answer_rated")` để tránh đếm đôi. Lý do chọn server: không mất khi trình duyệt chặn `sendBeacon`, khớp số liệu `conv.feedback`.

### 4.4 Frontend

| File | Nội dung |
|---|---|
| `frontend/src/features/chat/feedback/api.ts` | `putFeedback(messageId, body)` |
| `frontend/src/features/chat/feedback/useRateAnswer.ts` | `useMutation` cập nhật lạc quan cache `["conversation", id]`; rollback + `Toast` danger "Không gửi được đánh giá. Thử lại." khi lỗi |
| `frontend/src/features/chat/feedback/FeedbackControl.tsx` | Props `{ rating, reason, disabled, onRate }`; 2 `IconButton` `aria-pressed`, `aria-label` "Câu trả lời hữu ích" / "Câu trả lời chưa hữu ích" |
| `frontend/src/features/chat/feedback/FeedbackReasonPanel.tsx` | Tiêu đề "Điều gì chưa ổn? (không bắt buộc)", `chip-group` 4 lý do (Sai thông tin / Trích dẫn sai / Thiếu thông tin / Khác), textarea "Ghi chú (tối đa 500 ký tự)" `maxLength=500` + bộ đếm khi ≥ 450, nút "Bỏ qua" / "Gửi phản hồi" |
| `frontend/src/features/chat/answer/AnswerMessage.tsx` | Render `FeedbackControl` **chỉ khi** state ∈ {Answered, Partial, NotFound} |

Luồng UI:
1. Bấm 👍 → PUT `{rating:"up"}` ngay; nút ở trạng thái pressed; dòng "Cảm ơn phản hồi của bạn".
2. Bấm 👎 → PUT `{rating:"down"}` ngay (để EV-17 không phụ thuộc việc điền lý do), mở panel, focus chip đầu. "Gửi phản hồi" → PUT lần 2 kèm `reason`/`note`, đóng panel, toast "Đã gửi phản hồi. Cảm ơn bạn!". "Bỏ qua"/Esc → đóng panel, giữ 👎.
3. Bấm biểu tượng còn lại → PUT rating mới (cập nhật, không trùng — AC-US021-3). Bấm lại biểu tượng đang chọn → không làm gì (API không hỗ trợ huỷ đánh giá; khác prototype — OQ-164).
4. Mở lại hội thoại: trạng thái lấy từ `message.feedback`.

## 5. Các bước thực hiện

- [ ] Domain `Feedback` + unit test quy tắc.
- [ ] Repository + upsert + integration test (không tạo bản ghi trùng, `changed` đúng).
- [ ] `RateAnswer` + EV-17 qua outbox.
- [ ] Router, schema, mã lỗi; thêm vào ma trận phân quyền tự sinh.
- [ ] Bổ sung `feedback` vào `Message` của `GET /conversations/{id}` (phối hợp T02-01, cập nhật OpenAPI + mock MSW).
- [ ] `FeedbackControl`, `FeedbackReasonPanel`, `useRateAnswer`; tích hợp `AnswerMessage`.
- [ ] Feature flag `FEATURE_FEEDBACK` (BE trả 404 route khi tắt; FE ẩn control).
- [ ] E2E Playwright + axe trên khung câu trả lời có panel mở.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US021-1:** câu trả lời đã hiển thị xong, bấm 👍 hoặc 👎 → PUT 200, bản ghi `conv.feedback` tồn tại, nút đổi trạng thái `aria-pressed="true"` (E2E).
- [ ] **AC-US021-2:** bấm 👎 → panel hiện 4 lý do Sai thông tin / Trích dẫn sai / Thiếu thông tin / Khác và ghi chú tuỳ chọn; ghi chú 501 ký tự bị chặn ở client và 400 ở server.
- [ ] **AC-US021-3:** đổi 👍 → 👎 (và ngược lại) cập nhật bản ghi duy nhất; `SELECT count(*) FROM conv.feedback WHERE message_id = …` = 1; PUT lặp cùng body không phát thêm EV-17.
- [ ] **AC-US021-4:** khi câu trả lời đang Retrieving/Streaming, `FeedbackControl` không có trong DOM; API trả 409 nếu gọi trực tiếp.
- [ ] Người dùng B gọi PUT vào message của A → 404 (test integration; bao phủ phần feedback của AC-US018-2).
- [ ] EV-17 ghi nhận trên staging với `conversation_id`, `turn_index`, `rating`, `reason`; không có `note` (kiểm tra LG-08).
- [ ] axe 0 lỗi serious/critical; panel dùng được hoàn toàn bằng bàn phím.

## 7. Kiểm thử

| Tầng | Ca |
|---|---|
| Unit | `Feedback` chuẩn hoá `up` xoá reason/note; note toàn khoảng trắng → `None`; 500/501 ký tự |
| Integration | Upsert mới/cập nhật/không đổi; 404 khi không phải owner, message `role=user`, id không tồn tại; 409 khi `STREAMING`; xoá hội thoại → feedback cascade |
| Hợp đồng | Schema `FeedbackIn/Out`, `Message.feedback`; props EV-17 qua validator T01-10 |
| FE | Vitest: rollback lạc quan khi PUT lỗi; Playwright: 👍, 👎 + lý do, đổi ý, mở lại hội thoại giữ trạng thái |

## 8. Analytics / observability

- EV-17 `answer_rated` (server, khi thay đổi).
- Metric `cwd_feedback_total{rating, reason}` (đề xuất) cho dashboard chất lượng ([T06-04](T06-04-metrics-dashboards-alerts.md)).
- Log `feedback.saved` chỉ gồm `message_id`, `rating`, `reason`, `changed` — không có `note`.

## 9. Tham chiếu

- USER_STORIES US-021, US-018 (AC-2); PRD §2.2 KR3.2, §6.2 EV-17.
- SAD §4.2 (`qa`: `RateAnswer`), §4.4, §5 INV-02, §7.2 `conv.feedback`, §7.4, §10.1, §10.2.
- Blueprint §3.6.2 `FeedbackControl`, §3.7.1, UXD-10; prototype `workspace.js`, `components.css` (`.answer-actions`, `.feedback-panel`, `.chip`).

## 10. Giả định và câu hỏi mở

- Giả định: `conv.feedback.message_id` có FK tới `conv.messages(id) ON DELETE CASCADE` (T02-01) để `retention_sweep` xoá kèm.
- Giả định: câu trả lời `not_found` vẫn được đánh giá (Blueprint §3.7.1) — đánh giá này tính vào tỷ lệ hữu ích.
- **OQ-164 (mới):** Có cho phép huỷ đánh giá (bấm lại 👍 như prototype) không? Nếu có cần `DELETE /messages/{id}/feedback` và quy ước EV-17 `rating = none`. Đồng thời chốt: `reason`/`note` kèm `rating=up` → 400 hay bỏ qua. Owner: PO + Tech lead.
- **OQ-165 (mới):** Đội sản phẩm có được đọc `note` (văn bản tự do, có thể chứa thông tin khách hàng) để cải thiện chất lượng không? Liên quan OQ-025. Owner: Bảo mật thông tin.
