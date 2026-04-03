# codex-keyring

`codex-keyring` là trình quản lý nhiều tài khoản theo kiểu native dành cho Codex app, Codex CLI và Codex IDE extension.

Nó dành cho những ai muốn giữ nhiều login Codex dưới dạng alias gọn gàng, switch tay bằng một lệnh, hoặc để hệ thống auto-switch sau các lỗi quota, rate-limit, auth-expiry, và workspace-mismatch được hỗ trợ.

Nó bám sát trải nghiệm Codex chính thức:

- thêm tài khoản bằng flow `codex login` chính thức
- lưu snapshot tài khoản dưới dạng alias đơn giản
- switch active auth cache của Codex theo kiểu atomic
- ưu tiên hiển thị các tín hiệu quota hữu ích nhất, đặc biệt là quota còn lại của 5 giờ và 1 tuần
- bật auto-switch theo 2 mode `balanced` và `sequential`
- cài plugin local và MCP server để dùng trong Codex app và IDE

Tài liệu tiếng Anh nằm ở [README.md](./README.md).

## Cài đặt

```bash
npm install -g codex-keyring
codex-keyring install
codex-keyring doctor
```

`codex-keyring install` thiết lập managed mode, cài plugin payload local cho Codex, và cập nhật personal plugin marketplace.

Nếu bạn đang nâng cấp từ `codex-accounts`, chỉ cần cài `codex-keyring` rồi chạy `codex-keyring install` một lần. Dữ liệu cũ trong `~/.codex-accounts` sẽ được migrate sang `~/.codex-keyring`, đồng thời personal marketplace entry cũng được chuẩn hóa sang plugin slug mới.

### Sau khi `install`

Sau khi cài xong, `Codex Keyring` sẽ khả dụng dưới dạng plugin trong Codex app và Codex IDE extension.

Bạn có thể nhờ agent của Codex kiểm tra account, switch alias, rename alias, chạy `doctor`, hoặc hướng dẫn bước tiếp theo thông qua prompt ngôn ngữ tự nhiên.

Khi bật auto-switch, `Codex Keyring` còn thực hiện best-effort reconciliation từ các tín hiệu quota gần đây do chính Codex host ghi nhận, để request kế tiếp hoặc phiên mở lại có thể chuyển sang alias khác.

## Bắt đầu nhanh cho multi-account switching

```bash
codex-keyring add account1 --from-active
codex-keyring add account2

codex-keyring list
codex-keyring switch account2
codex-keyring status
```

`account1` và `account2` chỉ là alias mẫu. Hãy thay bằng tên phản ánh đúng account bạn muốn quản lý, ví dụ `alice-work`, `alice-personal`, hoặc `ngoquocviet2001`.

Luồng này lưu login Codex hiện tại thành `account1`, đăng nhập thêm một account khác thành `account2`, rồi cho phép bạn kiểm tra account, switch tay, hoặc chuẩn bị cho auto-switch theo quota. View CLI mặc định giờ ưu tiên `5h left` và `week left` khi Codex đã lộ dữ liệu quota local chính xác.

## Sử dụng trong Codex App và IDE

Sau khi chạy `codex-keyring install`:

1. restart Codex app hoặc reload IDE extension session
2. xác nhận `Codex Keyring` xuất hiện trong Plugins panel
3. dùng prompt ngôn ngữ tự nhiên để gọi các tool quản lý account

Ví dụ prompt:

- `List all managed Codex accounts and show which alias is active.`
- `Switch the active Codex account to account2 for subsequent requests.`
- `Show the details for account2, including email, organization, and plan details when available.`
- `Rename the alias account2 to alice-work.`
- `Run a doctor check for codex-keyring and summarize the result.`

Mỗi lần switch sẽ cập nhật auth cache nền của Codex. Các tiến trình CLI mới sẽ dùng account mới ngay. Với Codex app và IDE, account đã switch thường được áp dụng ở request kế tiếp hoặc sau khi reload session hiện tại.

## Các luồng làm việc phổ biến

### Thêm Login Hiện Tại

```bash
codex-keyring add account1 --from-active
```

### Thêm Một Account Khác

```bash
codex-keyring add account2
```

Lệnh này dùng flow `codex login` mặc định qua browser.

Nếu cần device auth:

```bash
codex-keyring add account2 --device-auth
```

Nếu môi trường của bạn chặn device auth, hãy login trước rồi capture active auth:

```bash
codex login
codex-keyring add account2 --from-active
```

### Liệt kê và Kiểm tra Account

```bash
codex-keyring list
codex-keyring info account2
codex-keyring status
codex-keyring stats
codex-keyring stats account2
```

### Switch Account Thủ Công

```bash
codex-keyring switch account2
codex-keyring switch account1
```

### Bật Auto-Switch Failover

```bash
codex-keyring auto on --mode balanced
codex-keyring exec codex -- --help
```

Có 2 mode auto-switch:

