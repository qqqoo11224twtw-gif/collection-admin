# 应用设计系统（App Design System）开发计划

> 计划日期：2026-07-26 ｜ 最近更新：2026-07-27
> 状态：**Phase 1 已完成**（commit `9928089`）。下一步 Phase 2 = 演示页（顺序已调整，见 §2）。
> 已定：shadcn style = `radix-vega` · radix 依赖 = `radix-ui` 合包 · 字体 Geist ·
> 深色模式接线但不启用 · 密度一档 · 中文为主但不改行高（见 §3）。
> 待定：演示页是否公开部署（§3 d）。
> 起因：onePay 重排 dashboard 时发现"信息密度不舒服"，一查是全家桶级问题——
> 八个仓库共用一套没人选过的默认值（shadcn 出厂设置），外加七层各自演化的补丁。
> 目标：给 **所有应用的 dashboard 面** 一套统一、调过的设计系统 + 一个能打开看的
> 演示页；`starter` 是它的家，各产品通过品牌槽位覆盖自己的那三个值。

---

## 0. 范围与边界（先钉死，否则会互相污染）

SaaSFlare 的设计分两面，**只共享品牌层**：

```
品牌层（两面共享）    字体家族 · 品牌色 · logo/字标
    │
    ├── 网页面        website 已有产品页规范。说服陌生人：大字、留白、
    │   （不在本计划） 品牌浓度高、每页可以不一样
    │
    └── 应用面        ← 本计划。反复使用的工作面：信息密度、可扫读、
        （本计划）     跨产品肌肉记忆。字阶/间距/密度/组件与网页面**不共享**
```

**本计划只管应用面**。website 的营销页规范不受影响，也不要拿本计划的密度去套营销页。

### 0.1 开源边界：starter 是通用脚手架，不能带品牌

`starter` 是对外开源的脚手架（MIT），**不是 SaaSFlare 独占**。所以：

| 归属 | 内容 | 放哪 |
|---|---|---|
| **通用**（进 starter） | 字阶 · 行高 · 间距 · 密度 · 圆角 · 语义色 · 组件基线 · 页面模式 · 演示页 | `starter/packages/ui` + `starter/docs` |
| **品牌**（只在产品仓） | 品牌色值 · favicon/字标 · displayName | 各产品 `apps/web`，通过槽位覆盖 |
| **品牌规范**（文字） | 橘色什么时候用 · logo 留白 · 字标用法 | 跟 website 的产品页规范放一起 |

**判据**：设计系统的 95% 不是品牌。字阶怎么定、中文行高多少、表格一行多高、空状态该说什么话——这些对任何用 starter 的人都成立，放进开源脚手架是卖点而非污染。真·品牌只有三样东西：一个色值、一个 SVG、一个显示名。

**为什么不另建 `saasflare-starter` 仓库**（2026-07-26 讨论结论）：各仓库之间**没有共同 git 历史**，starter → 产品本来就是手工移植（见 `docs/quickstart.md` 与各产品的移植记录）。加一层中间仓 = 两跳手工移植，而中间层是"谁都不在里面干活"的层，会最先腐烂。为三个值付这个代价不划算。
将来若出现大量 SaaSFlare **专属功能**代码（统一账号中心、跨产品导航条、共享计费），再抽——那时抽的是"平台层"，不是"品牌层"。

---

## 1. 调研结论（2026-07-26 全量实测，八个仓库）

数据是本计划的依据，**不要凭印象推翻，要推翻先重测**。

> ⚠️ **2026-07-27 复测修正了本节五处错误**（只重测了 starter + newsletter 两仓，
> 其余六仓的数字未复核，引用时留意）。修正处已就地标注 `【修正 07-27】`。
> 教训：原始调研多处只 grep 了 app 代码，漏掉 `packages/ui` 内部。

### 1.1 已经统一的（不用动）

八个仓库的 `packages/ui/src/styles/globals.css` **字节级相同**（newsletter 除外，见 1.3）：

