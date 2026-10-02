# 配置参考

行为配置统一写在 `config.toml`。相对路径以该文件所在目录为基准，密钥来自选定的环境变量或同目录 `.env`。示例使用2空格缩进；支持多行内联表与尾随逗号。

配置、人设修改后需要重启。未知字段、错误类型和放错层级都会报错，包括未启用群中的错误配置。

## 检查与诊断

```sh
npm run config:check
npm run config:check -- --group 123456789
```

检查不联网、不创建数据库。第二条输出该群的最终策略和字段来源：`program_default` 为程序默认，`defaults` 为公共群策略，`group` 为本群覆盖。模型只输出所选的模型名。不会输出密钥、模型地址或人设正文，但群号和路径仍可能敏感，不要直接公开检查结果。

`membership: not_checked` 表示检查没有验证 Bot 是否已加入该群；配置允许服务不等于群连接已经就绪。

## 应用级配置

以下字段对整个应用生效，不能写入 `defaults` 或群级配置。

| 段 | 字段 | 默认／含义 |
| --- | --- | --- |
| `bot` | `name` | `Listener`；身份信息与本地时间线中Bot自己的昵称。对主人的称呼写在人设中 |
| | `owner_id` | 主人QQ，正整数字符串；启用群服务时必须显式填写，群聊不能修改 |
| `onebot` | `url` | `ws://127.0.0.1:3001`；支持ws/wss，不允许URL用户名、密码、查询参数或fragment |
| | `token_env` | `ONEBOT_ACCESS_TOKEN`，指定必填的OneBot密钥环境变量 |
| | `api_timeout_ms` | 10000 |
| | `reconnect_base_ms` / `reconnect_max_ms` | 1000 / 30000；最大不得小于基础 |
| | `heartbeat_ms` | 30000 |
| `models.<名字>` | `base_url` | `https://api.openai.com/v1`；HTTPS或支持的本机HTTP地址，不允许URL凭证、查询参数或fragment |
| | `model` | **必填**，请求时发给服务商的非空模型ID；模型须支持工具调用 |
| | `api_key_env` | **必填**，该模型密钥所在的环境变量名 |
| | `timeout_ms` | 180000，范围1000..300000 |
| | `max_output_tokens` | 32768，安全正整数；单次模型输出预算，reasoning、正文和工具调用共享，仍受服务商限制 |
| | `opencode_headers` | false；请求添加每群持久 `x-opencode-session` |
| | `transport` | 默认`"chat"`；`"chat"`、`"responses"`，或`{type = "responses", incremental = false}` |
| | `tool_schema` | 默认`"ts"`；`"ts"`、`"both"`或`"json"`，工具的呈现方式，见下文 |
| `runtime` | `max_concurrent_turns` | 2，范围1..8；全局同时运行的唤醒数，同一群不会并行唤醒 |
| `web` | `search` | 缺省不提供`web_search`；联网搜索服务，按`type`区分，见[联网搜索与网页读取](web.md) |
| `storage` | `directory` | `data`，分群及全局数据文件的基准目录 |
| | `telemetry_path` | `<directory>/telemetry.sqlite`，模型用量库 |
| | `registry_path` | `<directory>/group-registry.json`，Bot与面板共享的私有群清单，不含正文或密钥 |
| | `custom_face_directory` | `<directory>/custom-face-originals`，Bot侧受控持久原图目录；相对路径以配置文件目录为基准 |
| | `napcat_custom_face_directory` | 默认与Bot侧原图目录的绝对路径相同；NapCat侧专用绝对POSIX目录，容器部署必须映射到同一实际目录，不得含`.`或`..`路径段 |
| | `artifact_directory` | `<directory>/artifacts`，Bot侧产物文件目录，文件按产物ID命名；须独立于其他存储文件与原图目录 |
| | `napcat_artifact_directory` | 默认与Bot侧产物目录的绝对路径相同；NapCat侧读取产物（上传群文件、发送图片）的绝对POSIX目录，容器部署必须映射到同一实际目录 |
| `logging` | `level` | info；可选debug/info/warn/error |
| | `console` | true |
| | `file` | 缺省开启；关闭用false，自定义用参数对象，不能写true |
| `logging.file` | `directory` | `<storage.directory>/logs` |
| | `retention_days` | 7，范围1..30 |
| | `max_file_mb` | 20，范围1..100 MiB |
| | `max_total_mb` | 200，范围1..1000 MiB，且不得小于单文件上限 |

OneBot毫秒参数的范围为1..2147483647。密钥变量名须为大写字母／数字／下划线组成的合法环境变量名称。`.env` 只接受 `onebot.token_env`、各模型 `api_key_env` 选定的密钥名及面板访问凭证 `DASHBOARD_PASSWORD`；同名进程环境变量优先，包括显式空值。面板密码留空时拒绝访问，至少12字符、最多256字节，不含控制字符；修改后重启面板，详见 [Dashboard说明](dashboard.md)。不要把凭证写进URL或TOML。

