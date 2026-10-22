# T07-05 — UAT, hướng dẫn sử dụng, buổi giới thiệu

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S7 (01/02 – 19/02/2027) — UAT 15/02 – 18/02; chuẩn bị trước Tết |
| Story / WP | LG-07, LG-10 |
| Loại | PO, QA |
| Ước lượng | 3 ngày công (PO 1,5; QA 1,5) |
| Phụ thuộc | [T07-04](T07-04-final-regression.md) (RC đã qua hồi quy, không còn Sev-1/Sev-2 chặn J1); OQ-005 (được dùng tài liệu thật); [T05-08](T05-08-prod-provisioning.md) (môi trường UAT) |
| Chặn | [T07-06](T07-06-gate-review.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

(1) Tổ chức UAT với **≥ 5 người dùng BD** thực hiện hành trình J1 trên **tài liệu thật**, đạt **≥ 4/5 hoàn thành không cần trợ giúp**, lập biên bản UAT cho Trưởng nhóm BD ký (LG-07). (2) Soạn **hướng dẫn sử dụng 1 trang** và tổ chức **buổi giới thiệu** cho đội BD, nêu rõ BRU-006 — người dùng chịu trách nhiệm kiểm chứng câu trả lời tại tài liệu gốc trước khi cam kết với khách hàng (LG-10).

## 2. Bối cảnh

- PRD §6.1 LG-07 (người ký Trưởng nhóm BD), LG-10 (người ký PO); J1 = hành trình lần đầu sử dụng (Blueprint UF-01: đăng nhập SSO → kéo-thả PDF → "Đang xử lý" → "Sẵn sàng" → hỏi → đọc câu trả lời có `[n]` → bấm `[n]` → trang gốc tô sáng; hoàn thành ≤ 3 phút không tính thời gian xử lý).
- IMPLEMENTATION_PLAN S7: UAT "chỉ khi OQ-005 đã cho phép"; IR-07: không bắt đầu pilot trước Tết. Pilot bắt đầu 22/02/2027.
- BRD BRU-006 (Policy, owner Trưởng nhóm BD), BRU-001 (không khuyến nghị kinh doanh), BRU-002 (tài liệu đã gỡ không còn được dùng).

## 3. Phạm vi

**Trong phạm vi:** kế hoạch UAT, chọn người tham gia, kịch bản, môi trường + dữ liệu, điều phối buổi UAT (quan sát không can thiệp), thu kết quả, phân loại lỗi, biên bản; hướng dẫn 1 trang (PDF + trang trợ giúp trong ứng dụng — đề xuất); buổi giới thiệu 45 phút + bản ghi; FAQ.

**Ngoài phạm vi:** time study MET-001 (baseline trước pilot và đo cuối pilot — Business owner, OQ-001; xem OQ-177); kiểm thử chức năng chi tiết ([T07-04](T07-04-final-regression.md)); đào tạo quản trị (vai trò lead/manager chỉ được giới thiệu ngắn).

## 4. Thiết kế chi tiết

### 4.1 Người tham gia và môi trường

- 6 người (dự phòng 1 vắng): ≥ 3 PER-01 chuyên viên BD **chưa từng dùng** prototype/staging, 1–2 PER-02 trưởng nhóm, 1 PER-03 (tuỳ chọn, thêm kịch bản Thống kê). Không chọn người đã tham gia chấm golden set làm người thao tác chính.
- Môi trường: **prod** (đã dọn dữ liệu test tải) hoặc staging có tài liệu thật nếu Bảo mật chỉ cho phép ở đó (đề xuất prod để không phải nạp lại trước pilot). Tài khoản IdP thật thuộc `cwd-users`.
- Dữ liệu: mỗi người mang 2–3 PDF thật của dự án đang làm (đúng mức phân loại cho phép theo OQ-005/BRU-004) + kho chung đã nạp sẵn ~30 tài liệu do Trưởng nhóm BD chọn.
- Thiết bị: máy làm việc của người dùng, Chrome hoặc Edge, ≥ 1280 px; 1 người dùng laptop 1366 px.

### 4.2 Kịch bản UAT

| # | Nhiệm vụ (đọc cho người dùng, không hướng dẫn cách làm) | Tiêu chí hoàn thành | Story/AC liên quan |
|---|---|---|---|
| K1 | Đăng nhập bằng tài khoản công ty | Vào màn hình chính | US-001 |
| K2 | Đưa 2 PDF của bạn vào kho và chờ dùng được | Cả 2 "Sẵn sàng" (hoặc hiểu lý do "Lỗi") | US-002, US-003, US-004 |
| K3 | Hỏi một câu bạn thường phải tra trong các tài liệu đó | Nhận câu trả lời có trích dẫn | US-008, US-010 |
| K4 | Kiểm tra câu trả lời đúng ở trang nào của tài liệu | Mở đúng trang được trích dẫn | US-016 |
| K5 | Hỏi tiếp một câu liên quan (không nhắc lại tên dự án) | Câu trả lời đúng ngữ cảnh | US-014 |
| K6 | Hỏi chỉ trong một tài liệu bạn chọn | Thanh phạm vi đúng, câu trả lời chỉ từ tài liệu đó | US-013 |
| K7 | Hỏi một điều không có trong tài liệu | Nhận "Không tìm thấy…" và hiểu nghĩa | US-011 |
| K8 | Đánh giá câu trả lời (và sao chép vào email nếu US-022 có) | Đánh giá ghi nhận | US-021, US-022 |
| K9 (tuỳ chọn) | Mở lại hội thoại vừa rồi từ Lịch sử | Thấy đủ nội dung | US-017 |
| K10 (PER-03) | Xem số người dùng hoạt động tuần này | Mở được Thống kê | US-019 |

**J1 = K1–K4** (tiêu chí LG-07). Ghi cho mỗi người, mỗi nhiệm vụ: Hoàn thành không trợ giúp / Hoàn thành có gợi ý / Không hoàn thành; thời gian; lỗi gặp; trích nguyên văn bình luận. Quy tắc trợ giúp: người quan sát chỉ trợ giúp sau 2 phút bế tắc hoặc khi người dùng yêu cầu — khi đó nhiệm vụ tính "có trợ giúp".

Sau buổi: bảng hỏi 5 câu thang 1–5 (dễ dùng, tin câu trả lời, kiểm chứng dễ, sẽ dùng hằng tuần, thông điệp lỗi rõ) + 1 câu mở (đề xuất; không dùng SUS đầy đủ để giữ buổi ≤ 45 phút).

### 4.3 Hướng dẫn sử dụng 1 trang

`docs/user-guide/huong-dan-1-trang.md` → xuất PDF A4 một mặt; bản HTML phục vụ từ ứng dụng (liên kết "Hướng dẫn" ở menu tài khoản — đề xuất, cần FE 0,5 ngày, xem OQ-178).

Bố cục (đề xuất):
1. **Công cụ làm gì / không làm gì** — trả lời từ tài liệu trong kho chung, kèm trích dẫn; không đưa khuyến nghị (BRU-001); không dùng tài liệu đã gỡ (BRU-002).
2. **3 bước bắt đầu** — kéo-thả PDF (có chữ chọn được, ≤ 50 MB, ≤ 500 trang) → chờ "Sẵn sàng" → hỏi bằng tiếng Việt hoặc tiếng Anh.
3. **Hỏi thế nào cho tốt** — nêu tên dự án/tài liệu, một ý mỗi câu, hỏi tiếp tự nhiên; chọn tài liệu để giới hạn phạm vi.
4. **Đọc câu trả lời** — chip `[n]` → mở trang gốc; "Không tìm thấy" nghĩa là gì; cảnh báo "không có nguồn".
5. **Khung nổi bật BRU-006:** "Luôn bấm vào trích dẫn để kiểm chứng tại tài liệu gốc trước khi dùng thông tin cho báo giá, hợp đồng hay bất kỳ cam kết nào với khách hàng. Bạn chịu trách nhiệm với thông tin mình sử dụng."
6. **Riêng tư và dữ liệu** — hội thoại chỉ mình bạn xem; tự xoá sau 180 ngày không hoạt động; tài liệu được thấy bởi mọi người dùng được cấp quyền; không đưa tài liệu vượt mức phân loại cho phép (BRU-004).
7. **Lỗi thường gặp** — PDF scan/mật khẩu, "Hệ thống đang bận", giới hạn tốc độ.
8. **Hỗ trợ** — kênh liên hệ, đánh giá 👍/👎 để góp ý.

Review: Trưởng nhóm BD (nội dung BRU-006), Bảo mật (mục 6), QA (đúng hành vi RC).

### 4.4 Buổi giới thiệu (45 phút, đề xuất 18/02 hoặc tuần 22/02 trước ngày mở pilot)

| Phút | Nội dung | Người trình bày |
|---|---|---|
| 0–5 | Mục tiêu pilot, thời gian 22/02 – 19/03, số liệu sẽ đo (WAU, hữu ích) | PO |
| 5–20 | Demo trực tiếp J1 + hỏi tiếp + phạm vi + "Không tìm thấy" | PO/QA |
| 20–28 | **BRU-006 và giới hạn của AI** — ví dụ một câu trả lời cần kiểm chứng | Trưởng nhóm BD |
| 28–33 | Riêng tư, loại tài liệu được đưa vào | Bảo mật thông tin (hoặc PO đọc thông điệp đã duyệt) |
| 33–45 | Hỏi đáp; phát hướng dẫn 1 trang | Tất cả |

Ghi danh sách tham dự; ghi hình (nếu được phép) cho người vắng.

## 5. Các bước thực hiện

- [ ] (Trước 29/01) PO xác nhận OQ-005 cho phép tài liệu thật trong UAT; nếu chưa → báo sponsor: LG-07 không đạt được đúng hạn, phương án dời UAT/Gate.
- [ ] Trưởng nhóm BD chỉ định 6 người, chốt lịch 15–18/02 (mỗi buổi 45 phút, 1 người/buổi, 1 người quan sát + 1 người ghi).
- [ ] QA chuẩn bị phiếu quan sát, bảng hỏi, kho chung 30 tài liệu.
- [ ] Soạn hướng dẫn 1 trang, review, xuất PDF.
- [ ] Chạy UAT; sau mỗi buổi nhập kết quả vào bảng tổng hợp; lỗi → bug tracker có Sev.
- [ ] Lập biên bản UAT, Trưởng nhóm BD ký.
- [ ] Tổ chức buổi giới thiệu; lưu danh sách tham dự.
- [ ] Lưu `docs/evidence/LG-07/`, `docs/evidence/LG-10/`.

## 6. Tiêu chí hoàn thành

- [ ] **LG-07:** ≥ 5 người dùng BD thực hiện J1 (K1–K4) với tài liệu thật; ≥ 4/5 hoàn thành **không cần trợ giúp**; biên bản UAT có chữ ký Trưởng nhóm BD.
- [ ] **LG-10:** hướng dẫn 1 trang được duyệt, có khung BRU-006; buổi giới thiệu đã diễn ra (hoặc đã lên lịch trước ngày mở pilot, được PO chấp thuận) — PO ký.
- [ ] Mọi lỗi UAT có Sev; lỗi Sev-1/Sev-2 chuyển [T07-06](T07-06-gate-review.md).

## 7. Kiểm thử

Mẫu **biên bản UAT** (`docs/evidence/LG-07/uat-report.md`):

| Mục | Nội dung |
|---|---|
| Thời gian, môi trường, phiên bản RC (`git-sha`) | |
| Người tham gia (mã ẩn danh P1..P6, persona) | |
| Bảng kết quả K1–K10 × người (✔ không trợ giúp / ◐ có trợ giúp / ✘) + thời gian J1 | |
| Tỷ lệ hoàn thành J1 không trợ giúp | x/5 — Đạt/Không đạt |
| Điểm bảng hỏi trung bình từng câu | |
| Vấn đề phát hiện (mô tả, Sev, ticket, quyết định) | |
| Kết luận UAT: Chấp nhận / Chấp nhận có điều kiện / Không chấp nhận | |
| Chữ ký Trưởng nhóm BD, PO, QA lead | |

## 8. Analytics / observability

- Phiên UAT trên prod tạo sự kiện thật; gắn nhãn thời gian UAT trong báo cáo để PO loại khỏi số liệu tuần pilot đầu nếu cần (hoặc tài khoản UAT tạm thuộc `cwd-test` — OQ-161).
- Dùng phễu kích hoạt (EV-01 → EV-05 → EV-08 → EV-09 → EV-12/EV-17) để đối chiếu với quan sát.

## 9. Tham chiếu

- PRD §3.2 (J1), §6.1 LG-07, LG-10, §6.2 phễu; BRD BRU-001, BRU-002, BRU-004, BRU-006, MET-001.
- Blueprint §3.4 UF-01, §3.6.4 (UX writing); IMPLEMENTATION_PLAN §4 S7, Pilot, §5.1 (OQ-005), §8 IR-07.

## 10. Giả định và câu hỏi mở

- Giả định: OQ-005 được quyết trước UAT; tài liệu thật được phép trên môi trường UAT.
- **OQ-177 (mới):** Time study baseline MET-001 (trước pilot, BRD) do ai thực hiện và khi nào? Không có task trong README; nếu không làm trước 22/02 sẽ không đo được KR1.1. Owner: Business owner.
- **OQ-178 (mới):** Hướng dẫn có cần hiển thị trong ứng dụng (liên kết menu) hay chỉ phát PDF/email? Owner: PO.
- OQ-005 (kế thừa) — chặn LG-07.
