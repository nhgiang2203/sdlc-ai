# T02-01 — Schema hội thoại + repository lọc chủ sở hữu + endpoint

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-018 · WP-20 |
| Loại | BE |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T01-02](T01-02-csrf-rbac-ratelimit-me.md) |
| Chặn | [T02-05](T02-05-ask-question-sse.md), [T06-06](T06-06-conversation-history-retention.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Tạo schema `conv.*` (hội thoại, message, citation), repository **bắt buộc** lọc theo `owner_id` (INV-02) và ba endpoint `POST/GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`. Kèm bộ test IDOR tự sinh từ danh sách route để mọi endpoint hội thoại/message hiện tại và sau này đều trả 404 cho người không phải chủ sở hữu.

## 2. Bối cảnh

- US-018 được kéo từ lát cắt 3 lên S2 (IMPLEMENTATION_PLAN §2.3) vì lọc `owner_id` phải có ngay khi tạo bảng; thêm sau là rủi ro bảo mật.
- SAD §5 INV-02: `Conversation` chỉ đọc/ghi được bởi `owner_id`; không khớp → 404, không lộ sự tồn tại (§11.1, EC-21).
- SAD §7.2 định nghĩa bảng `conv.conversations`, `conv.messages`, `conv.citations`, `conv.feedback`. Task này tạo **cả bốn bảng** (schema `conv.*` hoàn chỉnh); endpoint và repository của `conv.feedback` do [T06-03](T06-03-answer-feedback.md) làm.
- [T02-05](T02-05-ask-question-sse.md) dùng repository này để ghi message/citation; [T06-06](T06-06-conversation-history-retention.md) dùng cho lịch sử và `retention_sweep`.

## 3. Phạm vi

**Trong phạm vi:**
- Migration Alembic schema `conv` (4 bảng, enum, chỉ mục).
- Thực thể miền `Conversation`, `Message`, `Citation`, enum `AnswerType`, `MessageStatus`, `MessageRole`.
- Port `ConversationRepository` + adapter PostgreSQL; mọi phương thức nhận `owner_id` bắt buộc.
- Use case `CreateConversation`, `ListConversations`, `GetConversation` (module `history`).
- Router `conversations` với 3 endpoint, schema Pydantic, lỗi RFC 9457.
- Test IDOR tự sinh + test repository trên Testcontainers.

**Ngoài phạm vi:**
- `POST /conversations/{id}/messages` và pipeline hỏi đáp → [T02-05](T02-05-ask-question-sse.md) (dùng lại kiểm tra sở hữu của task này).
- Repository/endpoint `PUT /messages/{id}/feedback` → [T06-03](T06-03-answer-feedback.md) (phải thêm route vào ma trận IDOR).
- Giao diện "Không tìm thấy hội thoại" (AC-US018-1) → [T02-06](T02-06-fe-chat-composer-stream.md).
- Trang lịch sử, `retention_sweep` → [T06-06](T06-06-conversation-history-retention.md).
- Trang thống kê chỉ có số tổng hợp (AC-US018-3) → [T06-01](T06-01-weekly-stats-api.md), [T06-02](T06-02-fe-stats-page.md).
- Giới hạn 20 lượt (409 `CONVERSATION_TOO_LONG`) → [T05-01](T05-01-follow-up-rewrite-history.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `backend/migrations/versions/0201_conv_schema.py` | Migration schema `conv` |
| `backend/cwd/domain/conversations/model.py` | `Conversation`, `Message`, `Citation` (dataclass frozen), enum |
| `backend/cwd/ports/repositories.py` | Thêm `ConversationRepository` (Protocol) |
| `backend/cwd/adapters/postgres/conversation_repository.py` | `PgConversationRepository` (SQLAlchemy 2, core) |
| `backend/cwd/application/history/conversations.py` | `CreateConversation`, `ListConversations`, `GetConversation` |
| `backend/cwd/entrypoints/api/routers/conversations.py` | Router + schema Pydantic |
| `backend/tests/integration/test_conversation_repository.py` | Test repository |
| `backend/tests/security/test_idor_conversations.py` | Test IDOR tự sinh |

### 4.2 Migration SQL

```sql
CREATE TYPE conv.message_role   AS ENUM ('user', 'assistant');
CREATE TYPE conv.answer_type    AS ENUM ('answered', 'partial', 'not_found');
CREATE TYPE conv.message_status AS ENUM ('RETRIEVING', 'STREAMING', 'COMPLETED', 'STOPPED', 'FAILED');

CREATE TABLE conv.conversations (
  id               uuid PRIMARY KEY,               -- UUID v7 sinh ở ứng dụng
  owner_id         uuid NOT NULL REFERENCES access.users(id),
  title            text,                           -- ≤ 80 ký tự đầu của câu hỏi đầu tiên (đề xuất)
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_activity_idx ON conv.conversations (owner_id, last_activity_at DESC);

CREATE TABLE conv.messages (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid NOT NULL REFERENCES conv.conversations(id) ON DELETE CASCADE,
  turn_index         int  NOT NULL CHECK (turn_index >= 0),
  role               conv.message_role NOT NULL,
  text               text NOT NULL DEFAULT '',
  segments           jsonb,          -- (đề xuất) [{"text": "...", "cites": [1,2]}] để dựng lại chip khi mở lại
  llm_content        jsonb,          -- khối nội dung gửi/nhận nguyên văn (PR-07, T05-01)
  answer_type        conv.answer_type,
  status             conv.message_status,
  scope_document_ids uuid[],
  first_token_ms     int,
  total_ms           int,
  usage              jsonb,
  model              text,
  prompt_version     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_turn_role_uq UNIQUE (conversation_id, turn_index, role),
  CONSTRAINT messages_assistant_fields_ck CHECK (role = 'assistant' OR (answer_type IS NULL AND status IS NULL))
);

CREATE TABLE conv.citations (
  message_id              uuid NOT NULL REFERENCES conv.messages(id) ON DELETE CASCADE,
  idx                     int  NOT NULL CHECK (idx >= 1),
  chunk_id                uuid REFERENCES docs.chunks(id) ON DELETE SET NULL,   -- INV-03
  document_id             uuid NOT NULL,      -- không FK: tài liệu gỡ vẫn giữ citation
  document_title_snapshot text NOT NULL,
  page_start              int  NOT NULL,
  page_end                int  NOT NULL CHECK (page_end >= page_start),
  cited_text              text NOT NULL,
  PRIMARY KEY (message_id, idx)
);
CREATE INDEX citations_document_idx ON conv.citations (document_id);

CREATE TYPE conv.rating AS ENUM ('up', 'down');
CREATE TABLE conv.feedback (            -- chỉ tạo bảng; logic ở T06-03
  message_id uuid PRIMARY KEY REFERENCES conv.messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES access.users(id),
  rating     conv.rating NOT NULL,
  reason     text CHECK (reason IN ('wrong_info', 'wrong_citation', 'missing_info', 'other')),
  note       text CHECK (char_length(note) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- Cột `segments` **chưa có trong SAD §7.2** — đề xuất bổ sung để `GET /conversations/{id}` dựng lại vị trí chip `[n]` mà không phải parse `llm_content` ở mỗi lần đọc (xem §10).
- Quyền: role ứng dụng `cwd_app` có `SELECT, INSERT, UPDATE, DELETE` trên `conv.*` (DELETE cần cho `retention_sweep`).

### 4.3 Port `ConversationRepository`

```python
class ConversationRepository(Protocol):
    def create(self, *, owner_id: UUID, conversation_id: UUID) -> Conversation: ...
    def get_owned(self, *, conversation_id: UUID, owner_id: UUID) -> Conversation | None: ...
    def lock_owned(self, *, conversation_id: UUID, owner_id: UUID) -> Conversation | None:
        """SELECT … FOR UPDATE, dùng trong giao dịch bắt đầu lượt hỏi (T02-05)."""
    def list_owned(self, *, owner_id: UUID, cursor: str | None, page_size: int) -> Page[ConversationSummary]: ...
    def get_messages_owned(self, *, conversation_id: UUID, owner_id: UUID) -> list[MessageWithCitations] | None: ...
    def next_turn_index(self, *, conversation_id: UUID) -> int: ...
    def add_user_message(self, msg: NewUserMessage) -> Message: ...
    def add_assistant_placeholder(self, msg: NewAssistantMessage) -> Message: ...
    def complete_assistant_message(self, update: AssistantCompletion, citations: list[Citation]) -> None: ...
    def touch(self, *, conversation_id: UUID, title_if_empty: str | None) -> None: ...
```

Quy tắc:
- **Không có** phương thức đọc theo `id` mà không có `owner_id`. Các phương thức ghi message chỉ được gọi sau `lock_owned`/`get_owned` trong cùng giao dịch (kiểm bằng review + test).
- SQL luôn có `WHERE c.owner_id = :owner_id`; không lọc ở tầng router.
- `get_messages_owned` trả `None` khi không sở hữu → use case ném `ConversationNotFound` → 404.
- Phân trang cursor opaque: base64url của `(last_activity_at, id)`; `page_size` ≤ 100, mặc định 50 (SAD §10.1).

### 4.4 Endpoint

| Method & path | Request | 200/201 | Lỗi |
|---|---|---|---|
| `POST /api/v1/conversations` | `{}` + `X-CSRF-Token` | 201 `{id, created_at}` | 401, 403 CSRF |
| `GET /api/v1/conversations` | `?cursor`, `?page_size` | 200 `{items: [{id, title, created_at, last_activity_at}], next_cursor}` | 401 |
| `GET /api/v1/conversations/{id}` | — | 200 `{id, title, created_at, messages: Message[]}` | 404 `CONVERSATION_NOT_FOUND` |

`Message` (SAD §10.2, bổ sung `segments` — đề xuất):

```json
{ "id": "…", "turn_index": 0, "role": "assistant", "text": "…",
  "segments": [{"text": "Thanh toán 30% khi ký", "cites": [1]}],
  "answer_type": "answered", "status": "COMPLETED",
  "citations": [{"idx": 1, "document_id": "…", "document_title": "HopDong_X.pdf",
                 "page_start": 12, "page_end": 13, "cited_text": "…", "document_removed": false}],
  "created_at": "2026-11-25T03:12:00Z" }
```

- `document_removed` tính ở `GetConversation` bằng cách hỏi `DocumentRepository.statuses(ids)` (truy vấn chéo module qua application service, SAD §7.1).
- `{id}` không phải UUID hợp lệ → **404** (không 422) để mọi trường hợp "không thấy" giống nhau (đề xuất).
- Problem body: `{type, title: "Không tìm thấy hội thoại", status: 404, code: "CONVERSATION_NOT_FOUND", request_id}` — giống hệt cho "không tồn tại" và "không phải chủ".

### 4.5 Test IDOR tự sinh

- Fixture liệt kê `app.routes`, chọn mọi route có path param `{id}` nằm dưới `/api/v1/conversations` hoặc `/api/v1/messages`.
- Với mỗi route và method: người dùng A tạo hội thoại (và message giả qua repository), người dùng B gọi → kỳ vọng 404, body không chứa `title`/`text` của A. A gọi cùng route → không phải 404.
- Danh sách "route đã biết" lưu trong test; route mới dưới các prefix trên mà chưa có kịch bản → test **fail** (buộc T02-05, T06-03 bổ sung kịch bản).

## 5. Các bước thực hiện

- [ ] Viết migration `0201_conv_schema.py` (upgrade + downgrade), chạy trên Testcontainers.
- [ ] Viết thực thể miền + enum trong `domain/conversations/model.py`.
- [ ] Khai báo `ConversationRepository` trong `ports/repositories.py`.
- [ ] Viết `PgConversationRepository`, cursor encode/decode.
- [ ] Viết 3 use case trong `application/history/conversations.py`.
- [ ] Viết router + schema Pydantic, đăng ký vào app, gắn middleware auth/CSRF có sẵn (T01-02).
- [ ] Viết test repository, test API, test IDOR tự sinh.
- [ ] Cập nhật OpenAPI và mock MSW (`frontend/src/lib/api/mocks/conversations.ts`) theo schema mới.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US018-2:** người dùng B gọi trực tiếp `GET /conversations/{idA}` và `POST /conversations/{idA}/messages` (khi T02-05 merge) nhận 404 `CONVERSATION_NOT_FOUND`; test IDOR tự sinh xanh trong CI và fail khi có route mới chưa có kịch bản.
- [ ] Body 404 của "không tồn tại" và "không phải chủ" giống nhau từng byte (trừ `request_id`).
- [ ] `GET /conversations` chỉ trả hội thoại của người gọi, sắp theo `last_activity_at DESC`, cursor hoạt động qua ≥ 2 trang.
- [ ] `alembic upgrade head` và `downgrade -1` chạy sạch trên PostgreSQL 16 + pgvector.
- [ ] Coverage `application/history` ≥ 70%; mypy strict xanh.
- [ ] Không log `title`, `text` (kiểm tra mẫu log trong test).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | Cursor encode/decode; mapping `Message` → schema; `document_removed` khi tài liệu `REMOVED` |
| Integration (Testcontainers) | Tạo/đọc/liệt kê; `get_owned` với owner sai → `None`; UNIQUE `(conversation_id, turn_index, role)` chặn ghi trùng; xoá chunk → `citations.chunk_id = NULL` (INV-03) |
| API | 201 khi tạo; 403 khi thiếu CSRF; 404 với UUID sai định dạng; `page_size=101` → 400 |
| Bảo mật | Test IDOR tự sinh (A/B); B dùng cursor của A không thấy dữ liệu của A |

## 8. Analytics / observability

- Không có sự kiện EV riêng (US-018: —).
- Log `route`, `status`, `user_id` nội bộ; 404 IDOR ghi mức `info` với `error_code=CONVERSATION_NOT_FOUND` (không ghi `conversation_id` của người khác ở mức audit để tránh nhiễu — đề xuất).
- Span OTel `db.conv.*` tự sinh từ instrumentation SQLAlchemy.

## 9. Tham chiếu

- [USER_STORIES.md — US-018](../../requirements/USER_STORIES.md)
- [SAD.md](../../requirements/SAD.md) §5 (INV-02, INV-03), §7.1, §7.2, §10.1, §10.2, §11.1
- [PRD.md](../../requirements/PRD.md) §5.2 EC-21
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §2.3, S2 WP-20, §6

## 10. Giả định và câu hỏi mở

- Giả định `access.users` đã có từ T00-04; `owner_id` lấy từ phiên (T01-01), không bao giờ từ request body.
- Giả định UUID v7 sinh ở ứng dụng (thư viện `uuid6` hoặc `uuid_utils` — đề xuất).
- **OQ-T0201-1:** Bổ sung cột `segments` vào SAD §7.2 và schema `Message` §10.2? Nếu không, `GetConversation` phải dựng segments từ `llm_content` mỗi lần đọc.
- **OQ-T0201-2:** `title` chứa 80 ký tự đầu câu hỏi (dữ liệu nghiệp vụ, chỉ chủ xem được). Bảo mật thông tin có chấp nhận hay muốn tiêu đề trung tính ("Hội thoại 25/11 10:12")?
- **OQ-T0201-3:** Trả 404 cho UUID sai định dạng thay vì 422 — xác nhận với QA để ma trận test thống nhất.