文件日志关闭写 `logging.file = false`；只改目录写 `logging.file.directory = "data/logs"`。关闭值不能与文件日志参数同时使用。多个选项可以组合为：

```toml
[logging]
level = "info"
file = {
  directory = "data/logs",
  retention_days = 7,
  max_file_mb = 20,
  max_total_mb = 200,
}
```

文件日志关闭后，可用 `npm run logs -- --directory 路径` 查看指定目录中已存在的日志。

### 具名模型

模型定义在 `[models.<名字>]`，至少一个。名字只要求非空，可以是 `opencode_go`、`qunyou_model` 或带引号的任意文本；它用于群选用、会话识别和用量统计，与请求时发出的模型ID无关。两个名字可以使用同一个模型ID、不同的key。

群通过 `model = "名字"` 选用，可写在 `defaults` 或 `groups."群号"`；只定义一个模型时省略即使用它，定义多个时 `defaults.model` 必填。引用未定义的名字会报错；每个已定义模型的密钥都必须存在，即使暂时没有群使用。

```toml
[models.main]
api_key_env = "OPENAI_API_KEY"
model = "deepseek-v4.1-flash"
transport = {
  type = "responses",
  incremental = false,
}

[models.friend]
api_key_env = "FRIEND_API_KEY"
base_url = "https://example.com/v1"
model = "deepseek-v4.1-flash"

[defaults]
model = "main"

[groups."123456789"]
enabled = true
model = "friend"
```

群切换到另一个模型名时会开始新的模型会话；只修改同名模型的地址、ID或key不会自动重置，必要时由主人发送 `/reset`。

`transport` 仅接受 `"chat"`、`"responses"` 或 `{type = "responses", incremental = true/false}`（最后一项为布尔值二选一）。`"responses"` 默认启用 `previous_response_id` 增量续接；`incremental = false` 发送完整上下文，`true` 启用增量续接。对象必须同时提供 `type = "responses"` 和布尔值 `incremental`，不接受chat对象、缺少incremental的对象或未知字段。

`tool_schema` 决定模型如何看到工具：
- `"ts"`：系统提示词里给出本群已启用工具的TypeScript声明（参数、返回值与用法），请求的 `tools` 只含名字、一句话概要和开放的参数对象。提示词最短。
- `"both"`：同样给出声明，`tools` 另带完整参数结构（不含说明文字）。适合依赖结构化参数才能正确调用的模型。
- `"json"`：不附声明，`tools` 带完整JSON Schema与说明，提示词按能力分段描述规则。

三种方式下程序都按完整定义校验参数，确认队列也一样。切换会改变会话指纹，下次唤醒开始新会话。

## 群策略与继承

`defaults` 定义各群共用的策略，`groups."群号"` 覆盖某个群；没写的配置使用下表中的程序默认值。

| 字段 | 程序默认 | 含义与范围 |
| --- | --- | --- |
| `enabled` | false | false时只服务显式启用的群；defaults为true时服务Bot加入的所有群，群级false用于排除 |
| `model` | 唯一定义的模型 | 选用的具名模型；定义多个模型时defaults必须指定 |
| `persona` | `prompts/listener.md` | UTF-8人设文件路径，非空普通文件，最多16KiB；群级文件完整替换默认人设 |
| `reply.mention` | true | 被真正@时触发 |
| `reply.quote_bot` | true | 有效引用Bot消息时触发 |
| `reply.delay_ms` | [1200, 3000] | 合批等待区间；两个整数，下界0..5000，上界0..10000，上界不得小于下界；[0,0]不额外等待 |
| `reply.cooldown_ms` | 5000 | 范围1000..60000 |
| `reply.random` | false | 随机参与关闭；开启用参数对象，不能写true |
| `session.event_window_size` | 20 | 安全正整数，范围1..9007199254740991；打开时投递的最新未读QQ事件数及运行期QQ缓冲容量，异步结果不占此限 |
| `session.max_transcript_bytes` | 524288 | 范围65536..8388608；本地模型会话容量，不是服务商的token窗口 |
| `execution.max_tool_calls_per_wake` | 96 | 安全正整数，范围1..9007199254740991；一次唤醒全部工具共享 |
| `execution.wake_timeout_ms` | 240000 | 范围1000..600000；一次完整唤醒的时间预算 |
| `messages.mentions` | true | 允许Bot发送成员@，不改变被@触发；不支持@全体或@自己 |
| `observation.reactions` | true | 后台反应观察；与添加回应、查询回应者的工具权限分别设置 |
| `confirmation.ttl_seconds` | 60 | 范围1..60，主人确认操作的有效期 |
| `history.retention_days` | 7 | 范围1..30；本地消息／事件保留天数，不控制服务商保留时间 |
| `storage.database` | 按群生成 | `<storage.directory>/groups/<群号>/listener.sqlite`；可指定属于本群的现有数据库 |
| `tools` | 见工具表 | 按真实工具名称独立授权 |

