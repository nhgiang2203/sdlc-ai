# T00-02 — Khởi tạo khung frontend (Vite, TS, lint ranh giới)

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | WP-01, WP-08 |
| Loại | FE |
| Ước lượng | 1 ngày công |
| Phụ thuộc | — |
| Chặn | [T00-06](T00-06-ci-pipeline.md), [T00-10](T00-10-design-system-appshell.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Dựng `frontend/` là SPA React 18 + TypeScript strict trên Vite, đúng cấu trúc `src/{app,features,design-system,lib}` của Blueprint §3.1.2, với quy tắc phụ thuộc giữa các vùng **được ép bằng `eslint-plugin-boundaries`**, cùng bộ test Vitest chạy được — để T00-10 và mọi task FE sau chỉ việc thêm code.

## 2. Bối cảnh

- SAD §4.1: SPA build tĩnh (Vite) do Nginx phục vụ; không SSR; không CDN công cộng; React Router với 5 route; TanStack Query cho server state, Zustand cho UI state.
- Blueprint §3.1.2: quy tắc `features/*` → `design-system`, `lib`; feature không import feature khác; `design-system` không import `features`.
- IMPLEMENTATION_PLAN §3: eslint + `eslint-plugin-boundaries`, tsc, Vitest + Testing Library; khoá phiên bản bằng `package-lock.json` (SAD §6.2).

## 3. Phạm vi

**Trong phạm vi:**
- `frontend/` khởi tạo bằng Vite template `react-ts`; `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `eslint.config.js`, `vitest` setup.
- Cây `src/` với thư mục rỗng có `index.ts` và một component placeholder `App` render chữ "Chat với tài liệu".
- Proxy dev `/api`, `/auth` → backend `http://localhost:8000`.
- Cài các thư viện nền: `react@18`, `react-dom@18`, `react-router`, `@tanstack/react-query@5`, `zustand`.
- Target trong Makefile gốc.

**Ngoài phạm vi:**
- Token, primitive, AppShell, MSW → [T00-10](T00-10-design-system-appshell.md).
- `lib/api` (fetch client, SSE, problem+json) → [T01-03](T01-03-fe-auth-api-client.md).
- `lib/analytics` → [T01-10](T01-10-analytics-events.md).
- Playwright/axe E2E → dựng thư mục `e2e/` ở task E2E đầu tiên (S1); job CI ở [T00-06](T00-06-ci-pipeline.md).
- Image Nginx chứa `dist/` → [T00-07](T00-07-staging-deploy-nginx.md).

## 4. Thiết kế chi tiết

### 4.1 Cấu trúc

```text
frontend/
├── index.html                 # <html lang="vi">, không script/style inline (CSP SAD §11.1)
├── package.json  package-lock.json  .nvmrc (22)
├── tsconfig.json  tsconfig.app.json  tsconfig.node.json
├── vite.config.ts  vitest.config.ts (hoặc trong vite.config)  eslint.config.js
└── src/
    ├── main.tsx               # createRoot, import "./app/App"
    ├── vite-env.d.ts          # khai báo ImportMetaEnv (VITE_API_MOCK, VITE_APP_VERSION)
    ├── app/                   # AppShell, router, providers (T00-10)
    ├── features/{auth,documents,chat,viewer,history,stats}/index.ts
    ├── design-system/index.ts
    ├── lib/index.ts
    └── test/setup.ts          # @testing-library/jest-dom
```

### 4.2 TypeScript

`tsconfig.app.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true` (đề xuất), `"jsx": "react-jsx"`, `"moduleResolution": "bundler"`, alias `"paths": {"@/*": ["src/*"]}` (khai báo cả trong `vite.config.ts` `resolve.alias`).

### 4.3 Vite

```ts
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: { port: 5173, proxy: { "/api": "http://localhost:8000", "/auth": "http://localhost:8000" } },
  build: { sourcemap: true, target: "es2022" },      // Chrome/Edge 2 bản mới nhất (NFR-007)
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(process.env.GIT_SHA ?? "dev") },
});
```

Proxy SSE: dev server Vite không buffer phản hồi nên `text/event-stream` đi qua bình thường.
Sourcemap được build nhưng **không** phục vụ công khai ở staging/prod (Nginx chặn `*.map`, T00-07) (đề xuất).

### 4.4 ESLint (flat config)

Plugin: `@eslint/js`, `typescript-eslint` (preset `strictTypeChecked`), `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-plugin-boundaries`.

```js
settings: {
  "boundaries/elements": [
    { type: "app",            pattern: "src/app/**" },
    { type: "feature",        pattern: "src/features/*/**", capture: ["feature"] },
    { type: "design-system",  pattern: "src/design-system/**" },
    { type: "lib",            pattern: "src/lib/**" },
    { type: "mocks",          pattern: "src/mocks/**" },
    { type: "test",           pattern: "src/test/**" },
  ],
},
rules: {
  "boundaries/element-types": ["error", { default: "disallow", rules: [
    { from: "app",           allow: ["feature", "design-system", "lib", "mocks"] },
    { from: "feature",       allow: ["design-system", "lib", ["feature", { feature: "${from.feature}" }]] },
    { from: "design-system", allow: ["design-system"] },
    { from: "lib",           allow: ["lib"] },
    { from: "mocks",         allow: ["lib"] },
  ]}],
  "boundaries/entry-point": ["error", { default: "disallow", rules: [
    { target: ["feature", "design-system", "lib"], allow: "index.ts" },   // chỉ import qua public API
  ]}],
  "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
                                      message: "Dùng react-markdown + DOMPurify (SAD §4.1)" }],
}
```

- `mocks` (MSW, T00-10) chỉ được `app` import qua dynamic import trong dev.
- `dangerouslySetInnerHTML` bị cấm toàn cục (SAD §4.1: không HTML thô).

### 4.5 Scripts `package.json`

| Script | Lệnh |
|---|---|
| `dev` | `vite` |
| `build` | `tsc -b && vite build` |
| `preview` | `vite preview` |
| `lint` | `eslint . --max-warnings 0` |
| `typecheck` | `tsc -b --noEmit` |
| `test` | `vitest run` |
| `test:coverage` | `vitest run --coverage` (provider v8) |

Makefile gốc: `fe-install` (`npm ci`), `fe-lint`, `fe-type`, `fe-test`, `fe-build`, `fe-dev`.

### 4.6 Vitest

`environment: "jsdom"`, `setupFiles: ["src/test/setup.ts"]`, `css: true` (để test đọc được class), `coverage.include: ["src/**"]`, `exclude: ["src/mocks/**", "src/main.tsx"]`.

## 5. Các bước thực hiện

- [ ] `npm create vite@latest frontend -- --template react-ts`; ghim React 18 (`react@^18.3`, `react-dom@^18.3`, `@types/react@^18`).
- [ ] Tạo cây `src/` §4.1, xoá asset mẫu của Vite; `index.html` `lang="vi"`, `<title>Chat với tài liệu</title>`.
- [ ] Cài `react-router`, `@tanstack/react-query`, `zustand`; dev deps eslint/vitest/testing-library/jsdom.
- [ ] Cấu hình TS, Vite, ESLint, Vitest theo §4.2–§4.6.
- [ ] Viết test `App.test.tsx` (render tiêu đề).
- [ ] Viết 2 file "vi phạm" tạm (`features/chat` import `features/documents/x`; `design-system` import `features/...`) để xác nhận lint fail; xoá sau khi xác nhận.
- [ ] Thêm target Makefile, `.nvmrc`.

## 6. Tiêu chí hoàn thành

- [ ] `npm ci && npm run lint && npm run typecheck && npm test && npm run build` xanh (WP-01).
- [ ] `eslint` báo lỗi khi feature A import feature B, khi `design-system` import `features`, và khi import sâu (`@/features/chat/components/X` thay vì `@/features/chat`) (Blueprint §3.1.2).
- [ ] `npm run dev` mở `http://localhost:5173`, request `/api/v1/me` được proxy sang `:8000`.
- [ ] `dist/` không chứa script/style inline trong `index.html` (tương thích CSP `script-src 'self'`).

## 7. Kiểm thử

| Loại | Kịch bản | Kỳ vọng |
|---|---|---|
| Unit | Render `<App/>` | Có text "Chat với tài liệu" |
| Lint | File vi phạm ranh giới (bước 5) | `boundaries/element-types` error |
| Lint | `dangerouslySetInnerHTML` trong component bất kỳ | Error |
| Build | `grep -c "<script>" dist/index.html` (script inline không có `src`) | 0 |

## 8. Analytics / observability

Không phát sự kiện. `VITE_APP_VERSION` (git sha) được đưa vào bundle để T01-10 gắn `app_version` cho sự kiện client (SAD §7.2 `ops.analytics_events.app_version`).

## 9. Tham chiếu

- Blueprint_Design §3.1.2 (phân rã UI, quy tắc phụ thuộc), §2.5 (ràng buộc UX)
- SAD §4.1, §6.2, §11.1 (CSP)
- IMPLEMENTATION_PLAN §3, §4 S0 WP-01, WP-08

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Đề xuất | Node 22 LTS, npm (SAD §6.2 nêu `package-lock.json`). |
| Đề xuất | `react-router` 7 ở chế độ thư viện (tương thích React 18); SAD chỉ ghi "React Router". |
| Đề xuất | Thư mục `src/mocks/` (MSW) và `src/test/` là vùng ngoài 4 vùng của Blueprint; cần Tech lead đồng ý bổ sung vào Blueprint §3.1.2. |
| OQ-022 | Nhu cầu dùng trên điện thoại — ảnh hưởng `build.target` và breakpoint, hiện giữ desktop ≥ 1280px, dùng được ≥ 768px (NFR-007). |
