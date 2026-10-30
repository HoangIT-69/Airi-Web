# ADR 0001 — AIRI web: 1 EC2 trên AWS + Cloudflare Worker, giữ nguyên frontend Vue

- **Trạng thái**: Chấp nhận
- **Ngày**: 2026-10-30
- **Người quyết định**: Đinh Nhật Hoàng

## Bối cảnh

AIRI đã có bản web (`apps/stage-web`, Vue 3 + Vite) và backend (`server/apps/api`, `server/apps/auth`)
chạy bằng docker-compose với Postgres, Redis và Caddy. Mục tiêu: đưa lên web cho **một người dùng**,
**một môi trường**, chi phí ở mức free tier của AWS (tài khoản Free plan, tạo sau 07/2025)
cộng gói Cloudflare Workers $5/tháng đã có sẵn. Không có domain riêng.

## Quyết định

1. **Giữ Vue/Vite**, không viết lại. `airi-web` chỉ chứa IaC, Worker, CI và tài liệu.
2. **Backend: 1 EC2 `t3.small` chạy docker compose** (Postgres, Valkey, api, auth, Caddy).
   Đã cân nhắc ECS Fargate + RDS + ElastiCache + ALB + NAT (bản nháp đầu) — loại vì chi phí cố định
   ~$70–100/tháng không hợp với một người dùng.
3. **Postgres thường, không VectorChord**: migration Drizzle của `api` không có cột/index vector;
   `vchord` chỉ có trong `sql/init.sql` của docker-compose dev. Không cần patch AIRI.
4. **Frontend trên Cloudflare Workers Assets**, Worker proxy các path backend tới EC2 → một origin duy nhất.
   File > 25 MiB (2 model VRM mặc định) đặt ở R2 vì giới hạn kích thước của Workers Assets.
5. **Không có domain → `workers.dev` + `sslip.io`.** Cloudflare Tunnel cần hostname trên zone riêng
   nên chưa dùng được; thay bằng HTTPS tới `<ip>.sslip.io` và header bí mật `X-Origin-Auth`.
   Cloudflare Access trên `workers.dev` giới hạn người truy cập.
6. **CDK (TypeScript)** cho AWS, **Wrangler** cho Cloudflare. Phần Cloudflare dùng một lần (R2 bucket,
   Access) làm tay theo runbook.
7. **Region `ap-southeast-2` (Sydney)**: account thuộc AWS Organization có SCP chỉ cho phép region này.
8. **Không SSH**: vào máy và deploy qua SSM. CI xác thực bằng GitHub OIDC.

## Hệ quả

- Port 80/443 của EC2 mở ra internet (cần cho Let's Encrypt và cho Worker); bảo vệ bằng header bí mật.
  Có domain thì chuyển sang Tunnel và đóng hết inbound.
- Dữ liệu và khóa mã hóa (`secrets.env`) nằm chung một ổ; snapshot EBS hằng ngày là cơ chế backup duy nhất.
- Quy tắc workspace về `src/` Next.js, i18n và `vendor_id` không áp dụng — dự án không chứa mã ứng dụng
  và chỉ có một người dùng.
- Upstream AIRI đổi Dockerfile, route hoặc biến môi trường bắt buộc thì phải cập nhật
  `infra/assets/server/` và `edge/src/index.ts`.
