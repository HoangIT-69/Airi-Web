# airi-web — Hướng dẫn riêng

> Mở rộng `CLAUDE.md` của workspace. **Chỉ khai báo phần khác hoặc bổ sung.**
> Mục không khai báo ở đây → theo workspace.
> Không được nới lỏng mục Bảo mật và Chất lượng — chỉ được siết chặt hơn.

---

## 1. Nhận dạng

| | |
|---|---|
| **Tên** | airi-web |
| **`vendor_id`** | `[giá trị]` — filter này bắt buộc trong **mọi** truy vấn |
| **Người phụ trách** | Đinh Nhật Hoàng  |
| **Bắt đầu** | 2026-10-30 |
| **URL dev** | https:// |
| **URL prod** | https:// |
| **Repo** | https://github.com/ |

## 2. Lệnh

> Điền lệnh **thực tế** của dự án. Khác với workspace thì ghi rõ ở đây.

Chạy riêng trong `infra/` **và** `edge/` (không có `pnpm dev` — dự án không chứa ứng dụng):

```bash
pnpm lint          # = tsc --noEmit
pnpm test          # vitest + aws-cdk-lib/assertions
pnpm test --coverage
pnpm build         # infra: tsc + cdk synth · edge: tsc + wrangler deploy --dry-run (cần edge/dist)
pnpm exec cdk diff -c publicUrl=<PUBLIC_URL>   # infra, trước mọi lần deploy tay
```

Quality gate của dự án = `pnpm lint && pnpm test && pnpm build` trong cả `infra/` và `edge/`.

## 3. Tech stack

| Lớp | Lựa chọn | Ghi chú |
|---|---|---|
| Ứng dụng | AIRI `stage-web` (Vue 3 + Vite) · `server/apps/api`, `server/apps/auth` (Hono, Node) | Mã ở repo AIRI, không ở đây |
| IaC AWS | AWS CDK v2 (TypeScript) | `infra/` |
| Edge | Cloudflare Worker + Workers Assets + R2 (Wrangler) | `edge/` |
| Máy chủ | 1 EC2 `t3.small`, docker compose | `infra/assets/server/` |
| DB / Auth | Postgres 17 (container) · better-auth (trong AIRI) | |
| Cache | Valkey 8 (container) | |
| Testing | vitest | |
| i18n | Không áp dụng | Dự án không có chuỗi hiển thị |
| Deploy | GitHub Actions (AWS OIDC + Cloudflare API token) | `docs/infra/architecture.md` |

## 4. Kiến trúc

### 4a. Cấu trúc thực tế

> Chỉ điền nếu khác chuẩn workspace. Ghi kèm lý do.

Dự án **chỉ chứa hạ tầng** — không có `src/` (xem ADR 0001):

```
infra/
├── bin/app.ts             # Entry CDK: đọc config, khai báo 2 stack
├── lib/config.ts          # Nơi DUY NHẤT đọc context/env; mọi hằng số hạ tầng
├── lib/registry-stack.ts  # ECR + role GitHub OIDC
├── lib/app-stack.ts       # VPC + Server
├── lib/constructs/        # network · server (EC2, EIP, SSM params, snapshot)
├── assets/server/         # compose.yml · Caddyfile · deploy.sh — chạy trên EC2
└── test/
edge/
├── src/index.ts           # Worker: proxy backend, phục vụ asset, R2 cho file lớn
├── scripts/               # split-large-assets.ts (chạy trong CI)
├── wrangler.jsonc
└── test/
.github/workflows/deploy.yml
```

### 4b. Danh mục module

> Claude dùng bảng này để **không tạo trùng** và **biết import từ đâu**.
> Thêm module mới thì cập nhật bảng này trong cùng commit.

| Module | Export công khai (`index.ts`) | Domain |
|---|---|---|
| `auth` | `useAuth`, `authService`, `AuthGuard` | Xác thực và phiên |
| | | |

### 4c. Component dùng chung

| Component | Props chính | Ghi chú |
|---|---|---|
| | | |

## 5. Pattern đã chốt

> Pattern **đã quyết định** cho dự án này. Claude dùng pattern này, không sáng tạo cái mới.

```
// Lấy dữ liệu:
// Xử lý lỗi:
// Đặt tên file:
```

## 6. Checklist bảo mật riêng

> Bổ sung cho phần Bảo mật của workspace, không thay thế.

- [ ] Mọi bảng có RLS policy — kiểm tra trên dashboard, không chỉ đọc code
- [ ] `SERVICE_ROLE_KEY` không lọt vào bundle client
- [ ] Mọi truy vấn có filter `vendor_id`
- [ ] Mọi route ghi dữ liệu có kiểm tra phiên và quyền
- [ ] EC2 chỉ mở 80/443, không SSH — có test kiểm tra
- [ ] Caddy trả 403 khi thiếu `X-Origin-Auth`; Worker luôn ghi đè header này
- [ ] Cloudflare Access bật cho `workers.dev`, policy chỉ email chủ sở hữu
- [ ] Bí mật nằm trong SSM SecureString / Worker secret / `secrets.env` (600) — không trong repo, không trong `cdk.json`
- [ ] `cdk diff` được đọc trước mỗi lần deploy tay

## 7. Biến môi trường

> Giá trị thật → `.env.local` (không commit). Danh mục → `.env.example` (commit).

Dự án không đọc `.env`. Cấu hình deploy qua CDK context (`cdk.json` hoặc `-c key=value`):
`region`, `publicUrl` (bắt buộc), `imageTag`, `instanceType`, `githubRepo`, `githubOidcProviderArn`.
Worker: var `ORIGIN_URL`, secret `ORIGIN_SECRET`. Bí mật runtime — xem `docs/infra/architecture.md`.

## 8. Nên / Không nên

| ✅ Nên | ❌ Không nên |
|---|---|
| Import module khác qua `index.ts` | Với tay vào file nội bộ của module khác |
| Đọc cấu hình qua `config` | Đọc biến môi trường trong code nghiệp vụ |
| Mở rộng component qua `className` + `variant` | Fork component cho một ca đặc biệt |
| | |

## 9. Vùng cấm chạm

- `../airi/` — mã nguồn AIRI. Không sửa từ dự án này; thay đổi cần thiết làm thành PR riêng bên repo AIRI.
- `infra/cdk.out/` — sinh tự động, không sửa, không commit.

## 10. Thứ tự tham chiếu

```
CLAUDE.md (dự án) → docs/specs/ → docs/decisions/ → docs/infra/
```
