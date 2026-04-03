# codex-accounts

`codex-accounts` là trình quản lý nhiều tài khoản theo kiểu native dành cho Codex app, Codex CLI và Codex IDE extension.

Nó bám sát trải nghiệm Codex chính thức:

- thêm tài khoản bằng flow `codex login` chính thức
- lưu snapshot tài khoản dưới dạng alias đơn giản
- switch active auth cache của Codex theo kiểu atomic
- cài plugin local và MCP server để dùng trong Codex app và IDE

Tài liệu tiếng Anh nằm ở [README.md](./README.md).

## Cài đặt

```bash
npm install -g codex-accounts
codex-accounts install
codex-accounts doctor
```

`codex-accounts install` thiết lập managed mode, cài plugin payload local cho Codex, và cập nhật personal plugin marketplace.

### Sau khi `install`

Sau khi cài xong, `Codex Accounts` sẽ khả dụng dưới dạng plugin trong Codex app và Codex IDE extension.

Bạn có thể nhờ agent của Codex kiểm tra account, switch alias, rename alias, chạy `doctor`, hoặc hướng dẫn bước tiếp theo thông qua prompt ngôn ngữ tự nhiên.

Khi bật auto-switch, `Codex Accounts` còn thực hiện best-effort reconciliation từ các lỗi gần đây do chính Codex host ghi nhận, để request kế tiếp hoặc phiên mở lại có thể chuyển sang alias khác.

## Bắt đầu nhanh

```bash
codex-accounts add account1 --from-active
codex-accounts add account2

codex-accounts list
codex-accounts switch account2
codex-accounts status
```

`account1` và `account2` chỉ là alias mẫu. Hãy thay bằng tên phản ánh đúng account bạn muốn quản lý, ví dụ `alice-work`, `alice-personal`, hoặc `ngoquocviet2001`.

Luồng này lưu login Codex hiện tại thành `account1`, đăng nhập thêm một account khác thành `account2`, rồi cho phép bạn kiểm tra và switch qua lại.

## Sử dụng trong Codex App và IDE

Sau khi chạy `codex-accounts install`:

1. restart Codex app hoặc reload IDE extension session
2. xác nhận `Codex Accounts` xuất hiện trong Plugins panel
3. dùng prompt ngôn ngữ tự nhiên để gọi các tool quản lý account

Ví dụ prompt:

- `List all managed Codex accounts and show which alias is active.`
- `Switch the active Codex account to account2 for subsequent requests.`
- `Show the details for account2, including email, organization, and plan details when available.`
- `Rename the alias account2 to alice-work.`
- `Run a doctor check for codex-accounts and summarize the result.`

Mỗi lần switch sẽ cập nhật auth cache nền của Codex. Các tiến trình CLI mới sẽ dùng account mới ngay. Với Codex app và IDE, account đã switch thường được áp dụng ở request kế tiếp hoặc sau khi reload session hiện tại.

## Các luồng làm việc phổ biến

### Thêm Login Hiện Tại

```bash
codex-accounts add account1 --from-active
```

### Thêm Một Account Khác

```bash
codex-accounts add account2
```

Lệnh này dùng flow `codex login` mặc định qua browser.

Nếu cần device auth:

```bash
codex-accounts add account2 --device-auth
```

Nếu môi trường của bạn chặn device auth, hãy login trước rồi capture active auth:

```bash
codex login
codex-accounts add account2 --from-active
```

### Liệt kê và Kiểm tra Account

```bash
codex-accounts list
codex-accounts info account2
codex-accounts status
codex-accounts stats
codex-accounts stats account2
```

### Switch Account

```bash
codex-accounts switch account2
codex-accounts switch account1
```

### Bật Auto-Switch

```bash
codex-accounts auto on
codex-accounts exec codex -- --help
```

`auto-switch` sẽ switch active auth cache và retry đúng một tiến trình mới trong `codex-accounts exec`.

