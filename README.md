# MSRegFlow

`MSRegFlow` 是一个面向 **Microsoft Account Manager API** 的 Chrome 扩展，
用于自动执行 Codex / OpenAI OAuth 注册流程（含收码、授权、回调导入与清理）。

当前版本只保留一个验证码来源：

- `Microsoft Account Manager API`

---

## 关联项目

本扩展依赖你的账号管理服务（Account Manager）：

- `https://github.com/Msg-Lbo/microsoft-account-manager`

请先完成该项目的部署与可用性验证，再使用本扩展。

---

## 功能概览

- 支持 `CPA Auth` 与 `Sub2API` 两种 OAuth 目标
- 自动执行 10 步流程（获取链接、注册、收码、授权、回调导入、清理）
- 验证码读取与账号自动获取统一走 `Microsoft Account Manager API`
- 支持自动模式（`Auto`）与单步模式
- 支持失败后 `Skip`、中断后继续
- 支持成功后自动删除来源账号（Step 10）
- 内置运行统计：计时、平均用时、成功率
- 支持中英文界面切换（默认中文）

---

## 安装

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择当前项目目录
5. 打开扩展侧边栏

---

## 使用前准备

开始之前请确认：

- 你已经部署并可访问 `microsoft-account-manager`
- 你已准备好 `MAIL_API_TOKEN`
- 你有可用 OAuth 来源：`CPA Auth` 或 `Sub2API`
- 若使用 `Sub2API`，其后台接口可用

---

## 侧边栏配置说明

### 1) OAuth

用于选择目标导入端：

- `CPA Auth`
- `Sub2API`

#### CPA Auth 模式

填写管理面板地址，例如：

```txt
http(s)://<your-host>/management.html#/oauth
```

对应流程：

- Step 1：获取 OAuth 链接
- Step 9：回填 callback 并验证导入

#### Sub2API 模式

需要填写：

- `Sub2API`：建议填写根域名（如 `https://your-host`）
- `API Key`：可留空；若后端启用了鉴权，可填写 `x-api-key` 或 `Bearer token`

说明：

- 不要填后台页面路径（如 `/admin/acc`）
- 插件会自动拼接 API 路径并调用：
  - `POST /api/v1/admin/openai/generate-auth-url`
  - `POST /api/v1/admin/openai/create-from-oauth`
- 当 `API Key` 留空时，插件会尝试读取你当前已登录 Sub2API 后台页面的管理员会话令牌（JWT）

### 2) Verify（固定）

当前仅支持：

- `Microsoft Account Manager API`

需要填写：

- `MSMgr`：你的 account manager 地址（如 `https://your-domain`）
- `Token`：`MAIL_API_TOKEN`
- `Mode`：`graph` 或 `imap`
- `Filter`：可选，按关键词筛选账号

### 3) Email

- 点击 `Auto`：从 account manager 自动获取账号邮箱并填入
- 若账号备注为 `已注册`，会自动跳过并选择下一个账号
- 或手动粘贴邮箱

### 4) Password

- 留空：自动生成强密码
- 手动填写：使用自定义密码

### 5) Cleanup

- 开启后，Step 10 会在成功导入后自动删除当前来源账号
- 删除失败不会阻断整轮流程完成标记
- 未开启时，Step 10 会自动给当前账号打备注：`已注册`

---

## 工作流（10 步）

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Fill Name / Birthday`
6. `Login via OAuth`
7. `Get Login Code`
8. `OAuth Auto Confirm`
9. `Callback Verify / Import`
10. `Cleanup Source Email`

---

## 常见问题

### 1) Step 9 报缺少 code/state

如果 callback URL 中包含 `error=request_forbidden` 或 CSRF 相关描述，
说明授权会话失配（常见于页面过期/会话变化）。

建议：

1. 从 Step 1 重新获取新的 OAuth 链接
2. 不要复用过期授权页
3. 按顺序继续到 Step 9

### 2) Sub2API 鉴权失败

- 若后端启用 `x-api-key`，填对应 key
- 若使用管理员登录态，保持 Sub2API 后台页面已登录，API Key 留空即可

### 3) 收不到验证码

优先检查：

- `MSMgr` 地址是否可达
- `MAIL_API_TOKEN` 是否正确
- `Mode` 是否与你服务端配置一致
- `Filter` 是否把目标账号过滤掉了

---

## 免责声明

本项目仅面向个人学习与自用自动化，不建议用于高频、大规模或滥用场景。
