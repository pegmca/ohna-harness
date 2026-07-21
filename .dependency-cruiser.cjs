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
      from: { path: "^apps/web/" },
      to: { path: "^packages/(?!types/)" }
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      comment: "Runtime packages 不得反向依赖应用 adapter。",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(dist|node_modules|\\.playwright-cli)/",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["types", "import", "require", "default"] },
    reporterOptions: { dot: { collapsePattern: "node_modules/[^/]+" } }
  }
};
