# T06-06 — Lịch sử hội thoại + `retention_sweep`

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | US-017 · WP-64 |
| Loại | BE, FE |
| Ước lượng | 2,5 ngày công (BE 1, FE 1,5) |
| Phụ thuộc | [T02-01](T02-01-conversations-ownership.md) (schema `conv.*`, `GET /conversations`, `GET /conversations/{id}`); thực tế cần thêm [T05-01](T05-01-follow-up-rewrite-history.md) (hỏi tiếp — AC-US017-3), [T02-07](T02-07-fe-answer-citations.md) (hiển thị câu trả lời + trích dẫn), [T05-04](T05-04-fe-document-removal.md) (chip tài liệu đã gỡ) |
| Chặn | [T07-03](T07-03-security-testing.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Người dùng xem danh sách "Hội thoại gần đây" của chính mình (tiêu đề = câu hỏi đầu tiên, mới nhất trước), mở lại một hội thoại với đầy đủ câu hỏi, câu trả lời, trích dẫn và hỏi tiếp trong ngữ cảnh đó; hội thoại không hoạt động quá thời hạn lưu giữ (180 ngày, chờ OQ-013) bị xoá tự động bởi task `retention_sweep` hằng ngày. Cùng task này xếp lại job tài liệu kẹt `QUEUED` > 30 phút (SAD §4.3).

## 2. Bối cảnh

- US-017 (P2, PER-01), UF-08 Blueprint; US-018 đã làm ở S2 (T02-01) nên mọi truy vấn đã lọc `owner_id` (INV-02).
- SAD §4.2 `retention_sweep()` hằng ngày 02:00 (Celery beat), hàng đợi `maintenance`, timeout 30 phút; §4.3 Valkey không backup — job mất được `retention_sweep` tạo lại; §7.4 hội thoại/message/citation 180 ngày kể từ hoạt động cuối, feedback cascade; §11.1 dữ liệu cá nhân xoá được nhờ `retention_sweep`; RSK-012.
- Prototype [history.html](../../design/UI_UX_design/history.html) (danh sách `history-list`, "N lượt hỏi · thời điểm", empty "Chưa có hội thoại nào", not found "Không tìm thấy hội thoại … đã hết hạn lưu giữ, hoặc không thuộc về bạn", ghi chú 180 ngày), nút "Lịch sử" trong [workspace.html](../../design/UI_UX_design/workspace.html) và nav [common.js](../../design/UI_UX_design/assets/common.js).
- Thứ tự cắt S6: US-017 là ứng viên thứ 3. **Nếu cắt UI vẫn nên giữ `retention_sweep`** (bảo vệ dữ liệu, xếp lại job kẹt).

## 3. Phạm vi

**Trong phạm vi:**
- BE: use case `PurgeExpiredConversations`, `RequeueStuckDocuments`; task `retention_sweep` + beat; cấu hình `CONVERSATION_RETENTION_DAYS`; bổ sung trường `turn_count`, `last_activity_at` cho `ConversationSummary` nếu T02-01 chưa có.
- FE: `features/history` (`HistoryList`, `HistoryPage`), route `/history` (đề xuất), mở `/c/:id` hiển thị toàn bộ hội thoại, EV-16.

**Ngoài phạm vi:** lọc/tìm kiếm hội thoại, đổi tên, xoá thủ công (chưa có yêu cầu); drawer lịch sử trong workspace (Blueprint nhắc "Workspace (drawer)" — đề xuất làm sau MVP, chỉ dùng trang `/history` + link header); test IDOR tổng thể → [T07-03](T07-03-security-testing.md); xoá phân vùng `ops.analytics_events` > 13 tháng và `ops.audit_log` > 2 năm (SAD §7.4) — xem OQ-169.

## 4. Thiết kế chi tiết

### 4.1 Backend

| Lớp | File | Nội dung |
|---|---|---|
| application | `backend/cwd/application/history/purge_expired_conversations.py` | `PurgeExpiredConversations(now, retention_days, batch_size=500)` → số hội thoại đã xoá |
| application | `backend/cwd/application/ingestion/requeue_stuck_documents.py` | `RequeueStuckDocuments(now, queued_older_than=30 min)` → danh sách `document_id` đã xếp lại |
| ports | `backend/cwd/ports/repositories.py` | `ConversationRepository.delete_inactive_before(cutoff, limit) -> int`; `DocumentRepository.list_stuck_queued(cutoff)`; `JobQueuePort.enqueue_process_document(id)` |
| adapters | `backend/cwd/adapters/postgres/conversation_repository.py` | SQL xoá theo lô |
| entrypoints | `backend/cwd/entrypoints/worker/tasks/maintenance.py` | `retention_sweep()` gọi hai use case, khoá `lock:retention_sweep` TTL 35 phút |
| entrypoints | `backend/cwd/entrypoints/worker/beat_schedule.py` | `"retention-sweep": crontab(hour=2, minute=0)`, `timezone = "Asia/Ho_Chi_Minh"` |
| config | `backend/cwd/config.py` | `CONVERSATION_RETENTION_DAYS: int = 180` (≥ 1), `STUCK_QUEUED_MINUTES: int = 30` |

Xoá theo lô (tránh giao dịch dài, khoá ít):

```sql
WITH victims AS (
  SELECT id FROM conv.conversations
  WHERE last_activity_at < :cutoff
  ORDER BY last_activity_at
  LIMIT :limit
  FOR UPDATE SKIP LOCKED
)
DELETE FROM conv.conversations c USING victims v WHERE c.id = v.id;
-- messages, citations, feedback xoá theo FK ON DELETE CASCADE (xác nhận với T02-01)
```

Lặp tới khi một lô trả 0 hoặc gần hết thời gian (`soft_time_limit` 1.700 s). `cutoff = now() - CONVERSATION_RETENTION_DAYS`. `last_activity_at` được cập nhật mỗi lượt hỏi (T02-05/T05-01) — **không** cập nhật khi chỉ mở xem (đề xuất; "hoạt động" = hỏi). Xem OQ-013.

Xếp lại job kẹt:

```sql
SELECT id FROM docs.documents
WHERE status = 'QUEUED' AND removed_at IS NULL AND uploaded_at < now() - interval '30 minutes';
```

Mỗi id → `enqueue_process_document(id)`; idempotent nhờ khoá `lock:doc:{id}` của worker (SAD §11.2). Ghi log `ingest.requeued` với `document_id`. Không động tới `PROCESSING` (Celery `acks_late` + `visibility_timeout` lo) — đề xuất.

### 4.2 API dùng lại (T02-01)

- `GET /api/v1/conversations?cursor&page_size` → `{items: [{id, title, created_at, last_activity_at, turn_count}], next_cursor}`, sắp theo `last_activity_at DESC` (chỉ của mình). `title` = câu hỏi đầu tiên cắt 80 ký tự tại ranh giới từ + "…" (đề xuất; xác nhận cách T02-01 đặt).
- `GET /api/v1/conversations/{id}` → `{id, title, last_activity_at, messages: Message[]}` gồm `citations[].document_removed` và `feedback` (T06-03); 404 khi không tồn tại / hết hạn / không phải chủ.
- Hội thoại chưa có câu hỏi nào (tạo bằng "Hội thoại mới" rồi bỏ) **không hiển thị** trong danh sách (đề xuất: lọc `turn_count > 0`).

### 4.3 Frontend

| File | Nội dung |
|---|---|
| `frontend/src/features/history/api.ts` | `fetchConversations(cursor)` |
| `frontend/src/features/history/useConversations.ts` | `useInfiniteQuery(["conversations"])`, invalidate khi gửi câu hỏi mới (qua `queryClient` ở app) |
| `frontend/src/features/history/HistoryList.tsx` | `<ul class="history-list">`, mỗi mục `<Link to="/c/:id">`: icon chat, tiêu đề (1 dòng, `title` đầy đủ), "N lượt hỏi · {thời điểm}", chevron; nút "Xem thêm" khi có `next_cursor`; states loading (skeleton), empty, list |
| `frontend/src/features/history/HistoryPage.tsx` | Tiêu đề "Lịch sử hội thoại", mô tả "Chỉ bạn xem được các hội thoại này. Hội thoại không hoạt động quá {N} ngày sẽ tự động bị xoá." (N từ cấu hình `/me` hoặc hằng build — đề xuất), nút "Hội thoại mới" |
| `frontend/src/features/history/formatActivity.ts` | "Hôm nay, 09:41" / "Hôm qua, 16:05" / "18/10/2026, 11:20" theo `Asia/Ho_Chi_Minh` |
| `frontend/src/app/routes.tsx` | Thêm `/history`; `/c/:conversationId` (đã có ở S2) tải hội thoại cũ |
| `frontend/src/app/WorkspacePage.tsx` | Khi `conversationId` trong URL khác hội thoại hiện tại → gọi `GET /conversations/{id}`, nạp `ChatThread` với toàn bộ message (dùng `AnswerMessage`, `CitationChip`, `SourceList` của `features/chat`); câu hỏi tiếp theo POST vào id này (T05-01) |
| `frontend/src/features/chat/ConversationNotFound.tsx` | 404 → EmptyState "Không tìm thấy hội thoại" + "Hội thoại không tồn tại, đã hết hạn lưu giữ, hoặc không thuộc về bạn." + nút "Về danh sách hội thoại" (EC-21) |

Ranh giới: `features/history` không import `features/chat`; `app/` ghép hai feature qua router (Blueprint §3.1.2).

## 5. Các bước thực hiện

- [ ] Xác nhận với T02-01: FK cascade `messages → citations, feedback`; `ConversationSummary` có `turn_count`, `last_activity_at`; quy tắc `title`.
- [ ] Use case + repository + integration test xoá theo lô.
- [ ] `RequeueStuckDocuments` + test.
- [ ] Task `retention_sweep`, beat, khoá, metric; chạy thủ công `celery call retention_sweep` trên staging.
- [ ] FE: `HistoryList`, `HistoryPage`, route, link "Lịch sử" ở header.
- [ ] FE: mở `/c/:id` hiển thị đủ nội dung; 404 → `ConversationNotFound`.
- [ ] EV-16.
- [ ] Playwright + axe.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US017-1:** người dùng có hội thoại từ hôm trước mở "Lịch sử" → thấy các hội thoại đặt tiêu đề theo câu hỏi đầu tiên, sắp mới nhất trước; không thấy hội thoại của người khác.
- [ ] **AC-US017-2:** mở một hội thoại cũ → hiển thị đầy đủ mọi câu hỏi, câu trả lời (gồm Not found, Partial), chip trích dẫn và danh sách nguồn; trích dẫn tới tài liệu đã gỡ hiển thị gạch ngang + "Tài liệu đã bị gỡ" (EC-17).
- [ ] **AC-US017-3:** trong hội thoại cũ, gửi câu hỏi tiếp → message được thêm vào cùng `conversation_id` với `turn_index` kế tiếp và được viết lại theo ngữ cảnh (T05-01); E2E kiểm tra câu hỏi đại từ ("còn hợp đồng đó thì sao?").
- [ ] **AC-US017-4:** hội thoại có `last_activity_at` cũ hơn 180 ngày (cấu hình) bị xoá sau một lần `retention_sweep` cùng message, citation, feedback; không còn trong danh sách; mở link cũ → "Không tìm thấy hội thoại".
- [ ] Tài liệu `QUEUED` > 30 phút được xếp lại và đạt `READY` (test với worker dừng rồi chạy lại, xoá key Valkey).
- [ ] EV-16 ghi nhận trên staging với `conversation_id`, `age_days`.

## 7. Kiểm thử

| Tầng | Ca |
|---|---|
| Unit | Tính `cutoff`; `formatActivity`; `CONVERSATION_RETENTION_DAYS` < 1 bị từ chối khi khởi động |
| Integration | Seed hội thoại 179/180/181 ngày → chỉ 181 bị xoá; cascade; 1.200 hội thoại → 3 lô; chạy song song hai sweep → khoá ngăn chạy đôi; job kẹt được enqueue đúng 1 lần |
| Hợp đồng | `ConversationSummary`, `Conversation` theo SAD §10.2 |
| E2E | AC-US017-1..4 (AC-4 dùng endpoint test-only `POST /__test__/time-travel` chỉ bật ở CI, hoặc seed SQL trực tiếp — đề xuất seed SQL) |
| Accessibility | axe trên `/history` (list, empty) và màn 404 |

## 8. Analytics / observability

- EV-16 `conversation_reopened` (client): phát khi tải thành công một hội thoại **không tạo trong phiên hiện tại** (mở từ danh sách hoặc link trực tiếp), `props: {conversation_id, age_days}` với `age_days = floor((now − last_activity_at) / 1 ngày)`.
- Metric: `cwd_retention_deleted_conversations_total`, `cwd_retention_sweep_seconds`, `cwd_ingest_requeued_total`, `cwd_retention_last_success_timestamp` (đề xuất thêm cảnh báo "sweep không chạy > 26 h" vào [T06-04](T06-04-metrics-dashboards-alerts.md)).
- Log `retention.sweep_done` gồm số bản ghi, thời gian — không có tiêu đề hội thoại (tiêu đề là nội dung câu hỏi, PR-06).

## 9. Tham chiếu

- USER_STORIES US-017, US-018, US-014; PRD §5.2 EC-17, EC-21, §6.2 EV-16.
- SAD §4.1 (route `/c/:conversationId`), §4.2 (tác vụ C-03), §4.3 (Valkey, job kẹt), §5 INV-02/INV-03, §7.2, §7.4, §10.2, §11.1, RSK-012.
- Blueprint §3.4 UF-08, §3.6.2 `HistoryList`; prototype `history.html`.

## 10. Giả định và câu hỏi mở

- Giả định: OQ-013 chưa được quyết trước 18/01/2027 → dùng 180 ngày, cấu hình được (IMPLEMENTATION_PLAN §5.1).
- Giả định: pilot bắt đầu 22/02/2027 nên trong MVP chưa có hội thoại nào thực sự hết hạn; AC-US017-4 nghiệm thu bằng dữ liệu seed.
- OQ-013 (kế thừa): thời hạn lưu hội thoại; "hoạt động cuối" có tính cả lần mở xem không.
- **OQ-169 (mới):** Task nào xoá phân vùng `ops.analytics_events` > 13 tháng và `ops.audit_log` > 2 năm (SAD §7.4)? Không cần cho pilot 4 tuần nhưng chưa có chủ. Đề xuất: thêm vào `retention_sweep` sau MVP.
- **OQ-171 (mới):** SAD §4.1 không có route `/history`; đề xuất bổ sung `/history` vào danh mục route (Blueprint và prototype đã có trang Lịch sử). Owner: Architect.
