# T01-05 — Trích xuất văn bản PDF và cắt đoạn (domain)

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-002 · WP-11 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T00-01](T00-01-backend-scaffold.md) |
| Chặn | [T01-06](T01-06-ingestion-worker-embedding.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Viết hai khối thuần có test kỹ mà worker (T01-06) ghép lại. Khối thứ nhất trích văn bản theo trang từ PDF bằng pypdfium2 và đánh dấu trang không có chữ. Khối thứ hai cắt văn bản thành đoạn ~450 token, chồng lấn 60 token, **không vượt quá 2 trang liền kề**, mỗi đoạn có danh sách đoạn con theo trang để trích dẫn về đúng trang.

## 2. Bối cảnh

- SAD §4.2 "Cắt đoạn (chunking)": 450 token đếm bằng tokenizer của bge-m3, chồng 60, ưu tiên cắt ở ranh giới đoạn văn/tiêu đề, tối đa 2 trang, lưu `page_start`, `page_end`, `page_segments`; tiền tố embedding `"{tên tài liệu} — trang {n}: "`.
- ADR-006: mỗi đoạn con theo trang thành một content block gửi cho Claude, nhờ đó `content_block_location` ánh xạ được về trang (IF-03). ADR-012: dùng pypdfium2, chưa có OCR.
- Task này không phụ thuộc DB hay Worker, nên làm song song với T01-04 được.

## 3. Phạm vi

**Trong phạm vi:** `PdfTextExtractorPort` + `PypdfiumTextExtractor`; `TokenCounterPort` + `HFTokenizerCounter`; domain `chunking.py` (thuật toán, tham số, value object); `embedding_input()`; chuẩn hoá văn bản; bộ PDF mẫu cho test (lấy từ T00-09).

**Ngoài phạm vi:** phân loại lỗi mật khẩu/hỏng/scan, ngưỡng 90% trang không chữ, giới hạn 500 trang (T02-08; task này chỉ ném `PdfExtractionError` chung và giữ nguyên exception gốc); embedding và ghi DB (T01-06); OCR (ngoài MVP).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/domain/documents/text.py` | `PageText`, `normalize_page_text(raw) -> str`, `has_text(text) -> bool` |
| `backend/cwd/domain/documents/chunking.py` | `ChunkingParams`, `PageSegment`, `ChunkDraft`, `chunk_pages(...)`, `embedding_input(...)` |
| `backend/cwd/ports/pdf_extractor.py` | `PdfTextExtractorPort`, `ExtractedDocument`, `PdfExtractionError` |
| `backend/cwd/ports/token_counter.py` | `TokenCounterPort` |
| `backend/cwd/adapters/pdf/pypdfium_extractor.py` | `PypdfiumTextExtractor` |
| `backend/cwd/adapters/tokenizer/hf_tokenizer.py` | `HFTokenizerCounter` (thư viện `tokenizers`, nạp `tokenizer.json` của `BAAI/bge-m3` từ đường dẫn cục bộ `TOKENIZER_PATH`, không tải từ mạng lúc chạy) |
| `backend/tests/fixtures/pdf/` | PDF mẫu (§7) |

```python
@dataclass(frozen=True)
class PageText:        page_no: int; text: str; char_count: int; has_text: bool   # page_no bắt đầu từ 1
@dataclass(frozen=True)
class ExtractedDocument: page_count: int; pages: tuple[PageText, ...]

class PdfExtractionError(Exception):
    def __init__(self, message: str, *, cause: BaseException | None): ...   # T02-08 phân loại dựa trên cause

class PdfTextExtractorPort(Protocol):
    def extract(self, path: Path) -> ExtractedDocument: ...

class TokenCounterPort(Protocol):
    def count(self, text: str) -> int: ...                  # không tính token đặc biệt
    def split_at(self, text: str, max_tokens: int) -> tuple[str, str]: ...   # cắt cứng khi một câu quá dài

@dataclass(frozen=True)
class ChunkingParams: target_tokens: int = 450; overlap_tokens: int = 60; max_pages: int = 2; min_tokens: int = 40
@dataclass(frozen=True)
class PageSegment: page_no: int; text: str
@dataclass(frozen=True)
class ChunkDraft:
    ordinal: int; page_start: int; page_end: int; text: str
    page_segments: tuple[PageSegment, ...]; token_count: int

def chunk_pages(pages: Sequence[PageText], counter: TokenCounterPort,
                params: ChunkingParams = ChunkingParams()) -> list[ChunkDraft]: ...
def embedding_input(filename: str, chunk: ChunkDraft) -> str:
    return f"{filename} — trang {chunk.page_start}: {chunk.text}"   # tiền tố chỉ dùng để embed, không lưu vào text
```

### 4.2 Trích xuất (`PypdfiumTextExtractor`)

1. `pdfium.PdfDocument(path)` (không truyền mật khẩu). Exception → `PdfExtractionError(cause=e)`.
2. Với mỗi trang: `page.get_textpage().get_text_bounded()`, đóng `textpage` và `page` ngay sau khi dùng để giữ bộ nhớ thấp với file 500 trang.
3. `normalize_page_text`: chuẩn hoá Unicode **NFC** (quan trọng với dấu tiếng Việt từ PDF); `\r\n` → `\n`; bỏ `\x00`, ký tự điều khiển (trừ `\n`, `\t`); nối dòng bị ngắt giữa câu (dòng không kết thúc bằng `.:;!?` và dòng sau bắt đầu bằng chữ thường thì thay `\n` bằng khoảng trắng); gộp ≥ 3 dòng trống thành 2; bỏ khoảng trắng cuối dòng.
4. `char_count` = số ký tự không phải khoảng trắng. `has_text = char_count ≥ 20` (đề xuất; ngưỡng hiệu chỉnh ở T02-08 bằng bộ mẫu).
5. Không thực thi JavaScript hay nội dung nhúng (pypdfium2 chỉ trích văn bản, SAD §11.1).

### 4.3 Thuật toán cắt đoạn

1. **Đơn vị:** với mỗi trang `has_text`, tách thành khối theo dòng trống (`\n\n`). Dòng ngắn (≤ 80 ký tự), không có dấu kết câu và theo sau là khối thường được coi là **tiêu đề** và gắn với khối sau. Khối > `target_tokens` thì tách theo câu (regex `(?<=[.!?…])\s+`). Câu vẫn > `target_tokens` thì `split_at` cắt cứng. Mỗi đơn vị mang `page_no` và `tokens`.
2. **Gom tham lam:** thêm đơn vị vào đoạn hiện tại khi (a) tổng token sau khi thêm ≤ `target_tokens` **và** (b) số trang khác nhau của đoạn ≤ `max_pages`. Vi phạm một trong hai → đóng đoạn.
3. **Ưu tiên ranh giới:** khi đoạn đã ≥ 70% `target_tokens` và đơn vị kế tiếp là tiêu đề thì đóng đoạn trước tiêu đề.
4. **Chồng lấn:** đoạn mới bắt đầu bằng các đơn vị cuối của đoạn trước, có tổng ≤ `overlap_tokens`, **chỉ khi** các đơn vị đó cùng trang với đơn vị kế tiếp hoặc ở trang liền trước nó. Như vậy đoạn mới vẫn ≤ 2 trang. Không lấy chồng lấn qua trang không có chữ.
5. **Đoạn quá ngắn:** đoạn cuối < `min_tokens` gộp vào đoạn trước nếu không vi phạm (a), (b); không gộp được thì giữ nguyên.
6. **Kết quả:** `text` = các `page_segments[i].text` nối bằng `"\n\n"`; `page_start/page_end` = trang nhỏ nhất/lớn nhất; `ordinal` đánh từ 0; `token_count` = `counter.count(text)`. Hàm có tính tất định (cùng đầu vào → cùng đầu ra).
7. Trang không có chữ không sinh đoạn nào nhưng vẫn có trong `pages` để Worker ghi `docs.pages` và tính `unreadable_pages`.

**Bảng:** pypdfium2 trả theo thứ tự đọc. Các dòng của bảng thường không có dòng trống xen giữa nên nằm trong cùng một khối và không bị cắt rời, trừ khi khối > 450 token. Chất lượng bảng là RSK-004, golden set theo dõi.

## 5. Các bước thực hiện

- [ ] Thêm `pypdfium2>=4.30`, `tokenizers` vào `pyproject.toml`. Tải sẵn `tokenizer.json` bge-m3 vào image (`/opt/models/bge-m3/tokenizer.json`) trong Dockerfile, kèm sha256 kiểm tra.
- [ ] Viết `text.py` (chuẩn hoá, `has_text`) và test.
- [ ] Viết `PypdfiumTextExtractor` và test với PDF mẫu.
- [ ] Viết `HFTokenizerCounter` (`encode(text, add_special_tokens=False)`), cache instance cấp tiến trình.
- [ ] Viết `chunk_pages` theo §4.3 cùng test đơn vị và test thuộc tính (Hypothesis).
- [ ] Viết `embedding_input`.
- [ ] Viết script `backend/scripts/chunk_preview.py <pdf>` in thống kê đoạn (số đoạn, token min/avg/max, phân bố số trang), dùng khi hiệu chỉnh với SME.
- [ ] Đạt coverage ≥ 90% cho `domain/documents/chunking.py` và `text.py` (đề xuất; LG-05 yêu cầu ≥ 70% toàn phần).

## 6. Tiêu chí hoàn thành

- [ ] Mọi đoạn thoả `page_end − page_start ≤ 1` và `token_count ≤ 450 + 60` (giới hạn trên tính cả chồng lấn). Kiểm bằng test thuộc tính với 500 đầu vào ngẫu nhiên.
- [ ] Mọi đoạn văn có chữ của PDF xuất hiện trong ít nhất một đoạn (không mất văn bản). `page_segments` nối lại đúng bằng `text`.
- [ ] PDF mẫu 50 trang trích + cắt xong trong ≤ 10 s trên CPU CI (đề xuất); PDF 500 trang ≤ 90 s và RSS ≤ 1 GB.
- [ ] Văn bản tiếng Việt sau trích xuất ở dạng NFC. Tìm "thanh toán" khớp được nội dung trang mẫu.
- [ ] PDF mở không được ném `PdfExtractionError` có `cause` (để T02-08 phân loại).
- [ ] Domain `chunking.py`, `text.py` không import gì ngoài stdlib và `ports` (import-linter xanh).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `normalize_page_text`: NFD "Hợp đồng" → NFC; nối dòng gãy; giữ `\n\n`; bỏ `\x00` |
| Unit | `chunk_pages` với `FakeTokenCounter` (1 từ = 1 token): 1 trang 100 từ → 1 đoạn; 3 trang × 300 từ → không đoạn nào phủ 3 trang; khối 1.000 từ không dấu câu → cắt cứng; tiêu đề "Điều 5." luôn đứng đầu đoạn khi đoạn trước ≥ 315 token; trang 2 không chữ nằm giữa trang 1 và 3 → không có chồng lấn từ trang 1 sang trang 3 |
| Thuộc tính | Hypothesis: danh sách trang ngẫu nhiên → bất biến ở §6 (≤ 2 trang, token ≤ 510, không mất văn bản, tất định) |
| Integration | `PypdfiumTextExtractor` trên bộ mẫu: `normal_10p.pdf` (10 trang có chữ), `contract_vi_50p.pdf` (50 trang, có bảng), `mixed_scan_12p.pdf` (2 trang ảnh → `has_text=False`), `large_500p.pdf`, `encrypted.pdf` và `broken.pdf` → `PdfExtractionError` |
| Integration | `HFTokenizerCounter` với tokenizer thật: "Thanh toán 30% khi ký hợp đồng" có số token khớp với TEI `/tokenize` (so sánh một lần trong CI có TEI) |

## 8. Analytics / observability

- Không có sự kiện EV. Worker (T01-06) bọc lời gọi bằng span `ingest.extract` (`page_count`, `pages_without_text`) và `ingest.chunk` (`chunk_count`, `avg_tokens`).
- Không log văn bản trích xuất.

## 9. Tham chiếu

SAD §4.2 (chunking), §5 (`Page`, `Chunk`), §7.3 (pipeline nạp), §11.1 (tệp độc hại), IF-03 (ánh xạ trích dẫn), ADR-006, ADR-012; RSK-004.

## 10. Giả định và câu hỏi mở

- Giả định: tokenizer bge-m3 (XLM-R SentencePiece) chạy offline bằng thư viện `tokenizers`. Nếu Pháp chế không cho đóng gói file tokenizer vào image thì dùng TEI `/tokenize` (chậm hơn, phụ thuộc mạng nội bộ).
- Ngưỡng `has_text` (20 ký tự), quy tắc nhận diện tiêu đề và `min_tokens = 40` là đề xuất, cần hiệu chỉnh bằng `chunk_preview.py` trên bộ PDF mẫu của SME (T00-09).
- **OQ-109:** Tiền tố embedding dùng `page_start` hay ghi cả khoảng trang ("trang 12–13")? Đề xuất dùng `page_start`. Đánh giá lại bằng golden set ở T02-02.
- **OQ-110:** Có cần loại bỏ header/footer lặp lại trên mọi trang (ví dụ "Hợp đồng số …/2026 — Trang x/y") trước khi cắt đoạn không? Nội dung lặp làm nhiễu truy xuất toàn văn. Đề xuất để sau S1, quyết định dựa trên kết quả golden set.
