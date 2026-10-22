# T00-04 — Migration nền: schema, extension, `f_unaccent`, `access.users`

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | WP-03 |
| Loại | BE |
| Ước lượng | 1 ngày công |
| Phụ thuộc | [T00-01](T00-01-backend-scaffold.md), [T00-03](T00-03-dev-docker-compose.md) |
| Chặn | [T01-01](T01-01-oidc-session.md), [T01-04](T01-04-document-upload-api.md), [T01-10](T01-10-analytics-events.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Khởi tạo Alembic và migration đầu tiên `0001_baseline` tạo 4 schema module (`access`, `docs`, `conv`, `ops`), các extension `vector`, `unaccent`, `pg_trgm`, hàm `f_unaccent` IMMUTABLE và bảng `access.users`; kèm khung SQLAlchemy 2 và test integration trên Testcontainers.

## 2. Bối cảnh

- SAD §7.1: một CSDL, mỗi module một schema PostgreSQL; module chỉ truy cập schema của mình qua repository.
- SAD §7.2: `unaccent()` chỉ `STABLE` → không dùng được trong generated column (`docs.chunks.tsv`) hay chỉ mục trigram (`docs.documents` lọc tên). Phải bọc thành `f_unaccent` IMMUTABLE.
- SAD §11.2: migration theo kiểu expand/contract để tương thích ngược một phiên bản (áp dụng từ migration thứ hai).
- Các bảng `docs.*` (T01-04, T01-06), `conv.*` (T02-01), `ops.analytics_events` (T01-10), `ops.audit_log` (T01-04/T05-05) do task tương ứng thêm bằng migration riêng.

## 3. Phạm vi

**Trong phạm vi:**
- Thêm deps: `sqlalchemy>=2`, `alembic`, `psycopg[binary]>=3`, `pgvector>=0.3`, `uuid-utils`.
- `backend/migrations/` (Alembic: `env.py`, `script.py.mako`, `versions/0001_baseline.py`).
- `cwd/adapters/persistence/postgres/{base.py, session.py, models/access.py}`.
- Cấp quyền cho role `cwd_app`; default privileges.
- Target `make migrate`, `make migrate-down`, `make migration name=...`.
- Test integration migration.

**Ngoài phạm vi:**
- Repository `UserRepository` và upsert khi đăng nhập → [T01-01](T01-01-oidc-session.md).
- Các bảng nghiệp vụ khác (xem §2).
- Chạy migration tự động khi deploy staging → [T00-07](T00-07-staging-deploy-nginx.md).
- PgBouncer, `sslmode=verify-full` → [T05-08](T05-08-prod-provisioning.md).

## 4. Thiết kế chi tiết

### 4.1 Alembic

| Mục | Giá trị |
|---|---|
| Vị trí | `backend/migrations/`, `alembic.ini` trong `backend/` |
| URL | `CWD_MIGRATION_DATABASE_URL` (role `cwd_owner`); **không** dùng `CWD_DATABASE_URL` của `cwd_app` |
| `target_metadata` | `cwd.adapters.persistence.postgres.base.Base.metadata` |
| `include_schemas` | `True`; `include_name` chỉ nhận `access`, `docs`, `conv`, `ops` |
| Version table | Mặc định `public.alembic_version` (schema `ops` chưa tồn tại khi Alembic tạo version table) |
| Tên file | `NNNN_<slug>.py`, `revision = "NNNN"` (đánh số tuần tự, dễ đọc khi review) (đề xuất) |
| Chạy | `alembic upgrade head` — lệnh `migrate` trong image `cwd-app` |

### 4.2 Naming convention SQLAlchemy

```python
NAMING = {"ix": "ix_%(table_name)s_%(column_0_N_name)s", "uq": "uq_%(table_name)s_%(column_0_N_name)s",
          "ck": "ck_%(table_name)s_%(constraint_name)s", "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
          "pk": "pk_%(table_name)s"}
class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)
```

### 4.3 Migration `0001_baseline` — upgrade

```sql
CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA public;   -- pgvector ≥ 0.8
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;

CREATE SCHEMA access; CREATE SCHEMA docs; CREATE SCHEMA conv; CREATE SCHEMA ops;

CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;   -- SAD §7.2

CREATE TABLE access.users (
  id            uuid PRIMARY KEY,                       -- UUID v7 sinh ở ứng dụng (SAD §10.1)
  idp_subject   text NOT NULL,
  display_name  text NOT NULL,
  email         text,
  roles         text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  CONSTRAINT uq_users_idp_subject UNIQUE (idp_subject),
  CONSTRAINT ck_users_roles_valid CHECK (roles <@ ARRAY['user','lead','manager']::text[])
);

GRANT USAGE ON SCHEMA access, docs, conv, ops TO cwd_app;
GRANT SELECT, INSERT, UPDATE ON access.users TO cwd_app;          -- không DELETE (đề xuất)
ALTER DEFAULT PRIVILEGES FOR ROLE cwd_owner IN SCHEMA docs, conv
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cwd_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cwd_owner IN SCHEMA docs, conv, ops, access
  GRANT USAGE, SELECT ON SEQUENCES TO cwd_app;
```

- Schema `ops` **không** có default privilege DML: mỗi bảng `ops.*` tự cấp quyền trong migration của nó (đặc biệt `ops.audit_log` chỉ `INSERT, SELECT` — INV-05).
- Cột `roles` khớp SAD §7.2 (`roles text[]`); `created_at` là bổ sung (đề xuất).
- Tên role `cwd_app` lấy từ cấu hình Alembic (`-x app_role=cwd_app`, mặc định `cwd_app`) để staging/prod đặt tên khác được.

**downgrade:** `DROP TABLE access.users; DROP SCHEMA ops, conv, docs, access; DROP FUNCTION public.f_unaccent(text);` — không drop extension (có thể dùng chung).

### 4.4 Model và session

```python
# cwd/adapters/persistence/postgres/models/access.py
class UserRow(Base):
    __tablename__ = "users"; __table_args__ = {"schema": "access"}
    id: Mapped[UUID] = mapped_column(primary_key=True, default=new_uuid7)
    idp_subject: Mapped[str] = mapped_column(unique=True)
    display_name: Mapped[str]; email: Mapped[str | None]
    roles: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime | None]

# cwd/adapters/persistence/postgres/session.py
def make_engine(url: str) -> AsyncEngine        # postgresql+psycopg://, pool_size=10, pool_pre_ping=True
def make_session_factory(engine) -> async_sessionmaker[AsyncSession]   # expire_on_commit=False
```

`new_uuid7()` đặt ở `cwd/domain/ids.py` (thuần, chỉ gọi `uuid_utils.uuid7()` rồi chuyển sang `uuid.UUID`) để domain dùng được. Thêm `uuid_utils` vào danh sách cho phép của contract domain.

### 4.5 Test fixture dùng chung

`tests/integration/conftest.py`:
- Fixture session-scope `pg_container`: `PostgresContainer("pgvector/pgvector:0.8.x-pg16")`, tạo role `cwd_owner`, `cwd_app`.
- Fixture `migrated_db`: chạy `alembic upgrade head` bằng API `alembic.command.upgrade`.
- Fixture `db_session` (role `cwd_app`), rollback sau mỗi test.
Các task sau tái sử dụng fixture này.

## 5. Các bước thực hiện

- [ ] Thêm deps §3, `alembic init migrations`, sửa `env.py` (async engine, `include_schemas`, URL từ settings).
- [ ] Viết `base.py`, `session.py`, `models/access.py`, `domain/ids.py`.
- [ ] Viết `0001_baseline.py` bằng `op.execute()` cho extension/hàm/grant, `op.create_table` cho users.
- [ ] Kiểm tra `alembic revision --autogenerate` sau baseline sinh migration **rỗng** (metadata khớp DB).
- [ ] Viết fixture §4.5 và test §7.
- [ ] Thêm target Makefile; chạy `make up-core && make migrate` trên Compose dev.

## 6. Tiêu chí hoàn thành

- [ ] `alembic upgrade head` chạy trên Testcontainers và Compose dev (WP-03).
- [ ] `alembic downgrade base && alembic upgrade head` không lỗi.
- [ ] `f_unaccent` có `provolatile = 'i'`; tạo được chỉ mục `GIN (f_unaccent(lower(x)) gin_trgm_ops)` và generated column `to_tsvector('simple', f_unaccent(x))` (điều kiện tiên quyết của SAD §7.2).
- [ ] `cwd_app` không tạo được bảng trong `access`, không `DELETE` được `access.users`.
- [ ] Autogenerate sau baseline không sinh thay đổi.

## 7. Kiểm thử

| Loại | Kịch bản | Kỳ vọng |
|---|---|---|
| Integration | `SELECT extname, extversion FROM pg_extension` | Có `vector` (≥ 0.8.0), `unaccent`, `pg_trgm` |
| Integration | `SELECT f_unaccent(lower('Hợp Đồng Phú Hưng ĐÃ KÝ'))` | `hop dong phu hung da ky` (gồm `đ` → `d`) |
| Integration | `SELECT provolatile FROM pg_proc WHERE proname='f_unaccent'` | `i` |
| Integration | Bảng tạm có `tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(t))) STORED` + truy vấn `websearch_to_tsquery('simple', f_unaccent('bao hanh'))` khớp chuỗi "Bảo hành" | Tạo được; 1 dòng khớp |
| Integration | Chỉ mục trigram trên `f_unaccent(lower(name))`, truy vấn `ILIKE '%phu hung%'` với `enable_seqscan=off` | `EXPLAIN` dùng index |
| Integration | Insert user với `roles = '{admin}'` | Vi phạm `ck_users_roles_valid` |
| Integration | `cwd_app`: `DELETE FROM access.users` | `permission denied` |
| Integration | Upgrade → downgrade → upgrade | Không lỗi |
| Unit | `new_uuid7()` gọi 1.000 lần | Tăng dần theo thời gian, version = 7 |

## 8. Analytics / observability

Không có sự kiện. Migration in ra log revision đã áp dụng (dùng cho bước deploy T00-07). Không ghi dữ liệu người dùng vào log.

## 9. Tham chiếu

- SAD §4.3 (PostgreSQL, pgvector), §7.1, §7.2 (schema, `f_unaccent`), §10.1 (UUID v7), §11.2 (expand/contract), §5 INV-05
- IMPLEMENTATION_PLAN §4 S0 WP-03, §6 (Testcontainers)
- USER_STORIES §8 EN-03 ("migration tự động")

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Giả định | Role `cwd_owner`, `cwd_app` được tạo bởi hạ tầng (T00-03 cho dev; T00-07/T05-08 cho staging/prod), không bởi migration. |
| Đề xuất | UUID v7 sinh ở ứng dụng (PostgreSQL 16 chưa có `uuidv7()`); không đặt `DEFAULT` trong DB. |
| Đề xuất | `cwd_app` không được `DELETE access.users`; xoá người dùng (OQ-019) làm bằng tác vụ quản trị riêng. |
| Đề xuất | Đánh số revision tuần tự; nếu hai PR cùng tạo `0005`, PR sau đổi số khi rebase (ghi trong CONTRIBUTING). |
| OQ-019 | Dữ liệu cá nhân trong `access.users` (tên, email) — tối thiểu hoá theo SAD §11.1; chờ Pháp chế. |