```
--radius: 0.625rem   --primary: oklch(0.205 0 0)   --muted-foreground: oklch(0.556 0 0)
--background: oklch(1 0 0)   --border: oklch(0.922 0 0)      全部 chroma=0 的纯中性灰
Sidebar: 16rem / 18rem(mobile) / 3rem(icon)      Button: h-9 / h-8(sm) / h-10(lg)   Input: h-9
字体: Geist Variable + Geist Mono
```

**【修正 07-27】字体的接线方式两派，这才是移植时真正打架的地方**：

| | 怎么接的 | 后果 |
|---|---|---|
| starter（及其余六仓） | `apps/web` 的 `body { font-family: "Geist Variable", "PingFang SC", … }` | 字体**不在 token 层**，`packages/ui` 根本没有 `--font-sans` |
| newsletter | `packages/ui` 的 `@theme { --font-sans }` + `html { @apply font-sans }` | 字体在 token 层 |

所以 §3(f) 不是「Geist 还是 Inter」一个问题，是两个：**选哪个字体**（Geist，无争议）+
**走 token 还是 body 规则**（应走 token）。只写 `body` 规则的隐患：Tailwind 的
`font-sans` utility 取值来自 `--font-sans`，没定义就会落回 Tailwind 默认栈，
组件里一旦出现 `font-sans` 就会和 body 的字体不一致。

> starter 现在能正常显示 Geist 是**侥幸**：`body{}` 是无 layer 的裸规则，
> 优先级高于 `@layer utilities` 里的 `.font-sans`，所以赢了。实测
> `getComputedStyle(document.body).fontFamily` = `"Geist Variable", "PingFang SC", …` ✅
> 但这是靠 cascade layer 的微妙规则，不是设计。Phase 3 定 token 时一并规范化。

**但这套 token 从来不是"选择"，是 shadcn 的出厂默认**：里面没有一个品牌值，没有一条为中文调过的行高，语义色（危险/成功/警告）根本不存在。

### 1.2 已经漂移的七个维度

**① 字号——三种流派互不兼容**

| 仓库 | 主力分布 | 流派 |
|---|---|---|
| starter / analytics / affiliate / newsletter | `sm` 20~59 次 > `xs` 11~28 次 | shadcn 标准 |
| tasks | `xs`:35 > `sm`:25 | 密集流 |
| onePay dashboard | `xs`:41 = `sm`:41 | 密集流（只有 12/14px 两级） |
| notify | `[13px]`:12 `[14px]`:5 `[15px]`:4 `[11px]`:4 | 任意像素流 |
| onePay 收银台 | `[12px]`:16 `[13px]`:13 …共 14 种 | 任意像素流 |

**② 行高/字距——除 notify 外无人为中文调过**。`text-sm` 默认行高 1.43、`text-xs` 1.33 是给英文定的；中文密排时行间几乎贴死。notify 是唯一显式写了 `leading-[1.7]` / `tracking-[-0.02em]` 的。

**③ 间距——四种节奏**：starter/newsletter/onePay 用 `gap-2/3/4` + `px-4`；tasks 更紧（`py-2.5`:16、`py-1`:8）；affiliate 自成一套（`py-3`:56、`px-3`:55）；notify 半步值多。

**④ 圆角——五种**：token 是 10px，实际 `rounded-lg`(8) / `xl`(12) / `[20px]` / `[14px]` 混用。

**⑤ 颜色——语义色全靠硬编码**：onePay `text-red-600`:16 + `red-500`:6 + `red-700`:3；affiliate 的"成功绿"有 5 个色阶（emerald-400/500/600/700 + bg）；notify 是唯一 0 处硬编码（走自己的 `--site-*`）。

**⑥ 品牌色未进系统**：`#FF4801` 在 website 有完整色阶（`--cf-orange` / `-bright` / `-deep` / `-saturate` / `-soft`），但**没有一个后台用它**——后台里只出现在 favicon 和 logo 方块上，不参与状态/强调/焦点环。