群号须为无前导零、无空白的正整数字符串。Bot必须真实加入目标群；群聊正文不能将其他群加入服务范围。私聊不服务。

### 怎样覆盖默认值

普通设置按字段继承，数组整项替换。`false`、`0`、`off` 都是明确配置，不会被当成“没写”。例如本群只写 `reply.mention = false`，其他回复设置仍继承 `defaults`。

以下三种设置按**完整功能**覆盖：

- `reply.random`
- 每一个 `tools.<工具名>`

本群没有写这个功能时，完整继承 `defaults`。一旦写了，就替换该功能的整项配置；未写的参数使用该功能的程序默认值，**不继承被替换项的参数**。

```toml
[defaults]
reply.random = {
  probability = 0.2,
  cooldown_ms = 10000,
  max_per_minute = 6,
}

[groups."100000002"]
enabled = true
reply.random = false

[groups."123456789"]
enabled = true
reply.random.probability = 0.1
# 本群其余random参数采用程序默认：cooldown_ms为60000，max_per_minute为2。
```

随机参与开启后的参数为：`probability`（默认0.03，范围0..1）、`cooldown_ms`（默认60000，范围1000..3600000）、`max_per_minute`（默认2，范围1..10）。关闭写 `false`。

### 文件路径与数据保留

各群分别保存消息缓存、事件和模型会话。默认缓存路径为 `data/groups/<群号>/listener.sqlite`，事件和会话库分别在该路径后加 `.events.sqlite`、`.session.sqlite`。

已有本群数据库时，可显式指定：

```toml
[groups."100000002"]
enabled = true
storage.database = "data/listener.sqlite"
```

修改配置不会搬动、清空或重新归属数据库。程序检查各群数据库、全局用量库、群清单、收藏索引／操作账本及SQLite附属文件的路径冲突，包括符号链接和硬链接；不要让多个群共用聊天数据库。另外，设置日志目录时也应避开这些数据文件。

收藏使用两个应用级派生数据库：`<storage.directory>/custom-faces.sqlite`和`<storage.directory>/custom-face-operations.sqlite`。它们按登录账号区分数据，由各群共享同一实际收藏库，不提供单独的数据库路径配置。索引保存资源身份、描述和本地标签，不保存资源URL、图片字节或登录凭证；图片原件存于独立受控目录。原图目录不得与任何数据库、SQLite附属文件或群清单重叠，也不能包含这些存储文件。

`defaults.storage.database` 设置的固定路径会被所有群继承，仅适合明确的单群用途；多群应分别覆盖，或使用自动生成的分群路径。

本地事实记录和模型会话是两种存储。重置或轮换模型会话不会删除本地事实；服务商会话有自己的保留规则。Responses续接失效时会重新建立会话，不自动重放已经执行的写操作。交给模型的图片预览只暂存在内存，不写入会话数据库，重启后需要重新读取；收藏添加用的受控原图缓存另行持久保存，不受聊天保留天数控制。

### 收藏原图目录与容器部署

收藏添加的文件桥目前要求Linux/procfs。Bot先核验本群图片、下载并验证原始素材，再把受控文件路径交给NapCat；模型不能提供任意本机路径或URL。同机部署默认使用`data/custom-face-originals`，不需要维护QQ图片ID清单。

NapCat在容器内时，两侧目录必须映射到**同一实际目录**。例如，将Bot侧`/opt/qqbot/data/custom-face-originals`映射为容器内`/qqbot-custom-faces`，并在配置中填写：

```toml
[storage]
custom_face_directory = "/opt/qqbot/data/custom-face-originals"
napcat_custom_face_directory = "/qqbot-custom-faces"
artifact_directory = "/opt/qqbot/data/artifacts"
napcat_artifact_directory = "/qqbot-artifacts"
```

这两项只是部署文件路径，不是收藏列表；仅填写路径不会建立容器映射。目录须专用且可核验，程序使用目录0700、文件0400权限，按内容摘要保存经过验证的原始字节。缓存限制为512MiB、4096个文件；达到限制时拒绝新增缓存，不自动删除QQ仍可能引用的文件。它不是调用结束即删的临时文件，也不做TTL清理；删除QQ收藏不代表本地原图被同步删除。请勿将此目录作为群共享文件目录或公开下载目录。

若systemd服务启用了只读主目录限制，且素材目录在原有可写范围之外，还需给**该专用子目录**追加`ReadWritePaths`，并在重启前创建目录；不要放开整个NapCat配置目录。容器中的QQ进程也必须能读取这些0400文件，需正确匹配宿主机／容器用户映射。可用一张未提交给QQ的合成图片检验两侧读到相同字节，无须执行真实收藏或发送。一个缓存目录只由一个Bot进程管理，不支持多个独立进程并发管理同一缓存。

## 工具权限与参数

- `direct`：模型可以在本群配置与QQ实际权限内自主执行。
- `confirm`：模型提出操作，由主人在同群发送 `/confirm CODE` 后执行。
- `off`：不向模型提供，执行层也拒绝。

