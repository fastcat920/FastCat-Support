# 0.13 使用说明与运行边界

日期：2026-10-27（Asia/Shanghai）。这些能力为独立实现，具体剩余差异见 REFERENCE-AUDIT.md 的当前版本表。

## 消息通知与设置

设置分为个人资料、通用、消息通知、管理入口及关于。个人资料可修改姓名、暂停/恢复接待；角色和账号权限不能由个人资料接口修改。通用提供三种主题模式，偏好随账号保存。当前仍仅简体中文。

消息通知包含桌面、声音、后台、其他会话、新访客首次咨询和内容预览开关。预览默认关闭。浏览器权限只在用户点击申请按钮时请求，不能从服务器替用户授权；被拒绝需在浏览器站点设置中修改。测试通知遵循已保存的桌面/声音开关。

登录时建立最新消息基线，不把历史消息当作新通知。访客消息事件由 SSE 触发拉取，服务端按当前账号会话权限过滤；自己发送、内部备注和系统消息不触发。前台正在看的会话不重复提醒；其他会话及后台按开关处理，新访客以第一条咨询消息识别。桌面未授权时显示站内提醒；声音还受浏览器播放策略限制。跨标签最近 512 条标识尽量合并，声音节流一秒；不保证跨浏览器唯一。页面关闭后没有离线 Web Push。

## Skills

后台「技能与设备 → Skills」创建、编辑和启停。技能名称使用 1–80 位小写字母、数字、下划线或横线，描述最多 1000 字符，指令最多 25000 字符。可维护最多 30 个源文文件，路径以 references/ 或 scripts/ 开头，每文件最多 30000 字符，总文件内容最多 200000 字符；不能使用路径跳转。

支持从公开 GitHub 目录或 SKILL.md 链接读取带 YAML name/description 的 SKILL.md，默认停用。此导入不读取私有凭据、不抓取整个仓库，引用文件可在编辑中手动补充。包含斜线的分支名建议改用提交 SHA 链接。

智能体高级设置开启 Skills 后获得 skills_list、skills_read、skills_file 工具；模型先按描述发现再读取需要的技能。发现列表最多 50 条摘要。指令与参考源文实际回传模型，不执行 scripts 中代码；业务操作仍需单独绑定工具、工作流或设备。技能启停或修改会使正在生成的旧快照失效。

## 设备代理

管理员在「技能与设备 → 设备」生成五分钟有效的一次性绑定码。设备本地安装本项目源文件和 Node.js，再运行：

```sh
node scripts/device-agent.mjs --server https://support.example.com --code YOUR_CODE
```

内置驱动仅适用于 macOS，默认只声明截图操作，使用系统截屏工具与 Swift/CoreGraphics。操作系统需要操作者自行授予屏幕录制权限；实际桌面控制另需辅助功能权限。只有需要控制时，由设备操作者显式运行：

```sh
node scripts/device-agent.mjs --server https://support.example.com --code NEW_CODE --allow-control
```

更改授权操作需重新绑定；仅改变启动参数不会扩展服务器已登记的操作。绑定后令牌保存在 `.fastcat-device.json`，权限 0600，已加入忽略列表。再次启动可省略 --code；用 --config 指定独立配置文件。远程服务必须 HTTPS，本机调试可 HTTP。其他系统可用 --driver 指向操作者本地认可的 ESM 模块，导出 commands 对象，方法名及参数对应 screenshot/click/typeText/keyPress/scroll。

在智能体资源关联中选择设备。仅登记的操作会暴露给模型；截图以 JPEG/PNG 图片上下文送到所选模型。截图最长边缩放为 1280，返回原始屏幕坐标空间尺寸；click 使用原始屏幕坐标。视觉能力需要模型本身支持。

设备每次领取任务后只执行一次。任务最长等待 45 秒，有运行心跳；取消/断线/服务重启后不自动重试未知结果。停用设备撤销其连接，已完成操作无法回滚。截图和输入参数在结果消费或任务取消后清空，日志不保留截图或输入正文。macOS 源码通过类型检查，未对真实桌面申请权限；本轮协议使用模拟设备验证。

## Markdown 与结构化消息

网页端使用本地分发的 markdown-it 15.0.3，关闭原始 HTML；Flutter 使用 flutter_markdown_plus。客服/AI 消息支持标题、强调、表格、列表、引用、代码和链接，网页代码块可复制。访客原文保持纯文本。HTTP/HTTPS 图片按消息展示，危险 URL 不会执行；网页外链使用 noreferrer/noopener。Flutter 外链由 FastCatChat.onOpenLink 交给宿主处理，未提供回调则不自动打开。

消息继续通过已有 body 字符串传输，支持两种显式信封：

```json
{
  "type": "rich_text",
  "content": "**订单已发货**",
  "images": [{ "url": "https://example.com/order.jpg", "alt": "订单图片" }],
  "file": { "name": "说明.pdf", "url": "https://example.com/info.pdf" }
}
```

图文最多九张图片与一个可选文件，文件链接和已有鉴权附件下载为不同功能。

```json
{
  "type": "json_render",
  "spec": {
    "root": "card",
    "elements": {
      "card": {
        "type": "Card",
        "props": { "title": "订单查询" },
        "children": ["input", "send"]
      },
      "input": {
        "type": "Input",
        "props": { "name": "order", "label": "订单号" }
      },
      "send": {
        "type": "Button",
        "props": { "label": "咨询客服", "message": "查询订单 {{order}}" }
      }
    }
  }
}
```

支持 Card/Section、Row/Column/List、Text、KV、PriceRow（业务金额展示，与已移除的模型计费无关）、Badge、OrderItem、Image、Button、Input、Checkbox、DateTimeInput 和 MultipleChoice，以及对应别名。树最多 200 个节点、12 层；循环或无效内容显示原文，未知组件明确提示。Flutter 日期字段当前为文本输入。

按钮 message 模板引用同一卡片的字段名，点击后仅填入输入框，由用户确认发送；安全 URL 可交给浏览器/宿主打开。不执行任意 JavaScript、模型生成的 HTTP 请求或未知动作。Markdown 的 msg:// 链接也回填消息。

完整 JSON spec 可直接放在 json_render 信封，或整个消息使用 spec/json-render 围栏。尚未实现参考 IM payload、ui_parts、流式 JSON Patch 与全部动作语义；流式中间状态不承诺结构化渲染。SDK 的独立 Dart 客户端继续保留原始 body，Flutter UI 负责渲染。现有消息去重、离线队列和回执不变。

## 验证

107 项服务端测试、11 项 Flutter 测试通过，Flutter 静态分析通过。依赖审计无已知漏洞。浏览器验收使用独立 QA 数据库，截图见核对报告。真实模型、操作系统通知声音/弹窗和真实设备操作仍需在对应部署环境联调；测试数量不代表与参考产品全量等价。

协议实现参考：[固定参考版本通知](https://github.com/tgoai/tgo/blob/995da4577f6f91edb87d0f56fc9ea4c129f1a4eb/repos/tgo-web/src/services/notificationService.ts)、[Skills API](https://github.com/tgoai/tgo/blob/995da4577f6f91edb87d0f56fc9ea4c129f1a4eb/repos/tgo-web/src/services/skillsApi.ts)、[Flutter Markdown Plus](https://pub.dev/packages/flutter_markdown_plus)。
