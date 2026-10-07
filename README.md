# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：按站位布设样带，外业队下水按管登记采样（管号、暂定属名、采样覆盖长度），实验室按测序批次回鉴定属名 / 置信度 / 鉴定人，两边按管号对账；礁区覆盖率与白化指数统一按实验室鉴定属名归并，并评定白化等级、记录鱼类计数。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore` / `labStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord | 新建/编辑/删除礁区，按保护区状态与面积分档筛选，卡片汇总站位数、样带数与本礁区平均白化指数 |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验（纬度 ±90、经度 ±180）并显示度分秒，按水深区间筛选，展开样带 |
| `/sites/:id/belts` | 样带布设 | Belt、Site、CoralSample、FishCount | 布设样带（编号、长度、朝向、调查日期、调查人），回显已录采样管数（含暂定数）、覆盖率与白化指数，朝向排序校验 |
| `/belts/:id/samples` | 外业采样管登记 | CoralSample、Belt、Identification | 外业队下水按管登记**管号、暂定属名、形态、采样覆盖长度、白化等级**；管号全局唯一（对账主键，登记后不可改）；汇总按实验室鉴定属名归并，未鉴定的标「暂定」；批量粘贴、批量改级。旧路径 `/belts/:id/corals` 自动重定向到此 |
| `/lab` | 实验室鉴定与管号对账 | Identification、CoralSample | 实验室按测序批次录入**鉴定属名、置信度、鉴定人、成功/失败**；鉴定失败只在本侧追加重试，外业采样不动；待鉴定管与对不上的孤儿鉴定分列；支持批量录入与每管鉴定历史 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt | 按科名与体长段录入数量，按类别筛选与批量改类别，按科名和体长段汇总并折算密度（尾/100 m²） |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 | 白化等级分布与按样带/按礁区汇总（**属名按实验室口径归并、暂定覆盖单列**）、管号对账告警、按属名归并表、结构版本查看、全量 JSON 导入导出与覆盖度/对账 CSV 导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # reef / site / belt / coralRecord(枚举) / sample / identification / fishCount / filter
        ├── stores/             # reefStore / beltStore / surveyStore / labStore
        ├── components/common/  # BleachTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCoverage
        ├── pages/              # ReefList / SiteList / BeltBoard / SampleEntry / LabBoard / FishEntry / CoverageView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # bleach.ts（白化与覆盖度算法）/ reconcile.ts（管号对账与属名归并口径）/ migration.ts（旧数据补管）/ db.ts（Dexie 封装）/ export.ts（导入导出、CSV 与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（v3）**：`reefs`（礁区）、`sites`（站位）、`belts`（样带）、`samples`（外业采样管：管号/样带/暂定属名/形态/覆盖长度/白化等级）、`identifications`（实验室鉴定：管号/批次/成功失败/鉴定属名/置信度/鉴定人）、`fishes`（鱼类与无脊椎动物计数）。
- **样本层与统一口径**：属名分「外业暂定」与「实验室鉴定」两侧，归并逻辑只在 `utils/reconcile.ts` 一处——每管取**最近一条成功**鉴定的属名为有效属名，否则按外业暂定属名计入并标「暂定」；汇总页、各页面与 JSON/CSV 导出全部消费同一结果。鉴定失败只在 `identifications` 侧重试（追加记录），外业 `samples` 不改动。
- **管号对账**：两边按 `tubeNo` 对账。实验室有、外业没有 = 孤儿鉴定（`/lab` 与 `/coverage` 列出，等外业核对补采样，补齐前不计入覆盖率）；外业有、没有成功鉴定 = 待鉴定管（列出等实验室补，当前按暂定属名计入）。
- **升级迁移（v2 → v3）**：旧 `corals` 表没有管号，v3 升级时逐条按「样带 + 属名」补成 `LEGACY-0000xx` 的**待鉴定**采样管（暂定属名取旧属名，形态/覆盖长度/白化等级继承），随后删除 `corals` 对象库。因 `corals` 在 v3 schema 中被删除，迁移经底层原生 `IDBTransaction.objectStore('corals')` 读旧表（Dexie 的 `tx.table()` 拿不到被删表）。旧版 JSON 备份导入走同一补管逻辑。可用 `npm run verify:migration` 回归迁移与对账口径。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 个礁区 / 4 个站位 / 5 条样带 / 14 根采样管 / 12 条鉴定（含失败重试、属名改判、待鉴定与对不上的孤儿管号）/ 12 条计数记录），覆盖「无 / 轻 / 中 / 重 / 死亡」全部白化等级。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新，页面只读消费。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%（覆盖长度取自采样管、属名按实验室口径归并）；白化指数 = 按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4），并按指数换算总体等级；鱼类密度 = 计数 / （样带长度 × 1 m）× 100（尾/100 m²）。
- **备份与恢复**：`/coverage` 页可导出包含六张表的 JSON 快照（另可导出「样带覆盖度结论 + 管号对账明细」两份 CSV，口径与页面一致），支持「覆盖导入」与「追加导入（重新分配 id，鉴定记录按重映射管号跟随）」；旧版（含 `corals` 表）备份导入时自动补 `LEGACY` 待鉴定管；备份时间写入 `localStorage`，页脚与汇总页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