只读及不支持确认的工具只接受 `off`／`direct`；其他工具可以使用三种模式。工具设置不接受布尔值。程序基础工具如发送消息、读取消息、结束唤醒和观察本群事件，不另设可选开关。

有配置参数时写对象，必须包含非off的 `mode`；没有配置参数时直接写模式字符串。关闭只写 `"off"`，不能附带参数。表中“配置参数”指TOML中可填写的资源限制，不是工具调用参数：目标成员、消息、正文等由Bot调用时填写，不写在这里。

### 工具类别

- **QQ功能**：对应QQ中的资料查询、互动、消息发送或群管理功能，由Bot账号通过NapCat操作，仍受QQ实际权限与接口支持情况限制。
- **Bot辅助**：为模型提供阅读、理解或后续关注能力，不是QQ客户端中的同名功能。辅助工具也可能通过QQ接口取得素材；分类不表示它完全离线。

例如，`send_group_ai_voice`调用的是**QQ的AI语音功能**，使用QQ提供的声线把文字发成语音，不是让本项目配置的模型生成音频；`view_images`则把可核验图片提供给**本项目配置的模型**理解，不是调用QQ的“AI识图”。两者名称里都可能涉及AI，但作用不同。

当前共有58个可配置工具：39个默认`direct`、18个默认`confirm`、1个默认`off`。已有显式模式继续优先，不会被新增工具的默认值覆盖。

### 查询与阅读

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `get_group_members` | direct | 否 | 无 | QQ功能 | 分页查看或搜索本群成员列表。 |
| `get_member_info` | direct | 否 | 无 | QQ功能 | 查询指定成员的昵称、群名片、角色等资料。 |
| `get_group_info` | direct | 否 | 无 | QQ功能 | 查询本群名称、人数、容量等资料。 |
| `get_group_honor` | direct | 否 | 无 | QQ功能 | 查询龙王、群聊之火等群荣誉；上游可能不支持或返回不完整数据。 |
| `get_group_mutes` | direct | 否 | 无 | QQ功能 | 查询本群禁言名单；空结果不一定证明无人禁言。 |
| `read_group_notices` | direct | 否 | 无 | QQ功能 | 读取群公告文字、发布者等信息，不展开公告图片。 |
| `read_group_essence` | direct | 否 | 无 | QQ功能 | 查看群精华消息列表及上游可提供的内容。 |
| `get_reaction_users` | direct | 否 | 无 | QQ功能 | 查询某条消息上某种表情回应的参与者，可核对指定QQ号。 |
| `get_group_ai_voices` | direct | 否 | 无 | QQ功能 | 查询QQ提供的AI语音角色／声线，供发送AI语音时选择。 |
| `get_group_file_space` | direct | 否 | 无 | QQ功能 | 查询群文件数量与空间信息；部分上游数值可能是占位值。 |
| `list_group_files` | direct | 否 | 无 | QQ功能 | 查看群根目录或指定文件夹的文件、目录及可操作引用，不保证列出全部文件。 |
| `list_group_requests` | direct | 否 | 无 | QQ功能 | 查看本群待处理的直接入群申请，需Bot有管理员权限；不显示邀请Bot加入其他群的请求。 |
| `view_images` | direct | 否 | `max_download_mb`默认10，范围1..10 MiB；单张图片下载上限，无图片数量配额 | Bot辅助 | 读取本群可核验图片或本群图片产物并提供给模型理解；需要模型支持原生图片输入。 |
| `read_forward` | direct | 否 | 无 | Bot辅助 | 按需展开合并转发供模型阅读，不会将内容转发到群里。 |
| `read_group_text_file` | direct | 否 | 无 | Bot辅助 | 下载并读取本群列表中选定文件的文本内容，不是PDF／Office等通用文档解析器。 |
| `transcribe_voice` | direct | 否 | 无 | QQ功能 | 使用QQ原生识别当前群已知或直接引用消息中的语音，结果先提供给模型，不自动发送。 |

#### 群语音转文字

`transcribe_voice`接受`{message_id}`，只允许当前群本地可见消息或近期消息直接引用的目标；执行前核验登录身份、消息所属群、已知发送者和语音段，再调用NapCat的`fetch_ptt_text`。无需配置独立ASR服务或密钥。设为`off`关闭；只读工具不支持`confirm`。

收到语音并不新增自动唤醒条件，仍使用已有@、引用及随机参与规则。模型按需调用识别，在下一轮看到文字后决定是否回复；识别文字是不可信的用户内容，不授予额外权限。超时、过期消息、QQ不支持或没有识别结果均明确返回失败，不伪装成空白转写；不承诺所有语言、方言或识别准确率。这不是视频或任意音频文件的通用转写接口，也不同于`send_group_ai_voice`的文字转语音。

