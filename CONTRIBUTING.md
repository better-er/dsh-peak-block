# 贡献指南 Contributing

感谢你愿意为 **dsh-peak-block** 贡献代码。本文约定仓库的开发、CI 与发布流程，请先读完再动手。

## 仓库结构

- `src/` —— TypeScript 源码，`src/index.ts` 是 host 半身，也是唯一入口。
- `tests/` —— vitest 单测，对 `src/index.ts` 导出的纯函数跑断言。
- `lib/` —— tsdown 构建产物，**不入库**，由 `pnpm build` 生成。
- `docs/` —— README 引用的效果图资源。
- `.github/workflows/` —— GitHub Actions，包含 `ci.yml` 与 `release.yml`。

## 环境

- Node ≥ 22，包管理器用 pnpm。插件零运行时依赖，devDependencies 只有 tsdown、typescript、vitest 与 @types/node。
- 先 `pnpm install` 拉依赖；`prepare` 会自动跑一次构建，从 GitHub 安装时同样如此。

## 日常开发

本地通过才算通过，CI 用同一套检查：

```bash
pnpm typecheck   # tsc 严格类型检查
pnpm test        # vitest 单测
pnpm build       # tsdown 构建 lib/index.js 与 lib/index.d.ts
```

改动涉及对外行为或配置项时，同步更新 `README.md`。

### 编码约定

- 注释默认中文，禁止在句中手动硬换行，避免引入破坏一致性的格式化工具。
- 本插件是 host 单半身：拦截与路由切换全在 host，设置一律经 cordis 配置文件注入，不提供界面配置 UI。
- 源码为 TypeScript 且开启严格模式，构建走 tsdown，产物只进 `lib/`，不要手改产物。

## 分支与提交

- 主分支：`main`。所有改动都通过 PR 进入 `main`，**不直接 push main**。
- 功能分支命名：`feature/<简述>` 新功能、`fix/<简述>` 缺陷、`docs/<简述>` 文档、`chore/<简述>` 杂项。
- 提交信息建议遵循单一职责，中文正文，可带 `feat:` / `fix:` / `docs:` / `chore:` / `bump:` 前缀。

## Pull Request 流程

1. 从最新 `main` 拉出功能分支，提交改动。
2. 本地先过类型检查、单测与构建。
3. 提 PR 到 `main`，按正文自述改动与自测情况。
4. 触发 `ci.yml`：它会在 `main` 的 push 与所有 PR 上自动跑类型检查 + 单测 + 构建 + 产物齐全校验。
5. **CI 全绿是合并门槛**；reviewer 人工复核后合并，main 建议开启分支保护，拒绝 force push 与直接 push。

> fork PR 同样会触发 CI，但工作流不读写仓库 secrets，安全。若你的 PR 需变更 workflow 或发布相关文件，请由仓库维护者复核后再合并。

## 版本与发布 CD

- **发布 = 打 tag**：推送形如 `v0.2.0` 的 tag 即自动发版，无需手动改版本号。`release.yml` 自动执行：
  1. 凭 tag 号把 `package.json` 版本更新为对应值，并提交回 `main`；
  2. 类型检查、单测与构建；
  3. 发布到 npm，走 Trusted Publishing：需先在 npm 包管理页把此仓库的 GitHub Actions 绑定到对应包，无需配置 NPM_TOKEN；
  4. 生成 GitHub Release **草稿**，人工确认后正式公布。
- 人只负责决定发哪个版本并打 tag。注意需先在 `main` 合入待发代码，再打 tag，否则发布的是旧代码。

## 注意事项

- 不到处手动执行发布动作，统一走 tag 触发的工作流，避免发布与源码不符。
- 不要在 PR 中提交多余产物，`node_modules`、`lib/`、`*.tsbuildinfo` 等由 `.gitignore` 排除。
- 不确定的改动，先在 issue 或 PR 里说明意图再动手。

License：本仓库协议为 [MIT](./LICENSE)，贡献即代表同意以该协议发布你的代码。
