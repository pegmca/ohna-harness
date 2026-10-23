/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "循环依赖会放大 AI 重构的影响范围。",
      from: {},
      to: { circular: true }
    },
    {
      name: "web-only-uses-shared-contracts",
      severity: "error",
      comment: "Web 只能通过 HTTP DTO 使用 runtime 能力。",
      from: { path: "^apps/finance-web/" },
      to: { path: "^packages/(?!types/)" }
    },
    {
      name: "ohna-web-only-uses-shared-contracts",
      severity: "error",
      comment: "ohna-web 同样只能通过 HTTP DTO（@aiagent/types）消费本地 runtime 能力。",
      from: { path: "^apps/ohna-web/" },
      to: { path: "^packages/(?!types/)" }
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      comment: "Runtime packages 不得反向依赖应用 adapter。",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    },
    {
      name: "ohna-apps-do-not-import-finance-apps",
      severity: "error",
      comment: "ohna 产品线（编码 Agent）不得依赖金融 SaaS 应用层。",
      from: { path: "^apps/ohna-" },
      to: { path: "^apps/finance-" }
    },
    {
      name: "finance-apps-do-not-import-ohna-apps",
      severity: "error",
      comment: "金融 SaaS 产品线不得依赖 ohna 应用层。",
      from: { path: "^apps/finance-" },
      to: { path: "^apps/ohna-" }
    },
    {
      name: "web-feature-public-entrypoints-only",
      severity: "error",
      comment: "跨 feature 只能使用其 index.ts 公共入口，避免读取内部 ui/model/api。",
      from: { path: "^apps/finance-web/src/features/([^/]+)/" },
      to: {
        path: "^apps/finance-web/src/features/([^/]+)/(?!index\\.ts$)",
        pathNot: "^apps/finance-web/src/features/$1/"
      }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(dist|node_modules|\\.playwright-cli)/",
    // 仓库允许纯 import type 形成类型环；架构门禁只阻止运行时依赖环。
    tsPreCompilationDeps: false,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["types", "import", "require", "default"] },
    reporterOptions: { dot: { collapsePattern: "node_modules/[^/]+" } }
  }
};
