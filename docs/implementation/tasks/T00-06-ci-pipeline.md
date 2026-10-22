# T00-06 — Pipeline CI: lint, type, test, image, SBOM, Trivy

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | EN-03, WP-05 |
| Loại | DevOps |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T00-01](T00-01-backend-scaffold.md), [T00-02](T00-02-frontend-scaffold.md) |
| Chặn | [T00-07](T00-07-staging-deploy-nginx.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Mỗi PR và mỗi commit vào `main` chạy tự động: lint + kiểm tra kiểu + kiểm tra hướng phụ thuộc + unit + integration (Testcontainers) cho backend và frontend, build image `cwd-app:<git-sha>`, tạo SBOM (Syft), quét lỗ hổng (Trivy) — Critical/High chặn merge. Đây là nửa CI của EN-03; nửa deploy ở T00-07.

## 2. Bối cảnh

- SAD §13.2 "CI/CD" bước 1–3: lint (ruff, eslint), kiểu (mypy, tsc), import-linter; unit + integration (PostgreSQL thật qua Testcontainers); build image, SBOM, Trivy. Image tag `git-sha`, không `latest`.
- SAD §6.2: lỗ hổng Critical/High chặn release (LG-04); khoá phiên bản.
- USER_STORIES §10 DoD: "CI xanh (lint, kiểu, unit, integration, kiểm tra hướng phụ thuộc)".
- IMPLEMENTATION_PLAN §3: GitHub Actions hoặc GitLab CI theo tổ chức; Semgrep trong danh sách công cụ.

## 3. Phạm vi

**Trong phạm vi:**
- Pipeline (mặc định viết cho **GitHub Actions** `.github/workflows/ci.yml`; nếu tổ chức chọn GitLab thì chuyển sang `.gitlab-ci.yml` cùng job) (đề xuất).
- Job backend, frontend, build image, SBOM, Trivy (image + filesystem), Semgrep (không chặn ở S0).
- Đẩy image vào registry nội bộ/GHCR với tag `git-sha`; lưu SBOM và báo cáo làm artifact.
- Bảo vệ nhánh `main`: bắt buộc PR, CI xanh, 1 reviewer.
- Cache `uv`, `npm`.

**Ngoài phạm vi:**
- Deploy staging, image `cwd-web` (Nginx + SPA) → [T00-07](T00-07-staging-deploy-nginx.md) (job build `cwd-web` được thêm vào pipeline này ở T00-07).
- E2E Playwright sau deploy → task E2E S1/S2 (IMPLEMENTATION_PLAN §6).
- Golden set trong CI → [T02-10](T02-10-golden-set-runner.md).
- ZAP baseline → S5/[T07-03](T07-03-security-testing.md).

## 4. Thiết kế chi tiết

### 4.1 Kích hoạt

`on: pull_request` (mọi nhánh vào `main`), `push` lên `main`, `workflow_dispatch`. `concurrency: ci-${{ github.ref }}`, `cancel-in-progress: true` cho PR.

### 4.2 Job

| Job | Chạy khi | Bước | Chặn merge |
|---|---|---|---|
| `backend-quality` | thay đổi `backend/**` hoặc workflow | `uv sync --frozen` → `ruff check` → `ruff format --check` → `lint-imports` → `mypy cwd` | Có |
| `backend-test` | như trên | `pytest -m "not integration" --cov --cov-fail-under=70` → `pytest -m integration` (Docker có sẵn trên runner; Testcontainers `pgvector/pgvector:0.8.x-pg16`) → xuất `junit.xml`, `coverage.xml` | Có |
| `frontend-quality` | thay đổi `frontend/**` | `npm ci` → `npm run lint` → `npm run typecheck` → `npm run test:coverage` → `npm run build` → upload `frontend/dist` artifact | Có |
| `image-app` | sau `backend-*` xanh | `docker buildx build backend/ -t $REGISTRY/cwd-app:${GIT_SHA} --build-arg CWD_APP_VERSION=${GIT_SHA}`; PR: build không push; `main`: push | Có |
| `sbom` | sau `image-app` | `syft $IMAGE -o cyclonedx-json=sbom-cwd-app.cdx.json`; `syft dir:frontend -o cyclonedx-json` | Không (artifact) |
| `trivy` | sau `image-app` | `trivy image --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed $IMAGE`; `trivy fs --scanners vuln,secret,misconfig --severity CRITICAL,HIGH --exit-code 1 .` | **Có** (LG-04) |
| `semgrep` | mọi PR | `semgrep ci --config p/python --config p/typescript --config p/secrets` | Không ở S0 (báo cáo); chuyển chặn từ S5 (đề xuất) |

Path filter: job vẫn chạy trên `push main` bất kể thay đổi gì, để image `main` luôn có cho deploy.

### 4.3 Quy ước image

- Tag duy nhất `cwd-app:<git-sha 40 ký tự>`; **không** tag `latest` (SAD §13.2). Release prod gắn thêm `vYYYY.MM.DD-N` ở bước phát hành sau (IMPLEMENTATION_PLAN §7).
- Label OCI: `org.opencontainers.image.revision`, `.source`, `.created`.
- Registry: biến `REGISTRY` (registry nội bộ của IT; tạm GHCR private) — chờ IT.

### 4.4 Ngoại lệ Trivy

File `.trivyignore` ở gốc, mỗi dòng có CVE + comment `# lý do, người duyệt, hạn xem lại YYYY-MM-DD`. Thêm ngoại lệ cần Tech lead duyệt trong PR (CODEOWNERS cho `.trivyignore`).

### 4.5 Secret CI

Chỉ cần token push registry ở S0. Không có Claude API key trong CI: test dùng `FakeLLMAdapter` (IMPLEMENTATION_PLAN §6). Secret cấu hình ở mức environment/repo, không in ra log (`::add-mask::`).

### 4.6 Thời gian mục tiêu

PR tổng ≤ 12 phút (đề xuất): job chất lượng BE/FE chạy song song; integration dùng một container PostgreSQL cho cả session test.

## 5. Các bước thực hiện

- [ ] Xác nhận nền tảng CI và registry với IT/Tech lead (ngày 1).
- [ ] Viết `ci.yml` với các job §4.2, cache `astral-sh/setup-uv` và `actions/setup-node` (`cache: npm`).
- [ ] Bật Docker trên runner cho Testcontainers (runner `ubuntu-latest` có sẵn; runner tự host cần Docker).
- [ ] Cài Syft, Trivy bằng action chính thức ghim phiên bản (ví dụ `aquasecurity/trivy-action@<sha>`); ghim action theo commit SHA.
- [ ] Tạo `.trivyignore` rỗng + `CODEOWNERS`.
- [ ] Cấu hình branch protection cho `main`.
- [ ] PR thử: (a) vi phạm import-linter, (b) test fail, (c) thêm dependency có CVE High đã biết — xác nhận đều bị chặn.
- [ ] Thêm badge CI vào `README.md`.

## 6. Tiêu chí hoàn thành

- [ ] PR vào `main` chạy đủ lint, type, import-linter, unit, integration, build image, SBOM, Trivy (EN-03: "CI chạy lint, test, SBOM, Trivy").
- [ ] Image được push với tag `git-sha`, không có tag `latest` trong registry (EN-03).
- [ ] Trivy phát hiện Critical/High → job fail và PR không merge được (LG-04).
- [ ] Coverage `domain` + `application` < 70% → fail (LG-05).
- [ ] SBOM CycloneDX của image và frontend có trong artifact của mỗi build `main`.
- [ ] Ba PR thử ở bước 5 đều bị chặn đúng job.

## 7. Kiểm thử

| Kịch bản | Kỳ vọng |
|---|---|
| PR chỉ sửa `docs/**` | Chỉ job `semgrep` chạy (path filter), PR vẫn merge được |
| PR thêm `import sqlalchemy` vào `cwd/domain` | `backend-quality` fail ở `lint-imports` |
| PR làm hỏng một test integration | `backend-test` fail, có `junit.xml` |
| PR thêm `requests==2.5.0` (CVE cũ) | `trivy fs` fail |
| PR commit chuỗi giống API key | `trivy fs --scanners secret` fail |
| Push `main` | Image `cwd-app:<sha>` có trong registry, SBOM trong artifact |

## 8. Analytics / observability

- Lưu `junit.xml`, `coverage.xml`, SBOM, báo cáo Trivy (SARIF, upload vào tab Security nếu nền tảng hỗ trợ) làm artifact 30 ngày — bằng chứng cho LG-04, LG-05.
- Ghi thời gian chạy pipeline để theo dõi mục tiêu §4.6.

## 9. Tham chiếu

- SAD §6.2 (chính sách phụ thuộc), §11.1 (chuỗi cung ứng, kiểm thử bảo mật), §13.2 (CI/CD)
- USER_STORIES §8 EN-03, §10 DoD
- IMPLEMENTATION_PLAN §3, §4 S0 WP-05, §6, §7
- PRD LG-04, LG-05

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Giả định | Runner có Docker (Testcontainers + build image). Runner tự host trong mạng nội bộ có thể cần proxy để kéo image. |
| Đề xuất | GitHub Actions làm mặc định; job thiết kế độc lập công cụ để chuyển GitLab CI dễ. |
| Đề xuất | Semgrep không chặn ở S0, chặn từ S5 với quy tắc đã tinh chỉnh. |
| Câu hỏi | Registry image nội bộ của IT (Harbor/GitLab Registry?) — cần trước 02/11 để T00-07 kéo image về VM staging. |
| OQ-030 | Danh sách giấy phép từ SBOM chuyển Pháp chế review trước go-live. |
