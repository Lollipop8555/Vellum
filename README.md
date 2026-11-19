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

- 拖拽导入、文件选择、粘贴文本导入、从 URL 导入（S3 / Nginx 上的配置文件，需对方允许跨域）
- 文件内容写入 IndexedDB，刷新或重开浏览器后仍在
- 最近文件列表，按今天 / 昨天 / 更早分组，可搜索、可切换
- 删除历史记录时连带清理缓存副本与快照
- 内存/磁盘配额显示（`navigator.storage.estimate`）
- 申请持久化存储（`navigator.storage.persist`），降低被浏览器回收的概率
- 多标签页：缓存共用一份，各标签页可以各开各的文件（互不顶掉，刷新才恢复自己那个）；同一文件仍只允许一个标签页写，另一个只读，写完的那页关掉后自动解锁
- 导入 / 删除 / 保存在一个标签页内完成后，其它标签页的文件列表会跟着刷新
- URL 导入只是一次跨域 GET，内容直接进 IndexedDB，不经过任何中转；但浏览器会向该地址暴露你的 IP，且失败多为对方未放行 CORS

### 编辑

- CodeMirror 6 / Monaco 双引擎，顶栏用图标切换（CodeMirror 尖括号 / Monaco 蓝底 M），偏好按文件记忆
- 语法高亮：110 项语言可选，按扩展名/文件名自动识别，也可在语言菜单里手选（见下）
- 自动换行、只读模式、文档信息（大小、行数、字符、字数、语言、引擎、时间）
- 右竖条图标直达：文本加工、文档信息、与历史版本对比、与另一个文件对比、编解码工具；没有打开文件时只留编解码工具
- 字号（11–20px）与强调色开关，入口在编辑区「更多」菜单，跨会话记忆
- 行/列、字符数、字数的状态栏实时显示
- Markdown 右侧预览（左缘拖拽调宽、双击还原、宽度跨会话记住）+ 打印（可直接出 PDF）；非 Markdown 文件不显示预览按钮，免得点了只弹提示
- 预览支持 mermaid 图表（```` ```mermaid ```` 代码块，按需懒加载，仅在有图表时才下载渲染器）
- Markdown 右侧「幻灯片」面板：打开就按 remark 语法分页（`---`、`???` 备注、`name:` / `class:` / `background-*:` 页属性），不需要文件头声明（同一份文档在文档视图里照常阅读），每页 1280×720 画布，正文交给预览同一条渲染管线；页内容默认水平 + 竖直居中（页首写 `class: left, top` 可回到左上排版），一页内容当成一个块整体缩放塞进页面（内容多就缩小、一句话就放大，不裁切），缩放控件与导图同构（按钮、`Ctrl/Cmd + 滚轮` 锚点缩放、适应宽度），可拖拽平移，点页卡或页码跳到该页源码首行
- 放映：面板头 ▶ 在新窗口里全屏放映（被拦截则本页 iframe），键盘翻页 / `f` 全屏 / `p` 演讲者视图（当前页 + 下一页 + 备注 + 计时）/ `b` 黑屏 / `s` 计时 / `h` 帮助 / `Esc` 退出，地址栏 `#p2` 可直接定位；导出按钮把整份演示文稿存成一个自包含 `.html`（样式、代码高亮、图表全内联，断网双击可放）

### 语言支持

语言表在 `src/editors/lang-registry.ts`，一份数据同时喂给语言菜单、扩展名推断和两个引擎的映射，共 110 项（含「纯文本」与「Android Logcat」）：

| 引擎 | 可着色 | 说明 |
|---|---|---|
| CodeMirror | 90 | 15 种官方 lezer 语法（精确、随主包加载）+ 73 种 stream 模式（按语言懒加载，首次选中才下载几十 KB 的 chunk） |
| Monaco | 67 | `basic-languages` 的 Monarch 语法（早已随 Monaco 入库，不用额外拉包），注册后 `setModelLanguage` 即生效 |
| 两个都有 | 45 | 常用语言基本都在这一档 |