### JavaScript 计算沙箱

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `execute_javascript` | direct | 否 | 无 | Bot辅助 | 在隔离沙箱执行统一async函数体；`mode`由模型按次调用选择`sync`、`async`或`auto`。最终必须return字符串。 |
| `query_javascript_jobs` | direct | 否 | 无 | Bot辅助 | 查询当前账号当前群的活动任务和未交付结果，可按任务、状态分页。 |
| `cancel_javascript_job` | direct | 否 | 无 | Bot辅助 | 取消当前账号当前群的后台JavaScript任务。 |

细节见 [JavaScript 沙箱](sandbox.md)。三个工具不支持`confirm`，没有新的行为次数配额；`mode`不是配置项。

### 联网搜索与网页读取

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `web_search` | direct | 否 | 无 | Bot辅助 | 通过部署配置的搜索服务搜索网页，返回来源列表。未配置 `[web].search` 时不提供此工具。 |
| `web_fetch` | direct | 否 | 无 | Bot辅助 | 读取公开http(s)网页的可见正文，不访问内网或本机地址。 |
| `create_artifact` | direct | 否 | 无 | Bot辅助 | 把文本或字节保存为本群有期限的产物，供上传群文件等工具使用。 |
| `create_image` | direct | 否 | 无 | Bot辅助 | 把RGBA像素编码为PNG/JPEG/WebP图片产物。 |
| `list_artifacts` | direct | 否 | 无 | Bot辅助 | 列出本群未过期的产物。 |

细节见 [联网搜索与网页读取](web.md)、[产物](artifacts.md)。

### 一次性定时提醒

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `create_reminder` | direct | 否 | 无 | Bot辅助 | 为本群已观察的非Bot消息创建一次性固定文字提醒。 |
| `list_reminders` | direct | 否 | 无 | Bot辅助 | 查询当前账号当前群共享提醒，按状态筛选并实时分页。 |
| `update_reminder` | direct | 否 | 无 | Bot辅助 | 根据提醒id及revision修改尚未发送的pending提醒。 |
| `cancel_reminder` | direct | 否 | 无 | Bot辅助 | 根据提醒id及revision取消pending提醒，不撤回已发送消息。 |

四个工具只接受`off`／`direct`，不支持`confirm`。创建时的工具权限即授权未来发送；到期不再等待主人确认。提醒属于当前群共享资源，由本群已授权AI按群意图管理，不限创建者本人；账号与群之间隔离。创建者身份从核验后的`source_message_id`作者取得，不接受模型自报身份。

创建需提供`source_message_id`、非空`text`、未来的`due_at`及`time_zone`。`due_at`必须是含秒及`Z`或`±HH:MM`偏移的RFC3339时间，`time_zone`为IANA时区（如`Asia/Shanghai`），两者在该时刻的偏移必须一致。修改时间时两项一起提交；修改和取消使用最近查询返回的`id`、`revision`，冲突后重新查询。

提醒持久保存，重启后恢复，`/reset`不会删除，需显式取消。到期直接发送创建或修改时存下的纯文字，不解析CQ、命令或@标记，也不唤醒模型。断线／停机后仅在到期24小时内补发，超过窗口标为`expired`。`stored:true`只表示保存成功，不代表已经发送；发送结果`unknown`不自动重发，避免重复，不能承诺恰好一次送达。正文最多24000 UTF-8字节；列表按单次输出预算截断正文并标注，保留身份、时间、状态和版本。列表是实时offset分页，不是固定快照。

### 互动、发送与关注

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `react_message` | direct | 否 | 无 | QQ功能 | 给消息添加或取消Bot自己的表情回应，不是发送QQ原生表情消息。 |
| `poke_member` | direct | 是 | 无 | QQ功能 | 对指定群成员拍一拍／戳一戳。 |
| `group_sign` | direct | 是 | 无 | QQ功能 | 使用Bot账号在本群签到，不是创建定时任务。 |
| `send_group_image` | direct | 是 | 无 | QQ功能 | 把本群可核验的已有图片或本群图片产物发到当前群，不接受任意URL或本机路径。 |
| `forward_message` | direct | 是 | 无 | QQ功能 | 将一条可核验的本群消息原生转发到当前群。 |
| `send_group_forward` | direct | 是 | 无 | QQ功能 | 将多条可核验的已有消息合并转发，不伪造发送者或正文。 |
| `send_group_ai_voice` | direct | 是 | 无 | QQ功能 | 使用QQ的AI声线把文字作为语音发到本群，不是语音识别或本项目模型的音频生成。 |
| `manage_attention` | direct | 否 | `max_plans`默认16，范围1..32 | Bot辅助 | 管理后续关注计划，如关注下一条消息、指定成员或时间条件；不是QQ日程，也不保证无新消息时定点发言。 |