**⑦ 组件层——三代并存**（与 starter 相比）：

| 仓库 | 内容不同 | 独有组件 |
|---|---|---|
| notify / analytics / affiliate / website | 0 | 0~1 |
| tasks | 4 | sheet · sidebar · skeleton |
| onePay | 0 | sidebar · sheet · table · dropdown-menu · skeleton |
| **newsletter** | **13** | **empty · scroll-area · tabs · textarea · toggle-group · toggle · table · sheet · sidebar · skeleton** |

**⑧ Tab 三种实现零共识**：newsletter 用 Radix Tabs（default 药丸 / line 下划线两个 variant）；tasks 手写圆角药丸筛选条；onePay 手写下划线路由 nav。

**⑨ 深色模式没有切换器**：8 个仓库 **0 个**有主题切换器。

> **【修正 07-27】原文说「`dark:` 类全家桶共 6 处」是错的**——那只数了 app 代码。
> 实测 starter 一家的 `packages/ui/src/components/` 里就有 **11 处**
> （button 4 / input 2 / badge 2 / checkbox / field / input-otp），且**全部由
> shadcn CLI 生成**。所以「砍掉 `dark:`」根本做不到：每次 `shadcn add` 都会写回来，
> 这正是本文档批评 favicon 时说的「靠约定不是靠机制」。
> 结论因此从「先砍」改成「**接线保留、不启用**」，见 §3(a)。

### 1.3 newsletter 的真相（重要，别记错）

newsletter 是最新一代，但**它不是"shadcn 默认"**：

```jsonc
// newsletter/components.json                    // starter / onePay / 其余
"style": "radix-vega",                           "style": "new-york"
"menuColor": "default", "menuAccent": "subtle",  （无这些键）
"rsc": false,                                    "rsc": true
```

```jsonc
// newsletter/packages/ui/package.json 多出来的
"radix-ui": "^1.6.2",              // 合包
"shadcn": "^4.13.0",               // CLI 作为依赖
"next-themes": "^0.4.6",
"@fontsource-variable/inter"       // ⚠️ 与自家 app 的 Geist 冲突，见下
```

**【修正 07-27】上面两条注释原文写错了**：

- 原文说合包「**取代**独立的 `@radix-ui/react-*`」——代码层面对（25 个组件
  **全部** import 自 `radix-ui`，0 个用独立包），但 newsletter 的 `package.json`
  里那 7 个独立包**没删干净，是死依赖**。starter 这次迁移已一并清掉，
  推广到 newsletter 时记得删。
- 原文说 next-themes「装了但代码里没用」——**错，`sonner.tsx` 正在用
  `useTheme()`**。这意味着 newsletter 现在有个隐患：用户系统开深色模式时
  toast 会变黑，而界面其余部分恒为浅色。starter 已用 `forcedTheme` 修掉，
  推广时把这份改动搬过去。

```css
/* newsletter/packages/ui/src/styles/globals.css */
--font-sans: 'Inter Variable', sans-serif;   /* ⚠️ 但 apps/web/package.json 装的是 Geist */
--font-heading: var(--font-sans);
+ --radius-2xl/3xl/4xl  + --chart-1..5
```

**所以"以 newsletter 为基线"意味着三个连带决定**：
1. **换风格 `new-york` → `radix-vega`**（不是升版本，是换风格，组件长相会变）
   —— ✅ **业主已定（2026-07-26）：默认就用 `radix-vega`**；
2. **换依赖形态**：独立 `@radix-ui/react-*` → `radix-ui` 合包 —— ✅ 随 1 一并确定，
   七个仓库的 import 都要改（机械替换，但要一仓一验）；
3. 字体要重新定：newsletter 自己就是矛盾的（ui 说 Inter、app 装 Geist）。**必须显式
   选一个**，且 Geist 是其余七仓的既成事实。—— ✅ **已定：Geist**，见 §3(f)。