Monaco 有两处要自己补：`basic-languages` 里没有 JSON（它属于 `vs/language/json` 语言服务，拉进来会带上 json worker），也没有 logcat。两者都用 `setMonarchTokensProvider` / `setTokensProvider` 在 `src/editors/monaco.ts` 里就地实现，只上色，不做校验与补全，配色与 CodeMirror 对齐。

扩展名与文件名优先于内容嗅探：`.tsx`→TypeScript、`CMakeLists.txt`→CMake、`Dockerfile`→Dockerfile、`nginx.conf`→Nginx。`.m` 归 Objective-C（MATLAB 需在菜单里手选）。两引擎都没有的语言不收，所以菜单里每一行至少有一个引擎能上色。

语言菜单（点状态栏的语言名）是**两个引擎的并集**，带搜索框，可输入英文名、id 或中文别名（如 `汇编`、`数据库`、`容器`），首个按钮是「自动识别」。只有一侧引擎有语法的语言会在条目右侧挂上那个引擎的小图标（悬停有说明）；点它不会白点：当前引擎上不了色时先弹一句确认，确定后连引擎带语言一起换过去。

同一个「无语法」逻辑也体现在状态栏：当前引擎没有这门语言的语法时，高亮徽标一直显示（哪怕文件不大、开关开着），徽标上挂的是能着色的那一侧引擎的图标，点一下同样走确认换引擎。

两个引擎的图标是 `src/ui/icons.ts` 里自绘的简化标记（CodeMirror = 一对尖括号，Monaco = 蓝底「M」山峰），不是官方 logo——两家都没有提供可再分发的矢量资产。界面上尽量用图标代替「CodeMirror / Monaco」这类长名字，名字只留在 tooltip 和弹窗标题里。

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
| 2–20MB | 轻量模式：保留高亮（视口解析），关闭换行与预览，禁用格式化 |
| > 20MB | 只读模式：防误改，高亮、搜索、跳转都还在 |
| > 50MB | 导入前弹一次确认，确认后照常以只读打开；不设硬上限 |

只读不是禁令：点状态栏的「只读」徽标即可强制编辑（徽标变成「可编辑」，再点一次锁回去）。这条路径不跑草稿自动保存，几十 MB 的文本不会被反复重写；切换文件时会替你补写一次草稿，真要落盘还是 `Cmd/Ctrl+S`。

高亮不按体积关：CodeMirror 与 Monaco 都只解析视口附近的行，60MB 日志照样能上色。真觉得卡，点状态栏的「高亮」徽标即可关掉（按文件记忆）。

徽标不会撒谎：没识别出语法的文件（纯文本）在大文件模式下显示「无语法」而不是「高亮」，点它直接打开语言菜单手动指定一个。

草稿自动写入仅在 10MB 以内的文件上启用（2 秒防抖），避免逐键序列化拖慢页面。

### Diff 与快照

- 每个文件保留最近若干快照，显式保存时自动生成一份
- 快照可恢复（恢复前会先把当前内容存一份，避免误操作不可逆）
- 快照与当前内容行级 Diff，自实现 LCS，超大数据自动降级为"整段替换"
- 对比是**左右分栏**（宽版弹窗）：左列基准、右列当前，同行并排对齐，删行只在左侧、增行只在右侧，另一侧留空并压暗；长行截断后悬停可看全文
- 也能和**另一个已导入文件**对比：右竖条「与另一个文件对比」选一个文件当基准；或在左侧文件列表里点该文件的 `≠`
- 差异超过 4000 行时只铺改动附近的内容并给出提示，避免超大文件把弹窗卡死；内容完全相同则只显示一行结论

### 格式化

按需懒加载 Prettier 插件，只有第一次格式化某种语言时才下载：

JSON / JS / TS / HTML / CSS / Markdown / YAML（Prettier）、XML（xml-formatter）、SQL（sql-formatter）

超过 1MB 自动禁用并提示。格式化结果可一次性撤销（沿用引擎 undo 栈）。

### 文本加工与工具