### 自定义收藏表情

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `list_custom_faces` | direct | 否 | 无 | QQ功能 | 自动读取Bot账号的有界收藏目录，按QQ描述或本地标签检索并返回可操作引用；不是商城系列或跨群历史查询。 |
| `view_custom_face` | direct | 否 | 无，复用`view_images.max_download_mb`的单张图片下载上限 | Bot辅助 | 将所选收藏图片作为视觉附件交给模型；动态图预览仅首帧，需要支持图片输入的模型。 |
| `send_custom_face` | direct | 是 | 无 | QQ功能 | 发送所引用的原始收藏图片，保留GIF/WebP等受支持格式，不把预览JPEG当作原图。 |
| `add_custom_face` | direct | 是 | 无 | QQ功能 | 收藏本群可核验图片，并回查目标、设置QQ描述；可附本地检索标签，各阶段分别报告。 |
| `delete_custom_face` | direct | 是 | 无 | QQ功能 | 删除引用对应的账号收藏，正常提交后立即撤销本地引用，但不冒充QQ删除效果已确认。 |
| `set_custom_face_description` | direct | 是 | 无 | QQ功能 | 修改收藏的QQ描述，读回吻合后确认；可更新本地标签，标签不是QQ描述接口字段。 |

### 群管理与群文件写操作

| 工具 | 默认 | 支持confirm | 配置参数 | 类别 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `mute_member` | confirm | 是 | `max_seconds`默认2592000，范围1..2592000（30天） | QQ功能 | 禁言指定群成员，时长必须为正且不超过配置上限。 |
| `unmute_member` | confirm | 是 | 无 | QQ功能 | 解除指定成员的禁言，不解除全员禁言。 |
| `recall_message` | confirm | 是 | 无 | QQ功能 | 撤回可核验的本群消息，受Bot实际QQ权限限制。 |
| `set_member_card` | confirm | 是 | 无 | QQ功能 | 修改成员在本群的群名片，不改其账号昵称。 |
| `set_group_name` | confirm | 是 | 无 | QQ功能 | 修改当前群的名称。 |
| `set_group_title` | confirm | 是 | 无 | QQ功能 | 设置或移除成员专属头衔，需要Bot为群主。 |
| `set_group_whole_mute` | confirm | 是 | 无 | QQ功能 | 开启或关闭全员禁言。 |
| `kick_member` | confirm | 是 | 无 | QQ功能 | 将成员移出本群，并明确是否拒绝其再次加群。 |
| `set_group_admin` | confirm | 是 | 无 | QQ功能 | 任命或取消群管理员，需要Bot为群主。 |
| `set_group_essence` | confirm | 是 | 无 | QQ功能 | 将可核验消息设为群精华。 |
| `remove_group_essence` | confirm | 是 | 无 | QQ功能 | 取消消息的群精华标记，不是撤回原消息。 |
| `publish_group_notice` | confirm | 是 | 无 | QQ功能 | 发布纯文字群公告。 |
| `delete_group_notice` | confirm | 是 | 无 | QQ功能 | 删除当前公告列表中核验存在的指定公告。 |
| `respond_group_request` | confirm | 是 | 无 | QQ功能 | 同意或拒绝通过申请列表核验的本群直接入群申请，不接受任意申请标识或其他群的请求。 |
| `upload_group_file` | confirm | 是 | 无 | QQ功能 | 把本群产物（create_artifact/create_image生成）上传为群文件，NapCat按共享目录路径读取，不上传任意本机文件。 |
| `create_group_folder` | confirm | 是 | 无 | QQ功能 | 在本群群文件中创建目录。 |
| `delete_group_file` | confirm | 是 | 无 | QQ功能 | 删除本群文件列表中核验选定的文件。 |
| `delete_group_folder` | confirm | 是 | 无 | QQ功能 | 删除本群核验选定的群文件目录，不允许删除根目录。 |
| `leave_group` | off | 是 | 无 | QQ功能 | 请求Bot退出当前群；群主账号操作可能涉及解散风险，默认关闭。 |

### 基础工具（不单独配置开关）

这些也会提供给模型，但不写入 `tools` 配置表：

| 工具 | 类别 | 用途 |
| --- | --- | --- |
| `send_message` | QQ功能 | 向本群发送文字、QQ原生表情、引用回复和成员@；模型普通正文不会自动发到QQ。 |
| `read_message` | Bot辅助 | 读取本群已知消息或可核验直接引用，必要时通过QQ接口核验、补取内容。 |
| `get_wake_state` | Bot辅助 | 查看本轮为何被唤醒、当前身份、未读事件概况和执行预算。 |
| `get_time` | Bot辅助 | 查询当前时间。 |
| `read_events` | Bot辅助 | 读取本地保存的本群消息、撤回、成员变动等事件。 |
| `finish` | Bot辅助 | `mode="soft"` 有新内容时继续处理，否则结束；`mode="hard"` 立即结束。可以不发言。 |

已有显式模式会覆盖默认模式。`direct` 并不要求主人先发言，但也不授予QQ实际没有的权限；设置管理员和专属头衔等操作需要Bot具有群主权限。

工具参数也遵循整项覆盖：

```toml
[defaults.tools]
mute_member = {
  mode = "confirm",
  max_seconds = 120,
}

[groups."100000002"]
enabled = true
tools.mute_member = "direct"
# 本群完整替换mute_member配置，max_seconds采用程序默认2592000（30天）。
# 若希望仍限制为120秒，本群也需要写包含mode和max_seconds的对象。
```