> ✅ 三条都已在 starter 落地（2026-07-27，commit `9928089`）。但注意：
> **换 style 不等于设计系统做完了**。newsletter 就是活证据——它早就是
> radix-vega + 最新组件，可 token 全是出厂默认（见下表），所以起因里那个
> 「信息密度不舒服」在它身上原样存在。
>
> **newsletter 相对 starter 只改了 6 处**（07-27 实测 diff）：
> `@import "shadcn/tailwind.css"` · `@import` Inter · `--font-sans` ·
> `--font-heading` · `--radius-2xl/3xl/4xl` · `--chart-1..5` 换成橘色系 ·
> `html { @apply font-sans }`。
> **字阶 / 行高 / 间距 / 密度 / 圆角基数：一个都没动。**
>
> 另注：§1.2⑥ 说「品牌色未进系统」也不够准确——newsletter 的
> `--chart-*` 已经是围绕 `#FF4801` 的橘色阶（`--chart-4: oklch(0.553 0.195 38.402)`，
> 色相 38）。Phase 1 迁移时**没有**把这套橘色带进 starter，符合硬约束 1。

---

## 2. 分阶段计划

格式：**目标 → 做（最小）→ `verify` → 本步不碰**。

> **【2026-07-27 顺序调整】原 Phase 2（token）与 Phase 3（演示页）对调。**
> 原因：原顺序与本文档自己的硬约束 4「数值改动必须先上演示页」矛盾——
> 先调 token、再做那个「用来看」的东西，等于闭着眼睛调。
> 而且现实问题是：**starter 里没有任何 dashboard 页面**（只有登录页和几个
> examples），「默认值合不合适」在当前的 starter 里根本无法回答。
>
> 新顺序：**组件基线 → 演示页（全默认值）→ 看着演示页只改不合适的 token**。
> 好处是 `tokens.css` 初始为空，之后每加一条都必须说得出「在演示页上看到了什么」。

### Phase 0 — 品牌槽位化 ⬜ 未做（与 Phase 1 解耦，可随时插入）

> **【07-27 修订】**原文说「先做，半小时，解锁其余所有阶段」——实际上它**不解锁
> Phase 1**（组件基线已经先做完了，两者无依赖）。而且「半小时」被下面第 4 条撑爆：
> 改包名 `@saasflare-dev/ui` 牵动 4 个 workspace 包 + 全仓 import + tsconfig paths +
> `components.json` 里 5 个 alias。**建议把第 4 条拆成独立的「开源化」任务**，
> 别混在这里稀释掉「半小时」这个卖点。
>
> 另：`--brand` token **不要**加进 `globals.css`（那是 CLI 的地盘），
> 放进 `brand.css`，见 §4 的分层约定。

- **目标**：starter 里出现任何品牌值都算 bug；产品仓覆盖三行即完成品牌化。
- **做（最小）**：
  1. 新建 `packages/ui/src/styles/brand.css`，放 `--brand` / `--brand-ink` 两个 token，**默认中性**（不是橘）；
  2. `apps/web/public/favicon.svg` 换成中性图形——现在是 `fill="#ff4801"` 加一句"fork 请自行替换"的注释，这是**靠约定不是靠机制**；
  3. 文档写死：品牌值只允许出现在产品仓的 `apps/web/src/styles/globals.css` + `public/` + `package.json` 的品牌块；
  4. 顺手清理开源杂质（与本计划同向，可选）：包名 `@saasflare-dev/ui`、`package.json` 的键名 `saasflare`、`source-code-button.tsx` 里硬编码的 `github.com/saasflare-dev/starter`、缺失的 LICENSE 文件。
- **`verify`**：`grep -ri 'ff4801\|saasflare' starter/apps starter/packages` 只剩包名（或清理后为 0）；onePay 那行 `--brand: #ff4801` 改成覆盖槽位的正规写法后，界面无变化。
- **本步不碰**：任何字阶/间距/组件。

