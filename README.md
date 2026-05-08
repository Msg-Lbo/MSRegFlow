# MSRegFlow

当前版本：`1.2.0`

`MSRegFlow` 是一个面向 **Microsoft Account Manager API** 的 Chrome 扩展，
用于自动执行 Codex / OpenAI OAuth 注册流程（含收码、授权、回调导入）。

当前版本的邮箱验证码来源：

- `Microsoft Account Manager API`

当前版本的手机接码平台：

- `HeroSMS`：`https://hero-sms.com/`
- `SMSCloud`：`https://smscloud.sbs/`，API 文档：`https://smscloud.sbs/docx/#/`

---

## 关联项目

本扩展依赖你的账号管理服务（Account Manager）：

- `https://github.com/Msg-Lbo/microsoft-account-manager`

请先完成该项目的部署与可用性验证，再使用本扩展。

---

## 功能概览

- 支持 `CPA Auth` 与 `Sub2API` 两种 OAuth 目标
- 自动执行 8 步流程（获取链接、注册、邮箱收码、手机接码、授权、回调导入）
- 验证码读取与账号自动获取统一走 `Microsoft Account Manager API`
- 手机验证支持 `HeroSMS` 与 `SMSCloud` 下拉切换
- 支持自动模式（`Auto`）与单步模式
- 支持失败后 `Skip`、中断后继续
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
- 如需自动处理手机验证，请准备 `HeroSMS` 或 `SMSCloud` 的 API Key

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

可选填写 `CPA Key`（Management Key）：

- 已填写：Step 1/Step 7 走管理 API，不再依赖页面按钮点击
- 未填写：保留旧版页面点击模式（兼容原流程）
- 注意：这里必须填写**明文** Management Key，不要填配置文件里自动加密后的 `$2...` 串

CPA API 模式会调用：

- `GET /v0/management/codex-auth-url`（获取授权链接）
- `GET /v0/management/get-auth-status?state=...`（确认回调导入状态）

对应流程：

- Step 1：获取 OAuth 链接
- Step 7：验证 callback 并完成导入

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
- `别名池`：
  - 勾选：Auto 取号时使用“主邮箱 + 别名邮箱”
  - 不勾选：Auto 只使用主邮箱
- `封号处理`：
  - 勾选：Step 4 遇到 `AADSTS70000` 时自动删除被封邮箱并换号重试
  - 不勾选：Step 4 遇到 `AADSTS70000` 时跳过该邮箱（标记 `已封禁`）并换号重试

### 3) 手机接码

启用「接码」后，面板会显示接码平台下拉框。不同平台会动态显示对应控件。

#### HeroSMS

接码地址：`https://hero-sms.com/`

API 地址：`https://hero-sms.com/stubs/handler_api.php`

需要填写：

- `Hero Key`：HeroSMS API Key
- `号码地区`：点击「加载地区」后选择
- `运营商`：可选，默认任何运营商
- `报价模式`：报价列表上限或固定出价
- `购买价格` / `手动出价`：可选，不填则由平台自动选择

说明：

- 服务类型会自动锁定 OpenAI/ChatGPT/Codex 对应服务码
- HeroSMS 价格显示为美元 `$`
- 手动出价建议参考网页端自定义价格档位，实际可用档位需要自测

#### SMSCloud

接码地址：`https://smscloud.sbs/`

API 文档：`https://smscloud.sbs/docx/#/`

API Root：`https://smscloud.sbs/api/system/`

需要填写：

- `Cloud Key`：SMSCloud API Key
- `号码地区`：点击「加载地区」后选择
- `价格上限` / `手动上限`：可选，对应 SMSCloud `maxPrice`

说明：

- SMSCloud 使用 `apiKey` 请求头鉴权
- 服务类型会自动从服务列表中匹配 OpenAI/ChatGPT/Codex
- SMSCloud 价格与余额单位为「钻石」，不是美元
- 不填写价格上限时，会按平台默认价格购买