确认操作只允许真实主人在同群、同登录身份下执行，默认60秒内有效，每群最多10个待确认项。确认时再次核验权限与目标；重置、断线、退出群或停止会清空待确认项。

`observation.reactions` 仅控制后台观察，即使开启也不能执行被关闭的回应工具；查询回应者不要求后台观察开启。看图、发送图片、读取转发和转发消息同样独立授权。

## 自定义收藏的使用流程

这组工具操作**Bot登录账号的共享收藏**。某群启用相应工具，即授权该群在该工具权限内访问共享收藏；不是每群各有一份QQ收藏。删除或改描述会影响其他使用同一账号收藏的群。原始聊天消息仍按群隔离：`add_custom_face`只能使用本群可核验图片或其直接引用，不能借收藏功能读取其他群消息。账号切换不能沿用旧账号引用。

### 工具调用参数

以下是模型调用参数，不是TOML配置字段；资源引用由程序生成，不需要用户维护清单。

| 工具调用 | 参数与含义 |
| --- | --- |
| `list_custom_faces` | 可选`query`（描述／标签关键词，最多256字节）、`limit`（1..100，默认48）、`cursor`（仅延续程序返回的本地快照）。返回`face_ref`、描述和标签等安全摘要；有后续页时使用`next_cursor`。 |
| `view_custom_face` | 必填`face_ref`，来自列表或成功修改的返回结果。 |
| `send_custom_face` | 必填`face_ref`；发送当前核验对应的原始素材。 |
| `add_custom_face` | 必填`image_id`和非空`description`；可选`tags`。`image_id`必须来自本群真实消息图片引用，不能自行拼造。 |
| `delete_custom_face` | 必填`face_ref`；目标重新核验后才提交删除。 |
| `set_custom_face_description` | 必填`face_ref`和非空`description`；可选`tags`。修改后采用返回的新引用，不复用旧版本引用。 |

`description`最多2048字节；`tags`最多16项，每项为非空文字且最多128字节。图片、QQ描述和标签都属于不可信资料，不是新的系统指令或授权。需要依据画面判断时，模型先通过看图工具获得实际图片，再在下一轮决定标注或发送；仅看到文件名、已有描述或图片占位不代表重新看过图片。

普通使用顺序是：`list_custom_faces`按“无语”等关键词搜索 → 必要时`view_custom_face`确认画面 → `send_custom_face`发送。新收藏则先通过`view_images`查看本群图片，再用`add_custom_face`提交图片引用和描述。QQ内部`emoId`、`resId`、MD5及资源地址由程序核验维护，不是模型调用参数；真实的安全整数`emoId=0`不会被当作缺失值。

### 描述、标签与部分结果

- QQ收藏保存图片及QQ侧描述；`tags`仅用于本地索引，不会伪装成QQ服务端标签。
- 添加没有原子“图片＋描述”接口，程序依次收藏、回查唯一目标、设置描述。回查无法确定目标时，不猜“最新一张”；标注失败不会重新收藏或自动删除已收藏图片。
- 正常提交不等于确认全部阶段完成。请分别看收藏绑定、描述提交／读回是否确认的结果；不要把“图片已收藏但描述未确认”当成全部失败并重放。部分结果必须先交给模型审查，不能在尚未接收结果的同一轮预先宣称全部成功。
- 正常添加已提交但目录暂未出现时，`reconcile_allowed=true`允许随后用仍可核验的同源图片调用`add_custom_face`进行只读对账：验证唯一候选的原始字节及SHA256后继续标注，**不再次提交添加**。恢复结果明确标出`reconciled_previous_add`及`new_add_dispatched=false`。超时、断网或明确负业务回执形成的未知操作不走这条恢复路径；`/reset`或重启也不会抹掉其防重记录。
- 只有同一资源的描述读回吻合才宣称QQ描述已确认。外部描述或资源身份变化时，本地旧标签不继续冒充当前注释。
- 删除正常提交后，本地引用立即失效；这是防止继续误用的本地撤销，不是QQ服务端已删除的证明。删除后重新添加不会让旧引用复活。
- 程序自动同步索引，无需人工维护图片ID清单；它不会暗中批量调用模型给整个历史收藏库补标，缺少描述的图片需要实际查看后再标注。

### 目录、视觉和原图边界

每次QQ目录请求最多取512项，QQ接口没有已核实的服务端游标。本地索引只保存已观察资源；`coverage=observed_prefix`、`directory_complete=false`不代表全账号目录。`cursor`／`next_cursor`只用于本地固定快照，不能借分页宣称QQ全量覆盖；空列表或当前前缀未出现某项，也不能证明它已被删除。具体查看、发送和修改仍须重新核验，不能只凭旧缓存操作。