### Phase 1 — 组件基线对齐 ✅ 已完成（2026-07-27，commit `9928089`）

- **目标**：starter 的 `packages/ui` = 全家桶唯一基线。
- **实际做了**：
  1. `packages/ui/components.json`（**注意在包内，不在仓库根**）：
     `new-york` → `radix-vega`、`rsc: true` → `false`（starter 是 TanStack Start
     不是 Next，这条一直是错的）、补 `menuColor`/`menuAccent`/`rtl`；
  2. **修正 `tailwind.css` 指向**：原来指向 `../../apps/web/src/styles/globals.css`，
     而 token 实际住在 `packages/ui/src/styles/globals.css`。不改这条，CLI 会把
     radix-vega 带的新 token 写进**产品层**，token 当场分裂成两处。修正后实测
     CLI 全程**没往 globals.css 写任何东西**（只有人手加的 1 行 `@import`）；
  3. 依赖：8 个独立 `@radix-ui/react-*` → 1 个 `radix-ui` 合包；加 `shadcn` 包
     （`@import "shadcn/tailwind.css"` 提供 radix-vega 组件依赖的 `data-open` /
     `data-checked` 等 custom variant，不引组件状态样式不生效）；
  4. 组件：重拉 15 + 新增 10 = **25 个**，与 newsletter 齐平；
  5. 深色模式按 §3(a) 接线但不启用。
- **`verify` 结果**：`pnpm -r typecheck` 四包全过；`biome ci` 退出码 0；
  首页/登录页本地渲染正常，无 hydration 错误；
  实测 `documentElement.className === "light"`、`colorScheme === "light"`。
- **本步没碰**：任何 token 值——字阶/间距/颜色全是出厂默认，留给 Phase 3。

**⚠️ 遗留：`docs/ui-guidelines.md` 未更新**（仍是 65 行泛泛的 Refactoring UI 建议，
没有一条具体数值）。等 Phase 3 定完 token 再一次性重写，现在写等于白写。

### Phase 2 — 演示页 `/design` + 应用模式 ⬅️ **下一步**

- **目标**：一个能打开看的页面，既是规范也是回归基准。
- **本阶段的铁律：token 一律用出厂默认值，一个都不改。** 这一步是「建立基线」，
  不是「调设计」。先把真实的 dashboard 内容铺出来，看默认值到底哪里不舒服，
  再进 Phase 3 定点修——每改一条都要说得出「在演示页上看到了什么」。
- **心理准备：这是整个计划工作量最大的一步**，因为要写「应用模式」那一整套，
  不是半天能完的。但它也是收益最大的一步（见下）。
- **为什么模式比组件重要**：真正让八个应用长得像的不是 Button/Input（那些本来就一样），是**页面级模式**——"一个列表页长什么样""危险操作放哪""空状态怎么说话"。这些现在每个仓库各写各的，才是不统一的实感来源。只做 kitchen sink 会做完发现应用之间还是不像。
- **做（最小）**：`starter/apps/web/src/routes/design.tsx`（与现有 `examples` 路由并列）：
  - **第一屏 · 字阶实验台**：拿 onePay 站点页的真实流水表，4 套字阶/行高并排，现场挑；
  - **第二屏 · Token**：字阶 / 间距 / 颜色 / 圆角 / 密度，每项可视化 + 复制用的 token 名；
  - **第三屏 · 应用模式**（每个一个可交互实例 + "什么时候别用"）：
    workspace 外壳 · 页头（标题+状态+溢出菜单+事实条）· 路由式 tab ·
    数据表格（密度/对齐/数字列/操作列）· 教学式空状态 · 危险区 ·
    分页器 · toast 与确认弹窗的使用边界；
  - **第四屏 · 组件**：现有 25 个 shadcn 组件的全状态展示（含 loading / error / disabled）。
