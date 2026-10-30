# airi-web — Hạ tầng

Một môi trường, một người dùng, nhắm chi phí free tier.
Region: **`ap-southeast-2` (Sydney)** — SCP của AWS Organization (`o-xwh7xayy94`) chặn các region khác,
kể cả `ap-southeast-1` và `us-east-1` (đã kiểm tra 2026-10-30).
Mã nguồn AIRI nằm ở repo AIRI (`projects/airi`); dự án này chỉ chứa IaC, Worker, CI và tài liệu.

## Sơ đồ

```
Trình duyệt ──HTTPS──▶ Cloudflare Access (chỉ email của chủ) ──▶ Worker airi-web.<sub>.workers.dev
                                                                   │
                     ┌─────────────────────────────────────────────┼─────────────────────────────┐
                     │ /api* /auth* /ws* /.well-known*             │ /assets/<file > 25 MiB>     │ còn lại
                     ▼                                             ▼                             ▼
     HTTPS + header X-Origin-Auth                            R2 airi-web-large-assets     Workers Assets (stage-web)
                     │
                     ▼
   EC2 t3.small · Elastic IP · <ip>.sslip.io (Let's Encrypt qua Caddy)
   docker compose: caddy ─▶ auth:3000 / api:3000 ─▶ postgres:17 · valkey:8
   Caddy trả 403 cho mọi request không có X-Origin-Auth đúng
```

Trình duyệt chỉ thấy **một origin** (`workers.dev`) nên không cần CORS và cookie đăng nhập là first-party.
Bảng route trong `infra/assets/server/Caddyfile` sao chép từ `airi/server/dev/caddy/Caddyfile`.

## Thành phần

| Nơi | Thành phần | Quản lý bằng |
|---|---|---|
| AWS | `airi-web-registry`: ECR `airi-web/api`, `airi-web/auth` · role GitHub OIDC | CDK (`infra/`) |
| AWS | `airi-web-app`: VPC public-only · EC2 · EIP · SSM parameters · snapshot EBS hằng ngày | CDK (`infra/`) |
| AWS | SSM SecureString `/airi-web/secure/*` | Tạo tay, 1 lần |
| Cloudflare | Worker `airi-web` + R2 `airi-web-large-assets` | Wrangler (`edge/`) |
| Cloudflare | Access cho `*.workers.dev` | Dashboard, 1 lần |

### Vì sao rẻ

- Không NAT Gateway, ALB, RDS, ElastiCache — các dịch vụ tính phí theo giờ bất kể có dùng hay không.
- `t3.small` với **CPU credit `standard`**: hết credit thì chậm lại, không phát sinh phí "unlimited".
- EBS gp3 30 GiB (mức free plan). Snapshot giữ 3 bản (incremental, rất nhỏ).
- Frontend chạy trên Cloudflare; EC2 chỉ chạy backend.

## Bí mật

| Bí mật | Nằm ở | Ai tạo |
|---|---|---|
| Mật khẩu Postgres · `BETTER_AUTH_SECRET` · `LLM_ROUTER_MASTER_KEY` | `/opt/airi/secrets.env` trên EC2 (quyền 600) | `deploy.sh` tự sinh lần đầu |
| `ORIGIN_SECRET` | SSM `/airi-web/secure/ORIGIN_SECRET` **và** secret của Worker | Operator, cùng một giá trị |
| `AUTH_GOOGLE_CLIENT_ID/SECRET` · `AUTH_GITHUB_CLIENT_ID/SECRET` | SSM `/airi-web/secure/*` | Operator |

> ⚠️ `secrets.env` sống cùng ổ đĩa với dữ liệu nó mã hóa. Mất cả instance lẫn snapshot = mất dữ liệu.
> Snapshot EBS hằng ngày giữ cả hai cùng nhau.

AIRI's auth server **bắt buộc** cả Google và GitHub OAuth (`auth/src/env.ts`). Chỉ dùng một bên thì
đặt giá trị bất kỳ không rỗng cho bên còn lại — nút đăng nhập bên đó sẽ không hoạt động.

## Triển khai lần đầu

Cần: AWS CLI (tài khoản quản trị, chỉ lần đầu), Node 24+, pnpm 11, tài khoản Cloudflare.

**1. Cloudflare**

