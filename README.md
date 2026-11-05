# Đi Đâu — trải nghiệm du lịch địa phương

Website demo giúp khám phá các hành trình tại Việt Nam, quản lý giỏ đặt chỗ và gửi yêu cầu đặt tour. Dự án sử dụng React, Vite, TypeScript, Hono và Cloudflare Workers. Dữ liệu tour và đơn đặt chỗ được lưu bằng Cloudflare D1; giỏ đặt chỗ được lưu bằng KV.

## Chạy nhanh

Yêu cầu Node.js và npm.

```bash
npm install
npm run db:init
npm run dev
```

Mở URL Vite hiển thị trong terminal (thường là `http://localhost:5173`). Trong chế độ phát triển, Vite chuyển tiếp `/api/*` đến Wrangler tại `http://localhost:8787`. Dữ liệu D1 và KV local được Wrangler lưu trong `apps/api/.wrangler/`.

Để bật các API quản trị khi chạy local, tạo `apps/api/.dev.vars` và đặt `ADMIN_TOKEN` trong đó:

```dotenv
ADMIN_TOKEN=your-local-admin-token
```

## Scripts

| Lệnh | Mục đích |
| --- | --- |
| `npm install` | Cài dependency cho các workspace |
| `npm run dev` | Chạy API Wrangler và frontend Vite |
| `npm run typecheck` | Kiểm tra TypeScript cho API và frontend |
| `npm run build` | Kiểm tra TypeScript và build frontend vào `apps/web/dist` |
| `npm run db:init` | Tạo schema và dữ liệu mẫu vào D1 local |
| `npm run deploy` | Build frontend rồi deploy Cloudflare Worker |
| `npm run db:init:remote -w apps/api` | Chủ động tạo schema và dữ liệu mẫu vào D1 remote |

## Tính năng demo

- Khám phá, tìm kiếm, lọc và sắp xếp các hành trình theo danh mục, ngân sách và đánh giá.
- Thêm trải nghiệm vào giỏ đặt chỗ; thông tin tour và giá được lấy lại từ D1.
- Gửi yêu cầu đặt tour, chọn thanh toán demo và tra cứu đơn bằng mã đơn, email hoặc số điện thoại.
- Đăng ký nhận bản tin và quản lý tour, đơn đặt chỗ qua API quản trị.
- Thanh toán demo chỉ mô phỏng; không thu tiền thật.

## API

- `GET /api/tours?q=...&category=...&maxPrice=...&sort=...`
- `GET /api/categories`
- `GET /api/cart`
- `POST /api/cart/items` với `{ "tourId": 1 }`
- `PUT /api/cart/items/:id` với `{ "qty": 1 }`
- `DELETE /api/cart`
- `POST /api/orders` với `name`, `email`, `phone`, `departureDate` và `paymentDemo`
- `POST /api/orders/lookup` với `lookupType` (`orderNumber`, `email` hoặc `phone`) và `value`
- `POST /api/newsletter` với `{ "email": "you@example.com" }`
- `GET /api/admin/tours`
- `POST /api/admin/tours`
- `PUT /api/admin/tours/:id`
- `DELETE /api/admin/tours/:id`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:id`

Các API quản trị yêu cầu xác thực bằng bearer token. Cấu hình `ADMIN_TOKEN` bằng secret của Cloudflare Worker trước khi sử dụng trên môi trường đã deploy.

## Deploy Cloudflare

Kiểm tra cấu hình D1 và KV trong `apps/api/wrangler.toml`, cài đặt `ADMIN_TOKEN` dưới dạng secret của Worker, sau đó chạy:

```bash
npm run db:init:remote -w apps/api
npm run deploy
```

Chỉ chạy lệnh khởi tạo D1 remote khi bạn chủ động muốn áp dụng schema và dữ liệu mẫu lên cơ sở dữ liệu production.