- **`verify`**：本地 `:3000/design` 可跑；每个模式都能从演示页复制到产品里跑通。
- **本步不碰**：产品仓、**任何 token 值**。

### Phase 3 — Token 层（这才是"设计"）

- **目标**：把出厂默认值换成 SaaSFlare 选过的值，并解决"密度不舒服"。
- **前提**：Phase 2 的演示页已经能打开，每一处改动都有肉眼证据。
- **【07-27 修订】做法比原计划简单得多——绝大部分不用碰组件源码。**
  实测 Tailwind v4.1.18 的 `theme.css`，字阶和行高**都是主题变量**：
  `--text-sm: 0.875rem` / `--text-sm--line-height: calc(1.25/0.875)` / `--spacing: 0.25rem`。
  在 `@theme` 里重定义即可，组件里那 15 处 `text-sm` 自动跟着变。

| 项目 | 能否纯 token 搞定 | 手段 |
|---|---|---|
| ① 字阶（定 5 级，相邻级差 ≥ 1.25；正文 ≥ 3 级） | ✅ | `@theme { --text-xs/sm/base/lg/xl }` |
| ② 行高 | ✅ | `--text-*--line-height`。**但见 §3(c)：暂不为中文改** |
| ③ 间距 | ⚠️ 改成**文档约定**，不新造 token | 见下 |
| ④ 语义色 danger/success/warning/info | ✅ | 新增 `--color-*`；组件本来只用 `destructive` |
| ⑤ 密度 | 🅾️ **先靠 ① 修比例** | 见下 |

- **③ 间距不新造语义 token**（原计划要造「页边距/区块/行内」三档）。理由：新 token
  shadcn 组件不认识，只有手写页面时能用，等于凭空多一套要维护的东西。改成一句
  文档约定 + CI 检查：*页边距 `px-6`、区块 `gap-6`、行内 `gap-2`；禁止半步值
  （`py-2.5`/`gap-1.5`）与任意值（`p-[13px]`）*。约束力靠 grep，不靠新 token。
- **⑤ 密度先靠字阶修**。原计划说「表格单元格 `h-10 + p-2 + 12px 字`，格大字小」——
  这是**比例**问题，两条路：压格子（要覆盖组件）或**放大字**（纯 token）。
  onePay 的根因文档自己写了：「只有 12/14px 两级、比例 1.17」——是**字太小**，
  不是格子太大。所以先调字阶，很可能就够了。
  - 兜底手段：25 个组件里 **24 个带 `data-slot`**（共 55 个 slot 名，只有 sonner 没有），
    可以 `[data-slot="table-cell"] { … }` 覆盖尺寸而不动组件源码。
    **但这是兜底，不是方案的一部分**——非到 token 表达不了时不要用。
  - 好消息：radix-vega 的 Card **自带密度档位**
    （`[--card-spacing:--spacing(6)]` + `data-[size=sm]:[--card-spacing:--spacing(4)]`），
    `<Card data-size="sm">` 即可整体收紧。要覆盖的东西又少了一块。
- **`verify`**：演示页上同一张真实表格用「旧值 / 新值」并排；把 onePay 站点页照新值
  改一版，业主现场确认"舒服"。**同时补上防漂移的 CI 检查**（见 §4.7）。
- **本步不碰**：组件源码。

### Phase 4 — 落地与推广

- **第一个靶子：onePay**。理由：最新、痛点最具体（本计划就是它的重排逼出来的）、手上正热。改不动的地方就是标准的坑，当场修标准。
- **推广顺序**（按 改动成本 × 收益）：

