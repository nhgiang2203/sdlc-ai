# T02-02 — Truy xuất lai (vector + toàn văn + RRF) và rerank

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-008 · WP-21 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T01-06](T01-06-ingestion-worker-embedding.md) |
| Chặn | [T02-05](T02-05-ask-question-sse.md), [T05-07](T05-07-circuit-breaker-degraded.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp application service `RetrieveContext` thực hiện bước 3–7 của pipeline RAG (SAD §4.2): embedding câu hỏi → truy xuất vector top 40 + toàn văn top 40 trong **một câu SQL** → hợp nhất RRF (k = 60) lấy top 30 → rerank bằng `bge-reranker-v2-m3` → giữ tối đa 8 đoạn có điểm ≥ τ_keep. Kết quả là danh sách đoạn có điểm, sẵn sàng đưa vào LLM, cùng `top_score` để cổng "không tìm thấy" dùng.

## 2. Bối cảnh

- ADR-002: RAG lai vì câu hỏi tiếng Việt vừa có diễn đạt khác (AC-US008-2) vừa có mã số/tên riêng cần khớp chính xác; ADR-003: vector + toàn văn cùng bảng `docs.chunks`, lọc trạng thái/phạm vi trong một SQL.
- [T01-06](T01-06-ingestion-worker-embedding.md) đã ghi `docs.chunks` (`embedding vector(1024)`, `tsv` generated từ `f_unaccent(text)`, `page_segments`) và chỉ mục HNSW, GIN.
- INV-01: chỉ chunk của tài liệu `READY`, `removed_at IS NULL` được truy xuất.
- Task này **không** quyết định not_found: chỉ trả điểm. Cổng τ_nf đầy đủ và hiệu chỉnh τ_keep/τ_nf ở [T03-02](T03-02-not-found-gate-calibration.md).

## 3. Phạm vi

**Trong phạm vi:**
- Port `EmbeddingPort.embed_query`, `RerankPort.rerank`, `ChunkSearchPort.hybrid_search`, `ChunkSearchPort.get_passages`.
- Adapter `TEIEmbeddingAdapter` (thêm `embed_query` nếu T01-06 chỉ có `embed_batch`), `TEIRerankAdapter`, `PgChunkSearch`.
- Service `RetrieveContext` + cấu hình tham số.
- Test integration trên PostgreSQL thật, kiểm tra kế hoạch truy vấn dùng chỉ mục.

**Ngoài phạm vi:**
- Lọc theo phạm vi tài liệu người dùng chọn (`scope_document_ids`) → [T04-03](T04-03-scope-filter-api.md). S2 **luôn tìm toàn kho**; tham số `scope_ids` có trong chữ ký nhưng T02-05 luôn truyền `None`.
- Chế độ suy giảm (TEI lỗi → chỉ toàn văn) và circuit breaker → [T05-07](T05-07-circuit-breaker-degraded.md). S2: TEI lỗi → ném `RetrievalUnavailableError`.
- Viết lại câu hỏi hỏi tiếp → [T05-01](T05-01-follow-up-rewrite-history.md).
- Cổng τ_nf, hiệu chỉnh τ → [T03-02](T03-02-not-found-gate-calibration.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `backend/cwd/ports/retrieval.py` | `EmbeddingPort`, `RerankPort`, `ChunkSearchPort`, DTO |
| `backend/cwd/adapters/tei/embedding.py` | `TEIEmbeddingAdapter.embed_query` |
| `backend/cwd/adapters/tei/rerank.py` | `TEIRerankAdapter` |
| `backend/cwd/adapters/postgres/chunk_search.py` | `PgChunkSearch` (SQL lai) |
| `backend/cwd/application/qa/retrieval.py` | `RetrieveContext`, `RetrievalResult` |
| `backend/cwd/config/retrieval.py` | `RetrievalSettings` (pydantic-settings) |
| `backend/tests/integration/test_hybrid_search.py`, `backend/tests/unit/test_retrieve_context.py` | Test |

### 4.2 Port và DTO

```python
@dataclass(frozen=True)
class PageSegment:
    page_no: int
    text: str

@dataclass(frozen=True)
class Candidate:              # kết quả SQL lai
    chunk_id: UUID
    rrf_score: float
    vec_rank: int | None
    fts_rank: int | None

@dataclass(frozen=True)
class Passage:                # đoạn đầy đủ để rerank và gửi LLM
    chunk_id: UUID
    document_id: UUID
    document_title: str       # filename hiện tại → document_title_snapshot
    page_start: int
    page_end: int
    text: str
    page_segments: tuple[PageSegment, ...]

@dataclass(frozen=True)
class ScoredPassage:
    passage: Passage
    rerank_score: float       # [0, 1], raw_scores=false
    rrf_rank: int

@dataclass(frozen=True)
class RetrievalResult:
    passages: tuple[ScoredPassage, ...]   # ≤ top_k_final, giảm dần theo rerank_score, đã lọc τ_keep
    top_score: float | None               # điểm rerank cao nhất TRƯỚC khi lọc τ_keep; None nếu 0 ứng viên
    candidate_count: int                  # số ứng viên sau RRF (≤ 30)
    timings_ms: dict[str, int]            # embed, search, fetch, rerank

class EmbeddingPort(Protocol):
    async def embed_query(self, text: str) -> list[float]: ...          # 1024 chiều, normalize

class RerankPort(Protocol):
    async def rerank(self, query: str, texts: Sequence[str]) -> list[float]: ...  # điểm theo đúng thứ tự texts

class ChunkSearchPort(Protocol):
    async def hybrid_search(self, *, qvec: list[float], qtext: str, scope_ids: Sequence[UUID] | None,
                            k_vec: int, k_fts: int, rrf_k: int, limit: int) -> list[Candidate]: ...
    async def get_passages(self, chunk_ids: Sequence[UUID]) -> list[Passage]: ...  # chỉ READY, chưa gỡ
```

### 4.3 Tham số (`RetrievalSettings`, biến môi trường `CWD_RETRIEVAL_*`)

| Tham số | Giá trị khởi điểm | Ghi chú |
|---|---|---|
| `k_vec` / `k_fts` | 40 / 40 | SAD §4.2 bước 4, 5 |
| `rrf_k` | 60 | Bước 6 |
| `rrf_limit` | 30 | Số cặp gửi rerank (RSK-009: giới hạn 30) |
| `top_k_final` | 8 | Bước 7, PR-02 (≤ 8 đoạn ra ngoài) |
| `tau_keep` | 0,05 (đề xuất) | Hiệu chỉnh ở T03-02 |
| `hnsw_ef_search` | 80 | `SET LOCAL` |
| `hnsw_iterative_scan` | `relaxed_order` | `SET LOCAL` |
| `embed_timeout_s` / `rerank_timeout_s` | 2 / 2 | IF-04, IF-05; 1 retry sau 200 ms (§11.2) |
| `params_version` | `ret.v1` | Ghi vào trace và báo cáo golden set để so sánh lần chạy |

### 4.4 SQL truy xuất lai (`PgChunkSearch.hybrid_search`)

Dựa trên SAD §7.2, điều chỉnh hai điểm (đề xuất, xem §10): (1) tách `ORDER BY … LIMIT` vào subquery để planner dùng chỉ mục HNSW, đánh số hạng ở ngoài; (2) truy vấn toàn văn dùng **OR** giữa các từ thay vì AND của `websearch_to_tsquery`, để câu hỏi tự nhiên dài vẫn khớp.

```sql
SET LOCAL hnsw.ef_search = 80;
SET LOCAL hnsw.iterative_scan = relaxed_order;

WITH scope AS (
  SELECT id FROM docs.documents
  WHERE status = 'READY' AND removed_at IS NULL
    AND (CAST(:scope_ids AS uuid[]) IS NULL OR id = ANY(:scope_ids))
),
vec AS (
  SELECT id, row_number() OVER (ORDER BY dist) AS r
  FROM (
    SELECT c.id, c.embedding <=> CAST(:qvec AS vector) AS dist
    FROM docs.chunks c
    WHERE c.document_id IN (SELECT id FROM scope)
    ORDER BY c.embedding <=> CAST(:qvec AS vector)
    LIMIT :k_vec
  ) v
),
q AS (
  SELECT CASE WHEN numnode(p) = 0 THEN NULL
              ELSE replace(p::text, ' & ', ' | ')::tsquery END AS q
  FROM plainto_tsquery('simple', f_unaccent(:qtext)) p
),
fts AS (
  SELECT id, row_number() OVER (ORDER BY rank DESC) AS r
  FROM (
    SELECT c.id, ts_rank_cd(c.tsv, q.q) AS rank
    FROM docs.chunks c, q
    WHERE q.q IS NOT NULL AND c.tsv @@ q.q
      AND c.document_id IN (SELECT id FROM scope)
    ORDER BY rank DESC
    LIMIT :k_fts
  ) f
)
SELECT id,
       sum(1.0 / (:rrf_k + r))                       AS rrf,
       min(r) FILTER (WHERE src = 'vec')             AS vec_rank,
       min(r) FILTER (WHERE src = 'fts')             AS fts_rank
FROM (SELECT id, r, 'vec' AS src FROM vec UNION ALL SELECT id, r, 'fts' FROM fts) u
GROUP BY id
ORDER BY rrf DESC
LIMIT :rrf_limit;
```

- Chạy trong một giao dịch read-only; `SET LOCAL` chỉ ảnh hưởng giao dịch đó.
- `get_passages`: `SELECT c.id, c.document_id, d.filename, c.page_start, c.page_end, c.text, c.page_segments FROM docs.chunks c JOIN docs.documents d ON d.id = c.document_id WHERE c.id = ANY(:ids) AND d.status = 'READY' AND d.removed_at IS NULL` (kiểm lại INV-01 lần hai vì tài liệu có thể bị gỡ giữa hai câu).
- Câu hỏi chỉ có stop-word / ký tự đặc biệt → `q IS NULL` → chỉ có nhánh vector.

### 4.5 Logic `RetrieveContext.execute(question: str, scope_ids: None) -> RetrievalResult`

1. `qvec = await embedding.embed_query(question)` (không thêm tiền tố tên tài liệu; tiền tố chỉ dùng cho đoạn khi ingest).
2. `candidates = await search.hybrid_search(...)`; rỗng → trả `RetrievalResult(passages=(), top_score=None, candidate_count=0)`.
3. `passages = await search.get_passages([c.chunk_id ...])`, giữ thứ tự RRF.
4. Văn bản rerank: `f"{p.document_title} — tr. {p.page_start}–{p.page_end}: {p.text}"` (khớp tiền tố khi embed — đề xuất). TEI `POST /rerank {query, texts, raw_scores: false, truncate: true}` → `[{index, score}]`, adapter sắp lại theo `index`.
5. Sắp giảm theo `rerank_score`, tie-break theo `rrf_rank`; `top_score = scores[0]`; lọc `score ≥ tau_keep`; cắt `top_k_final`.
6. Không giới hạn số đoạn mỗi tài liệu (US-012, ghi chú kỹ thuật).

Lỗi: `httpx.TimeoutException`/5xx sau 1 retry ở embed hoặc rerank → `RetrievalUnavailableError(stage)`; lỗi CSDL → để nổi lên (T02-05 trả `internal`).

## 5. Các bước thực hiện

- [ ] Định nghĩa port + DTO trong `ports/retrieval.py`.
- [ ] Viết `TEIRerankAdapter` (httpx AsyncClient dùng chung, header token tĩnh IF-05, timeout 2 s, 1 retry 200 ms); bổ sung `embed_query` cho `TEIEmbeddingAdapter`.
- [ ] Viết `PgChunkSearch` với SQL §4.4 (dùng `pgvector.sqlalchemy`), kiểm `EXPLAIN` dùng `chunks_embedding_hnsw` và `chunks_tsv_gin`.
- [ ] Viết `RetrieveContext` + `RetrievalSettings`.
- [ ] Viết fixture dữ liệu: 3 tài liệu READY, 1 FAILED, 1 PROCESSING với chunk giả (vector từ TEI CPU trong compose hoặc vector cố định cho test).
- [ ] Đo thời gian từng giai đoạn trên staging với kho mẫu; ghi số vào PR.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US008-2:** nhóm câu "diễn đạt khác" trong golden set v0 (chạy bằng [T02-10](T02-10-golden-set-runner.md)) có đoạn chứa đáp án nằm trong top 8 sau rerank ở ≥ 80% câu (đề xuất ngưỡng kiểm truy xuất S2; ngưỡng đầu-cuối nghiệm thu ở NFR-002/T03-01). Test unit: câu "hạn chót nộp hồ sơ" tìm ra đoạn "thời hạn đệ trình" trên fixture tiếng Việt.
- [ ] INV-01: test integration chứng minh chunk của tài liệu `FAILED`, `PROCESSING`, `REMOVED` không bao giờ xuất hiện.
- [ ] Câu có mã hợp đồng (ví dụ "HĐ-2026/045") hoặc số tiền tìm ra đúng đoạn nhờ nhánh toàn văn, kể cả khi gõ không dấu.
- [ ] `EXPLAIN` cho thấy nhánh vector dùng chỉ mục HNSW (test chạy với `enable_seqscan = off` trên fixture ≥ 2.000 chunk).
- [ ] Trên staging: p90 tổng bước 3–7 ≤ 1,2 s với 30 cặp rerank CPU (ngân sách SAD §4.2; số liệu ghi vào PR).
- [ ] Trả `top_score` trước khi lọc τ_keep để T03-02 dùng.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit (`RetrieveContext` với fake port) | RRF trùng id cộng điểm; sắp theo rerank, tie-break RRF; lọc τ_keep; cắt 8; 0 ứng viên → `top_score=None`; TEI timeout → `RetrievalUnavailableError("rerank")` |
| Unit (SQL builder) | Câu chỉ ký tự đặc biệt → không lỗi, chỉ nhánh vector |
| Integration (Testcontainers pgvector) | INV-01; có dấu / không dấu cho cùng kết quả toàn văn; `get_passages` loại tài liệu vừa chuyển `REMOVED` |
| Integration (TEI compose) | `rerank` trả đúng thứ tự `index`; `truncate` không lỗi với đoạn dài |
| Hiệu năng sơ bộ | 20 câu tuần tự trên staging, đo `timings_ms` |

## 8. Analytics / observability

- Span `qa.retrieve` với con `embed`, `vector_search`+`fts_search` (một span `hybrid_search`), `fetch_passages`, `rerank`; thuộc tính: `candidate_count`, `kept_count`, `top_score`, `params_version`. **Không** gắn câu hỏi hoặc văn bản đoạn.
- Metric `cwd_retrieval_seconds{stage}` (histogram) — khai báo ở đây, dashboard ở T06-04.
- Không có sự kiện EV riêng (EV-08/EV-09 do T02-05 ghi).

## 9. Tham chiếu

- [SAD.md](../../requirements/SAD.md) §4.2 (bước 3–7), §4.3 (pgvector), §5 INV-01, §7.2 (truy vấn lai), §10.4 IF-04/IF-05, §11.2, ADR-002, ADR-003, ADR-004
- [USER_STORIES.md — US-008, US-012](../../requirements/USER_STORIES.md)
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) S2 WP-21

## 10. Giả định và câu hỏi mở

- Giả định T01-06 đặt tên chỉ mục `chunks_embedding_hnsw` (HNSW `vector_cosine_ops`, m=16, ef_construction=64) và `chunks_tsv_gin`; nếu khác, cập nhật test `EXPLAIN`.
- Giả định TEI rerank trả điểm sigmoid [0, 1] khi `raw_scores=false`; τ_keep/τ_nf định nghĩa trên thang này.
- **OQ-T0202-1:** SQL trong SAD §7.2 đặt `row_number() OVER (ORDER BY …)` cùng cấp với `ORDER BY … LIMIT` — planner có thể không dùng HNSW. Đề xuất cập nhật SAD theo dạng subquery ở §4.4.
- **OQ-T0202-2:** `websearch_to_tsquery` nối các từ bằng AND, câu hỏi tự nhiên ≥ 6 từ gần như không khớp đoạn nào → nhánh toàn văn mất tác dụng. Đề xuất OR (như §4.4) và so sánh hai cách trên golden set ở T03-01; cần Architect chốt.
- **OQ-T0202-3:** Có thêm tiền tố tên tài liệu vào văn bản rerank không? Giúp câu hỏi có tên dự án, nhưng có thể làm lệch điểm τ_nf. Đo ở T03-02.
