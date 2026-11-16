---
name: illustrator
description: 使用本地 Illustrator 连接器创建、检查、编辑和导出原生 .ai 矢量设计稿。用于画板、图层、文字、路径、颜色和设计稿修改；不用于泛指人工智能的 AI 请求。
---

# Illustrator 原生设计稿

通过用户启用的 ie3jp/illustrator-mcp-server 本地连接器操作 Adobe Illustrator。文件附件提供的是路径，不能把二进制 .ai 当文本编辑，也不能把 PDF/SVG 改名为 .ai 冒充原生输出。

## 连接与工具

- 先使用 list_mcp_servers 确认 Illustrator 服务配置和状态。未启用时提示在聊天工具栏的「连接器 → Illustrator」点击图标检测或连接本机 Illustrator；需要本机安装 Adobe Illustrator。连接器自动复用 AgentPet 隔离 Node 运行时，npm 包和缓存也在应用独立目录；运行时尚未就绪时由现有运行时管理器处理安装流程，不要求用户安装系统 Node。不要自行安装其他编辑后端。
- MCP 服务连通仅表示工具协议可用；必须成功读取目标文档或创建文档才能声称 Illustrator 操作可用。上游 Windows COM 桥接仍需本机验证。
- 使用当前可用 MCP 工具的真实名称和参数定义，名称可能被运行时映射。下文是上游原始工具名，不要猜测前缀或参数。工具参数由现有 MCP 渐进加载流程提供。
- 操作始终发生在 AgentPet 所在电脑；当前会话选择 SSH 不会把这个连接器移到远端。远端文件必须先通过已授权方式取得本地副本。

## 检查和定位

- 已有文件先 open_document，以 get_document_info 验证当前文档路径，再按需求读取 get_artboards、get_layers、get_document_structure、list_text_frames、get_images。不要误改用户原先打开的其他文档。
- 确认尺寸、色彩模式、坐标系和必要素材。按返回的 UUID、图层和名称定位目标；目标有实质歧义时先澄清，不批量猜改。
- 转曲文字是路径，不能作为普通文本替换。缺失字体或外链素材影响修改时，说明限制；不要默默替换字体或丢弃素材。指定字体前用 list_fonts 确认准确名称。

## 编辑与保存

- 原生编辑使用 modify_object、manage_layers、replace_color、创建图形/文字等对应工具；保留未涉及的画板、可编辑文字、路径、遮罩及图层。
- 默认先用 save_document 将文档另存到会话工作区的新 .ai 路径，再修改这个工作副本。每次修改前确认活动文档；不同任务不要并发修改同一个 Illustrator 实例的活动文档。
- 新建设计先 create_document，按用途选择尺寸和 RGB/CMYK。使用返回的 coordinateSystem；需要换算时使用 convert_coordinate，不套用网页坐标猜测印刷坐标。
- 未经用户要求不要转曲、合并图层、栅格化或覆盖源文件。原位保存、overwrite 或 close_document 丢弃修改必须符合用户明确意图；普通另存副本无需重复询问。
- 调用失败或超时后先重新检查文档状态，确认是否已执行，再决定重试，避免重复添加对象。持续失败则保留已有成果并报告实际错误。

## 验证与交付

- 保存后复查修改对象及文字内容，并用 export 为受影响画板导出 PNG 预览；有可用视觉工具时检查遮挡、截断和排版，没有时明确仅完成结构验证。
- 印刷任务按需使用 preflight_check，区分完整检查与 coverage 中未覆盖的项目，不擅自修改出血、专色或色彩配置。
- 返回实际生成的 .ai 与预览路径，简述修改内容和未解决项。只有保存工具成功且输出文件存在时才宣称已交付；可用 get_file_metadata 验证。不得把仅保存配置或连通 MCP 说成编辑完成。

上游能力与限制：https://github.com/ie3jp/illustrator-mcp-server