| 顺序 | 仓库 | 主要工作 | 成本 |
|---|---|---|---|
| 1 | onePay | 接 token + 用模式重写站点页/概览 | 中（正在改） |
| 2 | newsletter | 已是新一代，主要是接 token + 消除 Inter/Geist 矛盾 | 低 |
| 3 | tasks | 有 sidebar、结构最像；字号从 `xs` 主力回调 | 中 |
| 4 | analytics | 组件旧一代，页面少 | 中 |
| 5 | notify | 有自成一套的 `--site-*` 体系，要先谈判哪些保留 | 高 |
| 6 | affiliate | 间距自成一套（`px-3 py-3` 55/56 次），改动面最大 | 高 |

> **【07-27 调整】starter 自己从第 7 位提到第 2 位**（紧跟 onePay 之后）。
> 原顺序把源头排在最后不合理：starter 的示例页不更新，就会和 `/design` 演示页
> 长得不一样，后面每个仓库移植时不知道该抄哪个。正确做法是 onePay 暴露的坑
> **当场固化回源头**，再往下推。

- **`verify`**：每仓迁完跑 `pnpm typecheck` + `biome ci` + 该仓的测试；截图对比不出现密度倒退。

---

## 3. 动手前必须定的问题（07-27：七条已定六条）

| # | 问题 | 选项 | 倾向 |
|---|---|---|---|
| a | ~~**深色模式**~~ | ~~砍 / 正式支持 / 保留 token 不做切换器~~ | ✅ **已定 07-27：接线保留，不启用。** 不砍——`dark:` 由 CLI 生成，砍了每次 `add` 都回来（见 §1.2⑨ 修正）。做法：留 `next-themes` + `<ThemeProvider forcedTheme="light">`，主题开关集中在 `__root.tsx` 一处。**`.dark` 的 token 值标记为「未维护」**，仍是 shadcn 出厂值，Phase 3 调 `:root` 时不同步调它；将来真要开深色，需先重配一遍 |
| b | ~~**密度档位**~~ | ~~一档 / 两档~~ | ✅ **已定：一档** |
| c | ~~**字阶基准**~~ | ~~中文为基准 / 英文为基准 / 两套按语言切~~ | ✅ **已定 07-27：中文界面为主，但\*\*不为中文改行高\*\***。业主指出各产品都是中英可切换的，一套 CSS 要同时服务两种语言。且 starter 现在 `<html lang="en">` 写死、**无任何 i18n 基础设施**，连做 `:lang` 分支的前提都不存在。将来若要按语言分行高，前提是产品仓 i18n 切换时同步改 `<html lang>` |
| d | **演示页部署** | `design.saasflare.dev`（破 starter 不部署的规矩）/ 只本地跑 / 放 website | ⬜ **唯一待定项**。不阻塞 Phase 2 开工，但会影响演示页写成本地路由还是可部署 app，动手前定 |
| e | ~~**shadcn style**~~ | ~~`radix-vega` / `new-york`~~ | ✅ **已定 2026-07-26：`radix-vega`**，07-27 已落地。组件长相确有变化，最显著的是 **destructive 从实心红底白字变成淡红底红字**（button + badge 都是），危险操作的视觉权重明显降低——迁移各仓时重点看危险区 |
| f | ~~**字体**~~ | ~~Geist / Inter~~ | ✅ **已定：Geist**。但真正要做的是**改接线方式**——把字体栈搬进 `--font-sans` token（见 §1.1 修正），中英文栈共存无问题，`"Geist Variable", "PingFang SC", …` 对没装中文字体的系统会自动 fallback，零成本 |
| g | ~~**radix 依赖形态**~~ | ~~合包 / 独立包~~ | ✅ **已定：`radix-ui` 合包**，07-27 starter 已落地并清掉 8 个独立包。其余仓迁移时注意 newsletter 的教训：它换了合包但**没删独立包**，留下 7 个死依赖 |

---

## 4. 硬约束（违者返工）