#### 无需 WhatsApp 国家筛选

面板提供「仅显示无需 WhatsApp 的国家」复选框。勾选后，号码地区列表只显示下表中的国家/地区。

说明：下表基于一次扫描快照整理，`网页端选项` 用于帮助定位 OpenAI add-phone 页面中的实际下拉项。

| 国家/地区 | English | 区号 | 网页端选项 |
|---|---|---:|---|
| 印度尼西亚 | Indonesia | 62 | 印度尼西亚 +(62) |
| 哈萨克斯坦 | Kazakhstan | 7 | 俄罗斯 +(7) |
| 越南 | Vietnam | 84 | 越南 +(84) |
| 喀麦隆 | Cameroon | 237 | 喀麦隆 +(237) |
| 安哥拉 | Angola | 244 | 安哥拉 +(244) |
| 泰国 | Thailand | 66 | 泰国 +(66) |
| 乌兹别克斯坦 | Uzbekistan | 998 | 乌兹别克斯坦 +(998) |
| 塞内加尔 | Senegal | 221 | 塞内加尔 +(221) |
| 斯里兰卡 | Sri Lanka | 94 | 斯里兰卡 +(94) |
| 蒙古 | Mongolia | 976 | 蒙古 +(976) |
| 马来西亚 | Malaysia | 60 | 马来西亚 +(60) |
| 马达加斯加 | Madagascar | 261 | 马达加斯加 +(261) |
| 尼日利亚 | Nigeria | 234 | 尼日利亚 +(234) |
| 澳门 | Macao | 853 | 中国澳门特别行政区 +(853) |
| 柬埔寨 | Cambodia | 855 | 柬埔寨 +(855) |
| 沙特阿拉伯 | Saudi Arabia | 966 | 沙特阿拉伯 +(966) |
| 伊朗 | Iran | 98 | 伊朗 +(98) |
| 秘鲁 | Peru | 51 | 秘鲁 +(51) |
| 马里 | Mali | 223 | 北马里亚纳群岛 +(1) |
| 埃塞俄比亚 | Ethiopia | 251 | 埃塞俄比亚 +(251) |
| 乌干达 | Uganda | 256 | 乌干达 +(256) |
| 法国 | France | 33 | 法国 +(33) |
| 莫桑比克 | Mozambique | 258 | 莫桑比克 +(258) |
| 意大利 | Italy | 39 | 梵蒂冈 +(39) |
| 津巴布韦 | Zimbabwe | 263 | 津巴布韦 +(263) |
| 多哥 | Togo | 228 | 多哥 +(228) |
| 利比亚 | Libya | 218 | 利比亚 +(218) |
| 叙利亚 | Syria | 963 | 叙利亚 +(963) |
| 古巴 | Cuba | 53 | 古巴 +(53) |
| 塞拉利昂 | Sierra Leone | 232 | 塞拉利昂 +(232) |
| 约旦 | Jordan | 962 | 约旦 +(962) |
| 中非共和国 | Central African Republic | 236 | 中非共和国 +(236) |
| 科摩罗 | Comoros | 269 | 科摩罗 +(269) |
| 黎巴嫩 | Lebanon | 961 | 黎巴嫩 +(961) |
| 毛里求斯 | Mauritius | 230 | 毛里求斯 +(230) |
| 土库曼斯坦 | Turkmenistan | 993 | 土库曼斯坦 +(993) |
| 黑山 | Montenegro | 382 | 黑山 +(382) |
| 巴勒斯坦 | Palestine | 970 | 巴勒斯坦权力机构 +(970) |
| 吉尔吉斯斯坦 | Kyrgyzstan | 996 | 吉尔吉斯斯坦 +(996) |
| 埃及 | Egypt | 20 | 埃及 +(20) |
| 孟加拉国 | Bangladesh | 880 | 孟加拉国 +(880) |
| 委内瑞拉 | Venezuela | 58 | 委内瑞拉 +(58) |
| 东帝汶 | Timor-Leste | 670 | 东帝汶 +(670) |
| 亚美尼亚 | Armenia | 374 | 亚美尼亚 +(374) |
| 香港 | Hong Kong | 852 | 中国香港特别行政区 +(852) |
| 纽埃 | Niue | 683 | 纽埃 +(683) |
| 斯洛文尼亚 | Slovenia | 386 | 斯洛文尼亚 +(386) |
| 保加利亚 | Bulgaria | 359 | 保加利亚 +(359) |
| 印度 | India | 91 | 英属印度洋领地 +(246) |
| 海地 | Haiti | 509 | 海地 +(509) |
| 加纳 | Ghana | 233 | 加纳 +(233) |
| 阿尔及利亚 | Algeria | 213 | 阿尔及利亚 +(213) |
| 阿富汗 | Afghanistan | 93 | 阿富汗 +(93) |
| 洪都拉斯 | Honduras | 504 | 洪都拉斯 +(504) |
| 玻利维亚 | Bolivia | 591 | 玻利维亚 +(591) |
| 厄瓜多尔 | Ecuador | 593 | 厄瓜多尔 +(593) |
| 布隆迪 | Burundi | 257 | 布隆迪 +(257) |
| 几内亚比绍 | Guinea-Bissau | 245 | 几内亚比绍 +(245) |
| 塔吉克斯坦 | Tajikistan | 992 | 塔吉克斯坦 +(992) |
| 赞比亚 | Zambia | 260 | 赞比亚 +(260) |
| 布基纳法索 | Burkina Faso | 226 | 布基纳法索 +(226) |
| 瓜德罗普岛 | Guadeloupe | 590 | 法属圣马丁 +(590) |
| 日本 | Japan | 81 | 日本 +(81) |
| 白俄罗斯 | Belarus | 375 | 白俄罗斯 +(375) |
| 芬兰 | Finland | 358 | 奥兰群岛 +(358) |

