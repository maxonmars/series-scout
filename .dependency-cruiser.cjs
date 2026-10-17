/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "domain-is-pure",
      comment: "domain зависит только от собственных модулей: без других слоёв, Node API и npm-пакетов.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "application-not-to-outer-layers",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: "^src/(app|adapters)/" },
    },
    {
      name: "application-not-to-integration-sdk",
      comment: "Из npm-пакетов application может использовать только zod; node:sqlite — забота adapters.",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: "(^|/)node_modules/(?!zod/)|^(node:)?sqlite$" },
    },
    {
      name: "only-app-imports-app",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/app/" },
      to: { path: "^src/app/" },
    },
    {
      name: "no-dev-dependencies-in-src",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