1. **品牌值不进 starter**。出现即 bug（Phase 0 之后）。
2. **不新建 `saasflare-starter` 仓库**（理由见 §0.1）。要改这个结论，先解决"两跳手工移植"的腐烂问题。
3. **本计划不管网页面**。website 的产品页规范独立演进，不要拿应用面的密度去套它。
4. **数值改动必须先上演示页**。任何字阶/间距/颜色的调整，先在 `/design` 并排看得见，再进 token。
5. **移植是手工的**。starter 与各产品无共同 git 历史，`git merge` / `cherry-pick` 不可用；按文件清单逐个搬，搬完各仓自己跑 typecheck + biome + 测试。
6. **一次只推一个仓库**。不要八个仓库同时迁——第一个（onePay）会暴露标准的坑，坑没修完不要扩散。
7. **【新增 07-27】数值约束必须有可执行的检查，不能只写进文档。** 八仓漂成七个维度的
   根因不是"没标准"，是"定了没人守"。Phase 3 定完 token 必须同时落一条 CI 检查
   （biome 规则或 grep）：禁止裸 `text-red-*` / `text-\[\d+px\]` / `rounded-\[` /
   半步间距。没有这条，一年后照样漂回去，而且 Phase 4 每仓验收只剩"截图看着没倒退"
   这种主观标准。
8. **【新增 07-27】`packages/ui/src/components/` 一律不手改。** 那是 shadcn CLI 的地盘，
   手改会在下次 `shadcn add --overwrite` 时被静默冲掉。设计系统的自定义值放在
   **我们自己的文件**里（下方分层方案）。

### `packages/ui` 的分层约定（Phase 3 开工前建好）

```
packages/ui/src/styles/
├── globals.css   ← shadcn 的地盘。CLI 写。人只在末尾加 @import，内容一律不改
├── tokens.css    ← 我们的地盘。【只有变量赋值，一个选择器都没有】
└── brand.css     ← 品牌槽位，starter 里默认中性，产品仓覆盖三个值
```

`globals.css` 末尾追加 `@import "./tokens.css"; @import "./brand.css";`——
后 import 的赢，覆盖顺序天然正确；CLI 更新只动 `globals.css`，我们的文件毫发无伤。
唯一要守的是「末尾那两行别被冲掉」，diff 一眼可见，也可加进 CI 检查。

> `globals.css` **现在已经被污染了**（尾部那段 `button:not([disabled]) { cursor: pointer }`
> 是手写的）。建分层时把它一并搬走。

**规矩：`tokens.css` 里不允许出现任何选择器。** 将来若真需要 `data-slot` 覆盖，
单开 `overrides.css`——文件名本身就是警告，且每条必须写注释说明「为什么 token 做不到」。
「我们到底覆盖了多少东西」= 看这个文件有几行。理想状态是它不存在。

### 重拉组件后必须重新应用的改动清单

CLI 覆盖会静默丢弃这些。**每次 `shadcn add --overwrite` 之后逐条核对：**

| 组件 | 偏离内容 | 为什么 |
|---|---|---|
| `sonner.tsx` | `export { Toaster, toast }`（上游只导出 `Toaster`） | 应用代码统一从 `@saasflare-dev/ui` 取 `toast`，不必各 app 单独依赖 `sonner` 包。丢了会直接编译不过，算是有 typecheck 兜底 |

截至 07-27，25 个组件里**只有这一处**，其余 24 个是纯上游版本，重拉零负担。
新增偏离时务必补进本表并在组件文件里留英文注释。

---

## 5. 相关文档

- `docs/ui-guidelines.md` —— 现有的 UI 约定（组件安装方式、import 规则）。**Phase 3 结束后**应被本系统的具体数值取代其中的泛泛建议（Phase 1 时故意没动，那时还没有数值可写）。
- `docs/coding-standards.md` —— 通用编码规范。
- onePay `docs/design/plans/multi-site-dashboard.md` §5.1 —— dashboard 信息架构的实战演化记录（站点页三 tab、路由式 tab、事实条、危险区），Phase 3 的"应用模式"可直接取材。
- website 的产品页设计规范 —— 网页面，本计划不覆盖。