Với Codex app và IDE extension, `codex-accounts` cũng thực hiện best-effort reconciliation từ các tín hiệu quota, rate-limit, auth-expiry, và workspace-mismatch do host ghi nhận, để request kế tiếp hoặc phiên mở lại có thể dùng alias khác. Request đã fail rồi thì vẫn không thể tiếp tục liền mạch giữa chừng.

### Đổi Tên hoặc Xóa Alias

```bash
codex-accounts rename account2 alice-work
codex-accounts remove alice-work
```

Nếu xóa alias đang active, cần thêm `--force`.

## Hệ điều hành hỗ trợ

`codex-accounts` nhắm tới cùng tập hệ điều hành mà Codex CLI chính thức hỗ trợ:

- Windows
- macOS
- Linux
- WSL
- môi trường container khi Codex CLI chính thức được hỗ trợ và thư mục home của người dùng có quyền ghi

## Tham chiếu lệnh

| Lệnh | Mục đích | Ghi chú |
| --- | --- | --- |
| `codex-accounts list` | liệt kê alias và health | hỗ trợ `--json` |
| `codex-accounts status` | xem active alias và managed mode | hỗ trợ `--json` |
| `codex-accounts info <alias>` | xem chi tiết an toàn của một alias | gồm email, organization và plan details nếu có |
| `codex-accounts stats [alias]` | xem stats cho một hoặc tất cả alias | hỗ trợ `--json` |
| `codex-accounts add <alias>` | thêm alias qua official login | mặc định là browser OAuth |
| `codex-accounts add <alias> --device-auth` | thêm alias qua official device auth | có thể bị org policy chặn |
| `codex-accounts add <alias> --from-active` | lưu auth đang active | không tạo login mới |
| `codex-accounts switch <alias>` | kích hoạt một alias | atomic và có backup |
| `codex-accounts remove <alias>` | xóa alias | alias đang active cần `--force` |
| `codex-accounts rename <old> <new>` | đổi tên alias | giữ nguyên snapshot |
| `codex-accounts auto on\|off` | bật hoặc tắt auto-switch | mặc định tắt |
| `codex-accounts exec -- <command>` | chạy command có hỗ trợ failover | retry đúng một lần sau supported switch |
| `codex-accounts install` | cài plugin và bật managed mode | hỗ trợ `--no-manage-auth` |
| `codex-accounts uninstall` | gỡ plugin khỏi marketplace | dữ liệu store vẫn còn |
| `codex-accounts doctor` | kiểm tra tình trạng môi trường | nên chạy sau khi install |
| `codex-accounts mcp` | chạy stdio MCP server | dùng cho tích hợp nâng cao |

## Khắc phục sự cố

### `doctor` báo `cli-auth-store` là `warn`

```bash
codex-accounts install
codex-accounts doctor
```

### Browser Login chạy được nhưng Device Auth lỗi

Một số tổ chức chặn device auth. Hãy dùng:

```bash
codex-accounts add account2
```

hoặc:

```bash
codex login
codex-accounts add account2 --from-active
```

### Plugin không xuất hiện

Hãy chạy `codex-accounts doctor`, xác nhận marketplace check đã pass, rồi restart Codex app hoặc reload IDE extension session.

### `info` không hiện tên business workspace

`codex-accounts` chỉ hiển thị các trường identity mà official local auth cache của Codex thực sự cung cấp. Với một số account business-managed, tên workspace đang chọn trong giao diện Codex không có trong auth snapshot local, nên `info` có thể chỉ hiện email và plan details.

### `exec` không switch account

Hãy chắc rằng auto-switch đã bật, còn alias khác sẵn sàng để switch, và lỗi thuộc nhóm được hỗ trợ như quota, rate limit, auth expiry hoặc workspace mismatch.

Với Codex app và IDE, việc switch là best-effort cho request kế tiếp hoặc sau khi mở lại phiên khi host đã ghi log lỗi phù hợp. Nó không cứu được request đã thất bại trước đó.

## Giấy phép

[MIT](./LICENSE)