`view_images`和`view_custom_face`权限独立：关闭前者不会关闭后者。两者没有图片数量配额，在同一次唤醒中共享成功读取去重状态：成功加载的图片会去重，加载失败的图片可以重试。两者使用本群`view_images.max_download_mb`解析后的单张图片下载上限，默认10 MiB，范围1..10 MiB。将`view_images`设为`off`时不能附加参数，此上限采用程序默认值。发送图片不等于模型已经看过图片。提供给模型的图片保持比例缩放，最长边不超过1568像素，不放大小图；不提供绕过缩放的原图查看入口。

受支持的收藏原图为JPEG、PNG、GIF、WebP；GIF/WebP发送保留原始字节，预览可转为JPEG但只展示首帧，并明确`first_frame_only`。本版拒绝APNG；原图最多10MiB、512帧、总计4000万像素，同时受配置的更小下载上限约束。未知或无法验证的内容不降级成静态图发送。图库操作、看图和原图下载仍受同一唤醒的工具次数、时间和取消约束。

## 运行限制与结果含义

### 能力边界

- 普通消息支持文字、QQ原生表情、引用及成员@；不支持@全体或@自己。
- 历史读取以本地记录和可核验的消息引用为范围，不是任意远端历史搜索。
- 语音转写使用QQ原生识别，可能失败或不准确；不转写视频或任意音频文件。语音不额外触发唤醒，识别文字先交给模型，不自动发到群里。
- 一次性提醒到点发送固定纯文字，不产生@、不唤醒模型；关注计划用于后续群消息触发，两者不同。
- 不提供任意QQ API、任意本机文件读取、登录账号切换、好友关系管理或跨群聊天操作；共享收藏不授予其他群消息的访问权。

### 触发与资源预算

一次唤醒可以连续查询和操作，全部工具共享调用数与时间预算；非法调用、失败和缓存命中也消耗调用次数。主人之后的确认不属于模型额外工具调用。一次完整唤醒达到时间预算，不表示此前所有工具都失败，也不撤销已提交操作。

普通消息不另设片段、文字长度或成员@数量配额；上游QQ仍可能拒绝请求。不支持@全体或@自己。多人的请求会合批处理；进入本轮后的新消息由后续批次处理。普通文字里的CQ或媒体标记不会自动执行为操作。

关注计划可以等待下一消息、指定成员、指定时间或活跃度条件；多个条件满足任一个即可。没有未读消息时不额外调用模型；重置、断线或停止会清空运行期计划。

### 媒体与来源范围

- 看图需要模型原生图片能力。`view_images`只读取本群可核验图片；`view_custom_face`读取本群获准访问的Bot账号共享收藏。下载限制大小和解码资源，并阻止访问私网地址；发送图片不代表模型已经看过它。
- 读取合并转发需明确范围；嵌套内容按需读取。转发内部的发送者声明不是当前发言者身份，不能据此获得管理权限。
- 单条转发和合并转发只接受本群可核验消息，不伪造发送者或正文。
- 群文件使用从本群列表取得的临时引用；内容读取与上传面向文本，不能让模型读取任意本机文件或上传任意路径。
- 公告发布仅支持纯文字；读取公告不会展开其中的图片。入群审批只处理本群真实待处理申请。
- reaction是消息下面的回应，QQ原生表情是消息内容。观察聚合数量不能证明某个人是否参与，需要查询回应者名单。
- 退群默认关闭；上游不能保证区分群主退群与解散，启用前须特别注意。

### 已提交、已核验与结果不明

| 结果 | 含义 |
| --- | --- |
| `executed` 或 `effect_confirmed=true` | 有可核验的效果依据，不表示收件人已读 |
| `ok` 且 `submitted=true`、`effect_confirmed=false` | 接口正常接受请求，但尚未核验最终效果；不是失败 |
| 明确拒绝 | 有明确失败依据，或请求在派发前被拒绝 |
| `unknown` | 超时、断线或异常响应等导致结果不明；可能已经生效，不能盲目重试或用逆操作试探 |

后续取消、沉默或回复失败不会撤销此前已经提交的操作。正常提交后不要仅因没有额外回执而补发。对于reaction，可以在查询可用时核对自身是否在回应者名单；该查询证明的是查询时状态，而不是补造原写操作的回执。

群荣誉、禁言名单、公告及精华列表等可能受上游获取失败或覆盖范围限制，空列表不一定代表不存在。NapCat 4.18.28的冒尖小萌新荣誉未实现，其他荣誉分类获取失败也可能返回空；公告列表可能漏掉部分分区。配置授权不保证上游接口成功或数据完整。

## 隐私与维护

模型按需读取本地群事实，读取的消息、图片与转发内容会发送给所选服务商。应事先告知群成员；本地数据保留配置不能替代服务商的保留政策。

控制台与结构化运行日志不记录聊天正文、人设、模型内容、密钥或确认码，但可能包含QQ和消息ID。模型会话、工具执行账本与私有请求诊断快照包含正文等敏感数据，不要公开数据目录或将其当作匿名统计；诊断快照的访问和保留规则见 [Dashboard说明](dashboard.md)。主人 `/reset` 不删除已保存的群消息与事件。
