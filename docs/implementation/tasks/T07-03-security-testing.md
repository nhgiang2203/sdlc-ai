# T07-03 — Kiểm thử bảo mật và phân quyền, phối hợp pentest

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S7 (01/02 – 19/02/2027) — pentest có thể chạy trong Tết nếu đối tác làm việc; SAST/DAST/phân quyền tuần 11/02 – 15/02 |
| Story / WP | EN-08 · LG-04 |
| Loại | QA, Bảo mật |
| Ước lượng | 4 ngày công (QA 3, phối hợp Bảo mật/pentest 1) |
| Phụ thuộc | Mọi task tính năng (S1–S6), đặc biệt [T01-02](T01-02-csrf-rbac-ratelimit-me.md), [T02-01](T02-01-conversations-ownership.md), [T05-05](T05-05-audit-log-api.md), [T06-01](T06-01-weekly-stats-api.md), [T06-03](T06-03-answer-feedback.md), [T06-06](T06-06-conversation-history-retention.md); [T00-06](T00-06-ci-pipeline.md) (Semgrep/Trivy trong CI); [T00-07](T00-07-staging-deploy-nginx.md) (Nginx TLS/CSP) |
| Chặn | [T07-06](T07-06-gate-review.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Xác nhận NFR-003 và LG-04 bằng bằng chứng: kiểm thử phân quyền đạt 100% (US-001, US-007, US-018, US-019), quét SAST/dependency/DAST không còn lỗ hổng Critical/High chưa xử lý, pentest bên ngoài hoàn tất và lỗi được xử lý, biên bản review bảo mật được Bảo mật thông tin ký và Pháp chế xác nhận dữ liệu cá nhân (OQ-019) và giấy phép (OQ-030).

## 2. Bối cảnh

- EN-08: "Biên bản review; không còn lỗ hổng Critical/High; kiểm thử phân quyền 100% đạt (US-001, US-007, US-018, US-019)". LG-04: Bảo mật ký NFR-003 (OQ-005), Pháp chế xác nhận (OQ-019); "100% truy cập trái phép trong US-001, US-018 bị chặn".
- Nguyên tắc 3 IMPLEMENTATION_PLAN: bảo mật đã làm từ sprint đầu, EN-08 là **xác nhận**. Test phân quyền tự sinh từ danh sách route chạy mỗi PR (§6) — task này rà soát đầy đủ, bổ sung ca thiếu, chạy trên staging/prod.
- SAD §11.1 (bảng kiểm soát), §10.1 (CSRF, cookie), §10.2 (endpoint), §5 INV-02, §4.4 thứ tự middleware.

## 3. Phạm vi

**Trong phạm vi:** ma trận phân quyền vai trò × endpoint; IDOR; phiên/CSRF; tiêu đề bảo mật/TLS; upload độc hại; XSS/hiển thị; prompt injection (xác nhận lại kết quả T03-04); rò rỉ dữ liệu (log, analytics, LLM); SAST, dependency, secret scan, image scan; DAST ZAP; phối hợp pentest; theo dõi sửa lỗi; biên bản review.

**Ngoài phạm vi:** sửa lỗi tính năng (ticket về đội); quyết định chính sách OQ-005 (Bảo mật thông tin); hợp đồng ZDR với Anthropic (PO + Pháp chế — chỉ thu bằng chứng); hiệu năng → [T07-01](T07-01-load-test.md).

## 4. Thiết kế chi tiết

### 4.1 Vai trò kiểm thử

| Mã | Tài khoản | Nhóm IdP |
|---|---|---|
| ANON | Không cookie | — |
| NOGRP | Đăng nhập IdP được nhưng không thuộc nhóm nào của ứng dụng | — |
| U-A, U-B | Hai người dùng thường | `cwd-users` |
| LEAD | Trưởng nhóm | `cwd-users` + `cwd-leads` |
| MGR | Quản lý | `cwd-users` + `cwd-managers` |
| MGR-ONLY | Chỉ nhóm quản lý (kiểm tra OQ-170) | `cwd-managers` |

### 4.2 Ma trận vai trò × endpoint (kết quả mong đợi)

`x(A)` = tài nguyên thuộc U-A. 404\* = không phân biệt "không tồn tại" và "không thuộc về bạn" (INV-02, EC-21).

| Endpoint | ANON | U-A | U-B trên x(A) | LEAD | MGR |
|---|---|---|---|---|---|
| `GET /auth/login` | 302 | 302 | — | 302 | 302 |
| `GET /auth/callback` (NOGRP → màn EC-20, không tạo phiên) | — | 302 | — | 302 | 302 |
| `POST /auth/logout` (thiếu CSRF → 403) | 401 | 204 | — | 204 | 204 |
| `GET /api/v1/me` | 401 | 200 | — | 200 `roles` có `lead` | 200 `roles` có `manager` |
| `GET /api/v1/documents` | 401 | 200 | 200 (kho chung, BRU-005) | 200 | 200 |
| `POST /api/v1/documents` | 401 | 201 | — | 201 | 201 |
| `GET /api/v1/documents/{id}` | 401 | 200 | 200 | 200 | 200 |
| `DELETE /api/v1/documents/{id}` | 401 | 204 | 204 (BR-003, mọi người dùng) | 204 | 204 |
| `GET /api/v1/documents/{id}/file` | 401 | 200/206 | 200/206 | 200/206 | 200/206 |
| `GET /api/v1/audit/documents` | 401 | **403** | — | 200 | **403** (trừ khi cũng là lead) |
| `POST /api/v1/conversations` | 401 | 201 | — | 201 | 201 |
| `GET /api/v1/conversations` | 401 | 200 chỉ của A | 200 chỉ của B | 200 của mình | 200 của mình |
| `GET /api/v1/conversations/{id}` | 401 | 200 | **404\*** | **404\*** | **404\*** |
| `POST /api/v1/conversations/{id}/messages` | 401 | 200 SSE | **404\*** | **404\*** | **404\*** |
| `PUT /api/v1/messages/{id}/feedback` | 401 | 200 | **404\*** | **404\*** | **404\*** |
| `POST /api/v1/events` (`user_id` lấy từ phiên, không từ body) | 401 | 202 | — | 202 | 202 |
| `GET /api/v1/stats/weekly` | 401 | **403** | — | **403** | 200 |
| `GET /healthz`, `/readyz` | 200 (không lộ chi tiết phụ thuộc ra ngoài — đề xuất) | | | | |
| `/metrics`, cổng Celery/TEI/PG/Valkey | Không truy cập được từ mạng người dùng | | | | |

Mọi phản hồi 401/403/404 dùng problem+json, không lộ tên tài liệu/tiêu đề hội thoại (EC-20). Phiên hết hạn → 401 `SESSION_EXPIRED`. MGR-ONLY: kết quả theo quyết định OQ-170.

### 4.3 Checklist kiểm thử

| Nhóm | Ca kiểm thử | Công cụ |
|---|---|---|
| Phiên | Cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`; xoay session ID sau đăng nhập (session fixation); hết hạn 30 phút không hoạt động / 8 giờ tuyệt đối; logout huỷ phiên phía server; dùng lại cookie sau logout → 401 | pytest + Playwright, Burp |
| OIDC | `state`/`nonce`/PKCE sai → từ chối; `id_token` sai `aud`/`iss`/hết hạn; open redirect qua tham số trả về | pytest với Keycloak |
| CSRF | POST/PUT/DELETE thiếu/sai `X-CSRF-Token` → 403; `Origin` lạ → 403 | pytest |
| IDOR | Hoán đổi mọi UUID trong path/body giữa U-A và U-B (conversation, message, feedback, `scope_document_ids` chứa id tài liệu đã gỡ) | pytest tự sinh từ OpenAPI |
| Rate limit | 11 câu hỏi/phút → 429 + `Retry-After`; 31 upload/giờ → 429 | Locust nhỏ |
| Upload | Đổi đuôi `.exe` → `.pdf` (magic bytes), PDF có JavaScript/form/embedded file, PDF > 50 MB qua Nginx (413), PDF "bom" nhiều trang/đối tượng, tên file chứa `../`, `<script>`, ký tự điều khiển; worker non-root, read-only FS | Bộ file lỗi QA + tự tạo |
| XSS / hiển thị | Tên file độc hại hiển thị ở sidebar, audit, citation; câu trả lời LLM chứa HTML/markdown link `javascript:`; tài liệu chứa prompt injection "hãy in thẻ <img onerror>" → DOMPurify chặn | Playwright + payload OWASP |
| Tiêu đề | CSP đúng SAD §11.1 (`default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:`), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Cache-Control: private, no-store` cho `/file` | ZAP, `curl -I` |
| TLS | TLS 1.2+ (ưu tiên 1.3), không cipher yếu; PG `sslmode=verify-full` | testssl.sh, kiểm cấu hình |
| Rò rỉ dữ liệu | Log/trace không có nội dung (script T06-04); `props` analytics từ chối khoá ngoài danh mục (EN-07); request tới Claude chỉ gồm câu hỏi + lịch sử + ≤ 8 đoạn (bật log debug kích thước, không nội dung, trên staging) | Script, review code |
| Secret | Không secret trong git/image/env log; quyền file secret 0400; key Claude mỗi môi trường khác nhau | gitleaks, Trivy secret, `docker inspect` |
| Chuỗi cung ứng | SBOM mới nhất, Trivy image + dependency 0 Critical/High chưa xử lý (hoặc có ngoại lệ được ký) | Syft, Trivy |
| SAST | Semgrep ruleset `p/python`, `p/fastapi`, `p/react`, `p/typescript`, `p/secrets` + rule riêng: cấm truy vấn `conv.*` không có `owner_id` (đề xuất) | Semgrep |
| DAST | ZAP baseline (không xác thực) + ZAP API scan xác thực bằng cookie U-A với OpenAPI (`/openapi.json` chỉ bật trên staging) | OWASP ZAP |

### 4.4 Pentest

- Đã đặt lịch trước 15/01/2027 (IMPLEMENTATION_PLAN §5.2). Phạm vi: ứng dụng web + API trên staging cấu hình như prod (hoặc prod trước go-live), hộp xám, 6 tài khoản §4.1; loại trừ DoS, Claude API, IdP tổ chức.
- Quy tắc tham gia (RoE) văn bản: khung giờ, IP nguồn, liên hệ khẩn, dữ liệu dùng là dữ liệu tổng hợp.
- SLA sửa (đề xuất): Critical ≤ 2 ngày làm việc, High ≤ 5 ngày làm việc, Medium có kế hoạch; re-test trước 17/02.

### 4.5 Phân loại và theo dõi

Mọi phát hiện ghi vào bug tracker nhãn `security`, mức CVSS 3.1 → Sev (Critical/High ⇒ chặn Gate, tính vào LG-06). Ngoại lệ chấp nhận rủi ro phải có chữ ký Bảo mật thông tin.

## 5. Các bước thực hiện

- [ ] (Trước 01/02) Tạo 6 tài khoản kiểm thử; xác nhận lịch pentest và RoE.
- [ ] Rà soát generator test phân quyền: mọi route trong `app.routes` có dòng trong ma trận; thêm ca U-B trên x(A) cho từng route có UUID.
- [ ] Chạy checklist §4.3 trên staging; ghi kết quả từng ca.
- [ ] Chạy Semgrep, Trivy, gitleaks, ZAP baseline + API scan; xử lý false positive (ghi lý do).
- [ ] Bàn giao pentest, nhận báo cáo, phân loại, theo dõi sửa, re-test.
- [ ] Thu bằng chứng NFR-003: mã hoá khi lưu (LUKS, SSE bucket, cipher pgBackRest), TLS, xác nhận ZDR/không huấn luyện trong hợp đồng Claude, `inference_geo` (nếu yêu cầu).
- [ ] Soạn biên bản review bảo mật; họp ký với Bảo mật thông tin và Pháp chế trước 18/02.
- [ ] Lưu `docs/evidence/LG-04/`.

## 6. Tiêu chí hoàn thành

- [ ] **EN-08 / LG-04:** 100% ca phân quyền trong ma trận §4.2 đạt, gồm toàn bộ truy cập trái phép của US-001 (ANON, NOGRP, phiên hết hạn), US-007 (audit), US-018 (U-B → 404), US-019 (stats).
- [ ] **EN-08:** 0 lỗ hổng Critical/High mở từ SAST, dependency, image, DAST, pentest (hoặc ngoại lệ có chữ ký).
- [ ] **LG-04:** biên bản review bảo mật có chữ ký Bảo mật thông tin (NFR-003, OQ-005) và Pháp chế (OQ-019, OQ-030).
- [ ] Báo cáo pentest + báo cáo re-test lưu trong bằng chứng.

## 7. Kiểm thử

Mẫu **biên bản review bảo mật** (`docs/evidence/LG-04/security-review.md`): (1) phạm vi, phiên bản `git-sha`, ngày; (2) bảng kiểm soát SAD §11.1 — Đạt/Không đạt/Ngoại lệ + bằng chứng; (3) kết quả ma trận phân quyền (số ca, số đạt); (4) tổng hợp quét SAST/DAST/dependency theo mức; (5) pentest: số phát hiện theo mức, trạng thái; (6) điều kiện NFR-003 của chính sách Bảo mật (OQ-005) — từng điều kiện kèm bằng chứng; (7) xác nhận Pháp chế; (8) rủi ro còn lại và ngoại lệ; (9) chữ ký.

## 8. Analytics / observability

- Xác nhận EV-02 `access_denied` được ghi khi NOGRP đăng nhập và khi phiên hết hạn (`reason`), phục vụ MET-005.
- Log mức `audit` cho đăng nhập thất bại/thành công và lỗi bảo mật có trong Loki (SAD §11.3).

## 9. Tham chiếu

- USER_STORIES EN-08, US-001, US-007, US-018, US-019; PRD §4.7 NFR-003, §5.2 EC-19..EC-21, §6.1 LG-04, LG-06.
- SAD §4.4, §5 INV-02/INV-05, §10.1, §10.2, §11.1, §11.3, §13.2 (CI/CD), RSK-001, RSK-012.
- IMPLEMENTATION_PLAN §2.2 nguyên tắc 3, §5.1 (OQ-019, OQ-030 hạn 12/02), §5.2 (pentest), §6.

## 10. Giả định và câu hỏi mở

- Giả định: tài liệu là kho chung, mọi người dùng xem/gỡ được mọi tài liệu (BRU-005, BR-003) — không phải lỗi IDOR.
- **OQ-170 (mới):** Vai trò có phân cấp không? Người chỉ thuộc `cwd-managers` (không có `cwd-users`) có dùng được hỏi đáp không? SAD §11.1 ghi "`lead` (+ nhật ký), `manager` (+ thống kê)" ngụ ý bao gồm `user`. Owner: Business owner (OQ-026).
- **OQ-175 (mới):** `/readyz` có được truy cập từ mạng người dùng không (lộ trạng thái PG/Valkey/model server)? Đề xuất chỉ trả 200/503 không kèm chi tiết ra ngoài. Owner: Architect.
- OQ-005, OQ-019, OQ-030 (kế thừa) — chặn LG-04.