- 行排序、去重、去空行、trim、大小写、Tab/空格缩进转换，入口在右竖条
- Base64、URL 编解码、JWT 解析、时间戳与日期互转

### 界面与偏好

- JetBrains Islands 风格：顶栏岛、左侧竖条 + 悬浮抽屉、右侧预览 + 文档工具竖条、底部状态岛
- 抽屉两阶段动画：先位移（合成器），落定后编辑区一次性偏移并 `layout()`，避免逐帧重排
- 黑白双主题，默认深色，配色集中定义在 `src/ui/styles.css` 的 CSS 变量
- 中英双语，跟随浏览器语言，可在顶栏手动切换
- 快捷键：`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+O` 导入、`Ctrl/Cmd+B` 抽屉、`Ctrl/Cmd+P` 快速切换、`Shift+Alt+E` 切引擎、`Shift+Alt+F` 格式化、`?` 帮助

## 引擎源码固定

CodeMirror、Monaco，以及预览/导图用的渲染库（`mermaid`、`@viz-js/viz`、`markmap-view` 等）的源码都以副本形式放在 `vendor/`，**提交进仓库**，构建和类型检查都只读这份副本：

- `vite.config.ts` 按 `vendor/VERSIONS.json` 生成别名，把 `@codemirror/*`、`@codemirror/legacy-modes`、`@lezer/*`、`@marijn/*`、`monaco-editor`、`markmap-*`、`d3-*`、`mermaid` 等指向本地副本；
- `tsconfig.json` 的 `paths` 指向同一处，所以 `node_modules` 里没有这些包也能通过类型检查与构建；
- CodeMirror / Monaco 在 `package.json` 里已不再声明，npm 升级或 registry 变动都影响不到已提交的产物（其余渲染库仍留着版本声明，给 `vendor:pull` 用）。

因此引擎代码只有在显式同步并提交后才会变化。相关命令：

```bash
npm run vendor        # 从 node_modules 同步（需先 npm i --no-save 对应引擎包）
npm run vendor:pull   # 按 VERSIONS.json 的版本从 registry 重新拉取，并自动补全依赖树
npm run vendor:check  # 离线校验版本、依赖闭包与残留目录，build 会自动执行
```

升级某个引擎：改 `vendor/VERSIONS.json` 里对应版本 → `npm run vendor:pull` → 跑构建与 `plans/TESTING.md` 的相关项 → 提交 `vendor/` 变更。

Monaco 只保留 `esm/`（`dev`、`min`、`min-maps` 是给 `<script>` 用的全量包，已剔除），`vendor/` 合计约 37MB。

### 导图用的 markmap

