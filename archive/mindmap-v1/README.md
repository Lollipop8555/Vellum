# mindmap v1（手写布局版）归档

2026-11-16 归档。这是「导图」面板的第一套实现：完全手写的左→右树布局 + DOM 节点 + SVG 连线。

## 为什么归档

观感没有达到预期：连线是「父节点右缘水平出主干 → 同级共用竖直树脊 → 各自 S 弯落下」，
分叉处必然出现直角，整体看着「直愣愣」，和 MindNode / markmap 那种枝桠状曲线差距明显。
调整过三轮（渐变 → 主干+树脊 → markmap 式 S 曲线 + 下划线节点），用户仍不满意，
决定改用 markmap 引擎另起一版（当时的 `mindmap2`）。2026-11-16 用户拍板用 markmap 版，
v1 的源码已从 `src/` 删除，本目录是唯一快照，只作历史参考，不参与构建。

## 这里的文件

| 文件 | 说明 |
| --- | --- |
| `mindmap.ts` | 归档时的完整实现快照（1245 行），原 `src/ui/mindmap.ts`（已删） |
| `mindmap.css` | 从 `src/ui/styles.css` 抽出的 `.mindmap-*` / `.mm-*` 段落（1454–1860 行） |

现在 `src/ui/mindmap.ts` 是 **markmap 版**，与本目录无关；`src/ui/styles.css` 里的
`.mindmap-*` 也只剩外壳（`.mindmap-body` / `.mindmap-tools`）与 markmap 的样式映射。

## v1 的能力（markmap 版已覆盖的项）

- Markdown 大纲 → 左→右树：标题/列表/段落/引用/代码块/表格/公式/图片都成为一个节点。
- 代码块、表格块按内容真实渲染（最多 8 行 / 5 行数据，超出标 `+N`），节点按内容变高变宽。
- 动态列宽（每列最宽节点 + 间距）、叶子按高度占位、父节点居中于子节点。
- 折叠（点节点右下角的圆点）、折叠态持久化（`localStorage` 记折叠路径）。
- 双击节点原地编辑 → 回写 Markdown 源文件对应行。
- 点击节点 → 编辑器跳到对应行。
- 分支配色走 CSS 变量 `--mm-b*`，主题切换即时生效（不在 TS 里算 hex）。
- 缩放/平移（滚轮 + 拖拽），`mindmap-tools` 里的重置/适配按钮。
- 空文档提示 `mindmap-empty` / 使用提示 `mindmap-hint`。

## 怎么恢复成默认

1. `cp archive/mindmap-v1/mindmap.ts src/ui/mindmap-v1.ts`（别覆盖现有的 markmap 版）
2. 把 `archive/mindmap-v1/mindmap.css` 的内容贴回 `src/ui/styles.css` 的 `.panel-view` 段之后（即 `.markdown-body` 之前），
   注意删掉/改名与现有 `.mindmap-body`、`.mindmap-tools` 冲突的选择器。
3. `src/shell/app.ts` 里再加一个 `createContent` + rail 按钮 + binding（参考 git 历史里 `mindmap2Content` 的接法）。

## 已知问题

- 分叉直角、卡片厚重，观感不接受（本次替换的直接原因）。
- 布局是自写的简化版，不做兄弟节点避让：节点多了以后父子连线可能擦过邻近节点（已有脚本 `/tmp/mmcurve.cjs` 可做曲线-矩形相交检测）。
- 折叠圆点、下划线节点是新版样式，和最初「实心卡片」版样式已不同。