- `balanced` là mặc định. Mục tiêu là chia đều quota 5 giờ giữa các account. Nếu alias đang active tụt xuống các mốc thực dụng và alias khác còn nhiều headroom hơn, `codex-keyring` sẽ switch sớm.
- `sequential` sẽ giữ alias hiện tại cho tới khi gần như bị chặn hẳn, rồi mới chuyển sang alias tốt nhất còn quota.

`codex-keyring exec` giờ có thể switch active auth cache ngay khi phiên CLI đang chạy phát ra lỗi quota hoặc auth được hỗ trợ. Nếu process vẫn thoát ra, nó sẽ retry đúng một tiến trình mới sau khi failover.

Với Codex app và IDE extension, `codex-keyring` cũng thực hiện best-effort reconciliation từ các tín hiệu quota, rate-limit, auth-expiry, và workspace-mismatch do host ghi nhận, để request kế tiếp hoặc phiên mở lại có thể dùng alias khác. Request đã fail rồi thì vẫn không thể tiếp tục liền mạch giữa chừng.

### Đổi Tên hoặc Xóa Alias

```bash
codex-keyring rename account2 alice-work
codex-keyring remove alice-work
```

Nếu xóa alias đang active, cần thêm `--force`.

## Hệ điều hành hỗ trợ

`codex-keyring` nhắm tới cùng tập hệ điều hành mà Codex CLI chính thức hỗ trợ:

- Windows
- macOS
- Linux
- WSL
- môi trường container khi Codex CLI chính thức được hỗ trợ và thư mục home của người dùng có quyền ghi

## Tham chiếu lệnh

| Lệnh | Mục đích | Ghi chú |
| --- | --- | --- |
| `codex-keyring list` | liệt kê alias và health | bảng mặc định ưu tiên `5h left` và `week left`; hỗ trợ `--json` |
| `codex-keyring status` | xem active alias và managed mode | gồm auto-switch mode và quota summary; hỗ trợ `--json` |
| `codex-keyring info <alias>` | xem chi tiết an toàn của một alias | gồm email, organization và plan details nếu có |
| `codex-keyring stats [alias]` | xem stats ưu tiên quota cho một hoặc tất cả alias | gồm quota 5 giờ và 1 tuần khi đã biết; hỗ trợ `--json` |
| `codex-keyring add <alias>` | thêm alias qua official login | mặc định là browser OAuth |
| `codex-keyring add <alias> --device-auth` | thêm alias qua official device auth | có thể bị org policy chặn |
| `codex-keyring add <alias> --from-active` | lưu auth đang active | không tạo login mới |
| `codex-keyring switch <alias>` | kích hoạt một alias | atomic và có backup |
| `codex-keyring remove <alias>` | xóa alias | alias đang active cần `--force` |
| `codex-keyring rename <old> <new>` | đổi tên alias | giữ nguyên snapshot |
| `codex-keyring auto on\|off --mode balanced\|sequential` | bật hoặc tắt auto-switch | `balanced` là mặc định |
| `codex-keyring exec -- <command>` | chạy command có hỗ trợ failover | retry đúng một lần sau supported switch |
| `codex-keyring install` | cài plugin và bật managed mode | hỗ trợ `--no-manage-auth` |
| `codex-keyring uninstall` | gỡ plugin khỏi marketplace | dữ liệu store vẫn còn |
| `codex-keyring doctor` | kiểm tra tình trạng môi trường | nên chạy sau khi install |
| `codex-keyring mcp` | chạy stdio MCP server | dùng cho tích hợp nâng cao |

## Khắc phục sự cố

### `doctor` báo `cli-auth-store` là `warn`

```bash
codex-keyring install
codex-keyring doctor
```

### Browser Login chạy được nhưng Device Auth lỗi

Một số tổ chức chặn device auth. Hãy dùng:

```bash
codex-keyring add account2
```

hoặc:

```bash
codex login
codex-keyring add account2 --from-active
```

### Plugin không xuất hiện

Hãy chạy `codex-keyring doctor`, xác nhận marketplace check đã pass, rồi restart Codex app hoặc reload IDE extension session.

### `info` không hiện tên business workspace

`codex-keyring` chỉ hiển thị các trường identity mà official local auth cache của Codex thực sự cung cấp. Với một số account business-managed, tên workspace đang chọn trong giao diện Codex không có trong auth snapshot local, nên `info` có thể chỉ hiện email và plan details.

### `exec` không switch account

Hãy chắc rằng auto-switch đã bật, còn alias khác sẵn sàng để switch, và lỗi thuộc nhóm được hỗ trợ như quota, rate limit, auth expiry hoặc workspace mismatch.

Với Codex app và IDE, việc switch là best-effort cho request kế tiếp hoặc sau khi mở lại phiên khi host đã ghi log lỗi phù hợp. Nó không cứu được request đã thất bại trước đó.

## Giấy phép

[MIT](./LICENSE)
