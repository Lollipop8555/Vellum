# Vellum

本地优先的浏览器文本编辑器：文件只存在你自己的浏览器里，双编辑器引擎可随时切换。

纯静态站点，无后端、无上传、无账号。

## 为什么是双引擎

文件管理、历史记录、缓存、保存、格式化、Diff 这些都属于"外壳"，与编辑器内核无关。
外壳只写一份，引擎通过 `EditorAdapter` 接口插拔：

- **CodeMirror 6**：首屏加载，大文件表现更好，是默认引擎；
- **Monaco**：按需懒加载（约 900KB gzip），想要 VS Code 手感时再切换。

切换引擎只销毁/重建编辑区容器，文件、光标位置、未保存内容都会保留。

## 功能

### 文件与缓存

- 拖拽导入、文件选择、粘贴文本导入
- 文件内容写入 IndexedDB，刷新或重开浏览器后仍在
- 最近文件列表，按今天 / 昨天 / 更早分组，可搜索、可切换
- 删除历史记录时连带清理缓存副本与快照
- 内存/磁盘配额显示（`navigator.storage.estimate`）
- 申请持久化存储（`navigator.storage.persist`），降低被浏览器回收的概率
- 多标签页互斥：同一文件不会被两个标签页同时写入

### 编辑

- CodeMirror 6 / Monaco 双引擎，顶栏切换，偏好按文件记忆
- 语法高亮：JS/TS、JSON、HTML、CSS、Markdown、YAML、XML、SQL、Python、Java、Go、Rust、C/C++、PHP
- 自动换行、只读模式、文档信息（大小、行数、字符、字数、语言、引擎、时间）
- 行/列、字符数、字数的状态栏实时显示
- Markdown 右侧预览 + 打印（可直接出 PDF）

### 保存

两级策略，自动降级：

1. 文件来自 `showOpenFilePicker` 且授权仍在 → **原地覆盖**原文件；
2. 否则弹出保存对话框选位置；
3. 都不支持（Firefox/Safari）→ 走浏览器下载。

非 UTF-8 文件保存前会提示一次"将另存为 UTF-8"。

### 编码与换行

- 自动识别：BOM → UTF-8 BOM / UTF-16LE / UTF-16BE；否则先试严格 UTF-8，再试 GB18030
- 手动重新解码：UTF-8、UTF-16LE/BE、GB18030（GBK/GB2312 超集）、Big5、Shift_JIS、EUC-JP、EUC-KR、Windows-1252
- 编码只写 UTF-8（浏览器原生能力上限），非 UTF-8 文件保存时提示另存
- CRLF / LF 一键转换
- 二进制防护：NUL 字节比例过高直接拒绝打开

### 大文件

| 大小 | 行为 |
|---|---|
| < 2MB | 完整模式：高亮 + 换行 + 预览 |
| 2–20MB | 纯文本模式：关闭高亮与换行 |
| 20–50MB | 只读模式：防误改，搜索/跳转仍可用 |
| > 50MB | 拒绝导入并提示 |

草稿自动写入仅在 10MB 以内的文件上启用（2 秒防抖），避免逐键序列化拖慢页面。

### Diff 与快照

- 每个文件保留最近若干快照，显式保存时自动生成一份
- 快照可恢复（恢复前会先把当前内容存一份，避免误操作不可逆）
- 快照与当前内容行级 Diff，自实现 LCS，超大数据自动降级为"整段替换"

### 格式化

按需懒加载 Prettier 插件，只有第一次格式化某种语言时才下载：

JSON / JS / TS / HTML / CSS / Markdown / YAML（Prettier）、XML（xml-formatter）、SQL（sql-formatter）

超过 1MB 自动禁用并提示。格式化结果可一次性撤销（沿用引擎 undo 栈）。

### 文本加工与工具

- 行排序、去重、去空行、trim、大小写、Tab/空格缩进转换
- Base64、URL 编解码、JWT 解析、时间戳与日期互转

### 界面与偏好

- JetBrains Islands 风格：顶栏岛、左侧竖条 + 悬浮抽屉、右侧预览、底部状态岛
- 抽屉两阶段动画：先位移（合成器），落定后编辑区一次性偏移并 `layout()`，避免逐帧重排
- 黑白双主题，默认深色，配色集中定义在 `src/ui/styles.css` 的 CSS 变量
- 中英双语，跟随浏览器语言，可在顶栏手动切换
- 快捷键：`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+O` 导入、`Ctrl/Cmd+B` 抽屉、`Ctrl/Cmd+P` 快速切换、`Shift+Alt+E` 切引擎、`Shift+Alt+F` 格式化、`?` 帮助

## 引擎源码固定

CodeMirror 与 Monaco 的源码以副本形式放在 `vendor/`，**提交进仓库**，构建和类型检查都只读这份副本：

- `vite.config.ts` 按 `vendor/VERSIONS.json` 生成别名，把 `@codemirror/*`、`@lezer/*`、`@marijn/*`、`monaco-editor` 等指向本地副本；
- `tsconfig.json` 的 `paths` 指向同一处，所以 `node_modules` 里没有这些包也能通过类型检查与构建；
- `package.json` 不再声明这些依赖，npm 升级或 registry 变动都影响不到已提交的产物。

因此引擎代码只有在显式同步并提交后才会变化。相关命令：

```bash
npm run vendor        # 从 node_modules 同步（需先 npm i --no-save 对应引擎包）
npm run vendor:pull   # 按 VERSIONS.json 的版本从 registry 重新拉取，并自动补全依赖树
npm run vendor:check  # 离线校验版本、依赖闭包与残留目录，build 会自动执行
```

升级某个引擎：改 `vendor/VERSIONS.json` 里对应版本 → `npm run vendor:pull` → 跑构建与 `plans/TESTING.md` 的相关项 → 提交 `vendor/` 变更。

Monaco 只保留 `esm/`（`dev`、`min`、`min-maps` 是给 `<script>` 用的全量包，已剔除），`vendor/` 合计约 37MB。

## 开发

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build
npm run preview
```

## 部署

推送到 `main` 后由 `.github/workflows/deploy.yml` 自动发布到 GitHub Pages。
需要在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**。

本地与 `npm run preview` 都跑在根路径（`http://localhost:5173`、`http://localhost:4173`）。只有项目页这种 `/<repo>/` 子路径部署才需要前缀，由 workflow 注入 `VITE_BASE`；绑定自定义域名或用户页时，删掉 workflow 里那一行即可。

## 目录

```
src/
  shell/      外壳：app 状态机、IndexedDB、保存、编码、格式化、Diff、快照、互斥
  editors/    引擎适配：adapter 接口 + codemirror + monaco + 语言映射
  ui/         岛屿布局、样式、抽屉动画、对话框、侧栏、状态栏、主题、toast
  i18n/       zh / en 词典与运行时
public/       manifest、图标、Service Worker
vendor/       双引擎及其依赖的源码副本 + VERSIONS.json 版本清单
scripts/      vendor-engines.mjs：同步 / 拉取 / 校验
```

## 已知限制

- 编码只能写回 UTF-8（浏览器 `TextEncoder` 仅支持该编码）
- 刷新后重新解码非 UTF-8 文件需要原始字节；超过 5MB 的非 UTF-8 文件不会保留原始字节副本
- 大文件切换引擎时会重新挂载，30MB 量级需要数秒
- 首次切到 Monaco 需下载约 900KB（gzip），之后由 Service Worker 缓存

## 隐私

没有服务端。文件内容、历史记录、快照全部留在浏览器本地存储中，清除站点数据即全部消失。