### 4) Email

- 点击 `Auto`：从 account manager 自动获取账号邮箱并填入
- 若账号备注为 `已注册`，会自动跳过并选择下一个账号
- 或手动粘贴邮箱

### 5) Password

- 留空：自动生成强密码
- 手动填写：使用自定义密码

## 工作流（面板显示 8 步）

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Get Phone Code`
6. `Fill Name / Birthday`
7. `OAuth Auto Confirm`
8. `Callback Verify / Import`

说明：未启用接码平台时，第 5 步会自动隐藏/跳过；启用接码平台后，第 5 步用于 add-phone 手机验证。

---

## 常见问题

### 1) Step 7 报缺少 code/state

如果 callback URL 中包含 `error=request_forbidden` 或 CSRF 相关描述，
说明授权会话失配（常见于页面过期/会话变化）。

建议：

1. 从 Step 1 重新获取新的 OAuth 链接
2. 不要复用过期授权页
3. 按顺序继续到 Step 7

### 2) Sub2API 鉴权失败

- 若后端启用 `x-api-key`，填对应 key
- 若使用管理员登录态，保持 Sub2API 后台页面已登录，API Key 留空即可

### 3) 收不到验证码

优先检查：

- `MSMgr` 地址是否可达
- `MAIL_API_TOKEN` 是否正确
- `Mode` 是否与你服务端配置一致
- `Filter` 是否把目标账号过滤掉了

### 4) 手机接码取号失败

- 确认已启用接码平台并填写对应 API Key
- 确认已点击「加载地区」并选择有库存的地区
- HeroSMS 若使用手动出价，尝试提高价格或改回不限价格
- SMSCloud 若设置价格上限，尝试提高 `maxPrice` 或清空上限
- 确认平台余额充足，SMSCloud 余额单位为「钻石」

---

## 免责声明

本项目仅面向个人学习与自用自动化，不建议用于高频、大规模或滥用场景。
