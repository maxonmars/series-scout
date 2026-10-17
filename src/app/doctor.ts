import { type Environment, type InspectPath, inspectSetting, type SettingStatus, settingGroups } from "./settings.ts";

export const SUPPORTED_NODE_MAJOR = 24;

export type DoctorInput = {
  readonly env: Environment;
  readonly nodeVersion: string;
  readonly inspectPath: InspectPath;
};

export type DoctorReport = {
  readonly text: string;
  readonly ok: boolean;
};

function describe(name: string, status: SettingStatus): string {
  switch (status.kind) {
    case "set":
      return `  ✓ ${name}: задано${status.shown === undefined ? "" : ` (${status.shown})`}`;
    case "default":
      return `  ✓ ${name}: не задано, используется значение по умолчанию (${status.shown})`;
    case "missing":
      return `  ✗ ${name}: не задано`;
    case "invalid":
      return `  ✗ ${name}: некорректно — ${status.reason}`;
  }
}

export function runDoctor({ env, nodeVersion, inspectPath }: DoctorInput): DoctorReport {
  const lines = ["Series Scout: локальная диагностика", "Сетевые соединения не проверяются.", ""];

  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const nodeSupported = nodeMajor === SUPPORTED_NODE_MAJOR;
  lines.push("Node.js");
  lines.push(
    nodeSupported
      ? `  ✓ ${nodeVersion}: поддерживается`
      : `  ✗ ${nodeVersion}: не поддерживается, нужна ${SUPPORTED_NODE_MAJOR}.x`,
  );

  let missing = 0;
  let invalid = 0;
  for (const group of settingGroups) {
    lines.push("", group.integration ? `${group.title} — соединение не проверено` : group.title);
    for (const setting of group.settings) {
      const status = inspectSetting(setting, env, inspectPath);
      if (status.kind === "missing") missing += 1;
      if (status.kind === "invalid") invalid += 1;
      lines.push(describe(setting.name, status));
    }
  }

  const ok = nodeSupported && missing === 0 && invalid === 0;
  lines.push("");
  if (ok) {
    lines.push("Итог: все настройки заданы и прошли локальную проверку; соединения не проверялись.");
  } else {
    const problems = [
      ...(nodeSupported ? [] : ["неподдерживаемая версия Node.js"]),
      ...(missing > 0 ? [`не задано: ${missing}`] : []),
      ...(invalid > 0 ? [`некорректно: ${invalid}`] : []),
    ];
    lines.push(`Итог: ${problems.join(", ")}. Образец настроек — .env.example.`);
  }
  return { text: `${lines.join("\n")}\n`, ok };
}