```bash
cd projects/airi-web/edge && pnpm install
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create airi-web-large-assets
openssl rand -hex 32
```

Lưu chuỗi hex vừa sinh — đó là `ORIGIN_SECRET`. Rồi:

```bash
pnpm exec wrangler secret put ORIGIN_SECRET
```

URL Worker có dạng `https://airi-web.<subdomain>.workers.dev` (xem ở dashboard → Workers) — đây là `PUBLIC_URL`.

**2. AWS**

```bash
cd projects/airi-web/infra && pnpm install
pnpm exec cdk bootstrap -c region=ap-southeast-2 -c publicUrl=<PUBLIC_URL>
pnpm exec cdk deploy --all -c publicUrl=<PUBLIC_URL> -c githubRepo=<owner>/<repo-airi-web>
```

Tài khoản đã có OIDC provider của GitHub thì thêm `-c githubOidcProviderArn=<arn>`.
Lần deploy này instance khởi động với image tag `bootstrap` nên chưa chạy container nào.

Tạo SecureString (mỗi lệnh một tham số, giá trị nhập khi được hỏi để không lưu vào shell history):

```bash
aws ssm put-parameter --type SecureString --name /airi-web/secure/ORIGIN_SECRET --value "$(read -rs v; echo "$v")"
```

Lặp lại cho `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GITHUB_CLIENT_ID`,
`AUTH_GITHUB_CLIENT_SECRET`. Callback URL của OAuth app trỏ về `<PUBLIC_URL>/api/auth/callback/<provider>`.

**3. Cloudflare Access**

Dashboard → Workers & Pages → `airi-web` → Settings → Domains & Routes → `workers.dev` → bật
**Cloudflare Access**, policy *Allow* chỉ email của anh.

**4. GitHub** — repo `Airi-Web` → Settings → Environments → tạo environment **`Airi`**
(nên giới hạn *Deployment branches* về `main`), rồi khai báo trong environment đó.
Role AWS chỉ tin OIDC subject `repo:<repo>:environment:Airi` (context `githubEnvironment` trong `infra/cdk.json`).

| Loại | Tên | Giá trị |
|---|---|---|
| Variable | `AWS_REGION` | `ap-southeast-2` |
| Variable | `AWS_DEPLOY_ROLE_ARN` | output `CiRoleArn` của `airi-web-registry` |
| Variable | `AIRI_REPOSITORY` | `<owner>/airi` |
| Variable | `AIRI_REF` | nhánh/tag AIRI cần deploy |
| Variable | `PUBLIC_URL` | URL Worker |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Account ID trên dashboard |
| Secret | `CLOUDFLARE_API_TOKEN` | Token quyền *Workers Scripts: Edit* + *Workers R2 Storage: Edit* |

**5.** Chạy workflow **deploy** (Actions → deploy → Run workflow).

## Vận hành

| Việc | Cách làm |
|---|---|
| Vào shell máy chủ | `aws ssm start-session --target <InstanceId>` (không có SSH) |
| Xem log | `cd /opt/airi && docker compose logs -f api auth` |
| Deploy lại không đổi image | `sudo bash /opt/airi/deploy.sh` trong session SSM |
| Đổi secret OAuth | `aws ssm put-parameter --overwrite ...` rồi chạy lại `deploy.sh` |
| Khôi phục | Tạo volume từ snapshot gần nhất, gắn vào instance thay root volume |

## Đánh đổi đã biết

| Hạng mục | Hiện trạng | Hướng nâng cấp |
|---|---|---|
| Origin | `sslip.io` (DNS công cộng miễn phí) + port 80/443 mở, chặn bằng header bí mật | Có domain riêng → Cloudflare Tunnel, đóng toàn bộ inbound |
| Single point of failure | 1 instance, Postgres cùng máy | Chấp nhận được cho 1 người dùng |
| RAM | 2 GB + 2 GB swap, mỗi container có `mem_limit` | `c7i-flex.large` (4 GB) nếu thấy OOM |
| Auth UI | `AUTH_UI_URL` vẫn là mặc định upstream | Deploy `apps/ui-server-auth` nếu cần trang đăng nhập riêng |
| Free plan | Credit hết hạn sau 6 tháng | Theo dõi Billing → Free Tier; đặt AWS Budget cảnh báo |