Markdown 右侧的「导图」面板不是自绘布局，用的是 [markmap](https://github.com/markmap/markmap)（MIT）的渲染引擎：

| 包 | 版本 | 用途 |
|---|---|---|
| `markmap-view` | 0.18.13 | flextree 布局、三次贝塞尔连线、`d3-zoom` 缩放、折叠 —— 全部画法 |
| `markmap-common` | 0.18.9 | 类型与工具函数。它被 `markmap-view` 声明成 peerDependency，不在 `dependencies` 闭包里，所以必须单独进 `ROOTS`，漏了会在运行期报「找不到模块」 |
| `d3` / `d3-*` | 7.9.2 / 3.x | `markmap-view` 的运行时依赖，随 vendor 一起落盘（项目自己不再直接 `import` d3，缩放走引擎的 `rescale` / `fit`） |

- **数据树是项目自己建的**：复用预览那条 remark 管线解析成 mdast，再压成 markmap 的 `IPureNode`（`src/ui/mindmap.ts`）。
- **没有引 `markmap-lib`**：它的唯一用处就是产 `IPureNode`，代价是带进 markdown-it + cheerio + prismjs + katex@0.16 —— 与仓库已有的 remark 管线、katex@0.18 重复且互相打架，自己写四十行就够。
- 节点内容走 `foreignObject`，所以文字仍由我们渲染（加粗、行内代码、代码块、表格、公式、任务列表的样式与预览同源）。
- 引擎的默认样式（`globalCSS`）写在 svg 自带的 `<style>` 里；我们自己的 `.mm2-*` / `.markmap*` 规则在 `src/ui/styles.css`，导出 SVG 时会被抽出来内联进文件。
- 升级：改 `vendor/VERSIONS.json` 里 `markmap-view` 的版本 → `npm run vendor:pull` → `npm run verify`。

### 幻灯片用的 remark 语法层

「幻灯片」面板的分页规则（`---` 分页、`???` 备注、`name:` / `class:` / `background-*:` 页属性、`--` 增量片段、`[.class[...]]` 内容类）来自 [remark](https://github.com/gnab/remark) v0.15.0（MIT），以源码移植的方式放在 `src/ui/slides/port/`：

| 文件 | 上游 | 改动 |
|---|---|---|
| `lexer.ts` | `src/remark/lexer.js` | CJS → ESM/TS；token 增加 `start` 字符偏移 |
| `parser.ts` | `src/remark/parser.js` | CJS → ESM/TS；页增加 `start`；不支持 JS 宏；导出 `cleanInput()` |
| `types.ts` | `src/remark/lexer.js` 的 token 形状 | 类型定义 |

只借语法层，**渲染层没有用 remark 的 DOM/CSS**：每页内容交给项目自己的 `renderMarkdown()` 管线（同一套 remark 插件、同一份 `.markdown-body` 样式），所以代码高亮、表格、公式、图表在各视图里表现一致。放映器（`src/ui/slides/player.ts`）只负责外壳与导航：页 HTML 由壳层逐页重新渲染后传进去，整份 `styles.css` 以 `?inline` 内联，因此新窗口放映与导出的 `.html` 和面板是同一套像素。

写法说明只有一个来源 `src/ui/slides/spec.ts`，同时喂给五处：面板头 `?` 的「幻灯片语法」速查、新建菜单里的「演示文稿」模板、AI 的 system prompt 摘要、AI 的只读工具 `read_deck_spec`，以及问题面板里的结构告警（单行页、页内多 h1、`???` 空备注、跨页引用式链接、拼错的页属性，挂在「Markdown 细则」这一项诊断下）。改语法时只改这一个文件。

同一份文档不需要任何文件头声明就能两用：文档视图里是普通文章（`???` 备注显示为灰色旁注），切到幻灯片视图就按 `---` 分页。

## 开发

需要 Node 22 以上（CI 用 24 LTS）。

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

## 离线（PWA）

生产构建会注册 `public/sw.js`，三层分工：

- **外壳预缓存**：`install` 阶段就把 `index.html`、入口 chunk、样式、图标写进 `vellum-shell-<构建号>`。这一步不能省——Service Worker 在 `window.load` 之后才注册，那时首屏资源早就下载完了，只靠运行时缓存的话第一次访问的缓存是空的，断网刷新只能拿到 503；
- **导航 NetworkFirst**：在线拿新壳，断网退回缓存的 `index.html`；
- **其余资源 CacheFirst**：Monaco、Prettier 插件、mermaid/graphviz 这些按需 chunk 在第一次用到时收进 `vellum-runtime`（缓存名不带构建号，文件名自带内容哈希，跨发布复用），之后离线可用。

清单不手写：`vite build` 之后由 `scripts/build-sw.mjs` 读 `dist/.vite/manifest.json`，从 `index.html` 引用的 chunk 出发沿静态 import 走闭包，再把清单和构建号写进 `dist/sw.js`。每次发布都换构建号，旧外壳缓存在 `activate` 里清掉。清单里的地址全是相对路径，根路径部署与 `/<repo>/` 项目页都不用额外配置。

### 后台离线包（rail 上那个 `{}` 环）

首屏只加载外壳（入口 chunk 里的 CodeMirror、shell、i18n、存储），Monaco、语言包、图表渲染器都在之后补，左侧 rail 底部的环就是它的仪表：

- **三段推进**：引擎（Monaco + worker + 样式）→ 编辑能力（CodeMirror 语言包、拼写词典、Prettier 插件）→ 预览图表（markdown、mermaid、graphviz、plantuml 及其全部子图）。每段占环 1/3，段内按文件推进。
- **补的是字节，不是模块**：用 `fetch` 写进 `vellum-runtime`，不用 `import()`。`import()` 会真的解析执行，Monaco 那 3.5MB 会卡主线程；字节先落盘，真正的 `import()` 等用户切引擎/开预览时发生，直接命中缓存。
- **清单**：`build-sw.mjs` 顺带产出 `dist/prefetch.json`。分段按 manifest 的源文件路径判定（`vendor/@codemirror/legacy-modes/*` → 编辑能力，`mermaid|graphviz|plantuml` → 预览），共享 chunk 靠 BFS 继承所属段；规则漏掉的产物会打日志，避免进度悄悄失真。
- **什么时候跑**：首访不跑（和首屏抢带宽），省流量（`saveData`）或 2G/3G 也不跑——此时环停在 idle，点一下才开始。回访在 `load` 之后、浏览器空闲时默默开跑，跑完环收成一个 4px 的点。
- **失败与暂停**：单项失败静默重试一次，仍失败则进 error 态（环变警示色、`{}` 换 `!`、title 写明项数），点击重试只补没落盘的部分。下载中点环是暂停，再点续传。
- **与离线的关系**：预取只在 Service Worker 接管后启动，且每项落盘后再自己确认一次，所以环走到 100% 就是真的「断网全可用」。没走完就断网时，未缓存的部分会失败；切 Monaco 会降级回 CodeMirror 并给提示，不会卡在半透明编辑区。

`npm run dev` 不注册 Service Worker（否则 HMR 会一直命中缓存）。此时 rail 上的离线环仍会显示，但是置灰不可点——纯粹留作调样式，省得每次改样式都要先构建一遍。验证离线用 `npm run build` + `npm run preview`：DevTools → Application 里确认 `sw.js` 已激活，Network 勾 Offline 再刷新。

## 目录

```
src/
  shell/      外壳：app 状态机、IndexedDB、保存、编码、格式化、Diff、快照、互斥
  editors/    引擎适配：adapter 接口 + codemirror + monaco + lang-registry（语言表）
  ui/         岛屿布局、样式、抽屉动画、对话框、侧栏、状态栏、主题、toast
  i18n/       zh / en 词典与运行时
public/       manifest、图标、Service Worker
vendor/       双引擎与渲染库（mermaid / graphviz / markmap 等）的源码副本 + VERSIONS.json 版本清单
scripts/      vendor-engines.mjs：同步 / 拉取 / 校验；build-sw.mjs：生成 Service Worker 预缓存清单
```

## 已知限制

- 编码只能写回 UTF-8（浏览器 `TextEncoder` 仅支持该编码）
- 刷新后重新解码非 UTF-8 文件需要原始字节；超过 5MB 的非 UTF-8 文件不会保留原始字节副本
- 大文件切换引擎时会重新挂载，30MB 量级需要数秒
- 首次切到 Monaco 需下载约 900KB（gzip），之后由 Service Worker 缓存
- 有 43 种语言只有 CodeMirror 有语法（Haskell、Fortran、Erlang、Groovy、LaTeX 等），在 Monaco 下状态栏显示「无语法」；另有 22 种只有 Monaco 有（ABAP、Apex、Bicep、Q# 等），在 CodeMirror 下同样显示「无语法」

## 隐私

没有服务端。文件内容、历史记录、快照全部留在浏览器本地存储中，清除站点数据即全部消失。

## 许可证

[MIT](LICENSE) © 2026 lollipop

`vendor/` 下是 CodeMirror、Monaco、markmap、mermaid、Graphviz（`@viz-js/viz`）等引擎的源码副本，沿用各自的上游许可证（多数为 MIT，`d3-*` 为 ISC），逐包以副本目录里的 `package.json` / `LICENSE` 为准；版本清单见 `vendor/VERSIONS.json`。
