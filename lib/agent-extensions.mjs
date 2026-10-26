import { deviceSchemas } from "./devices.mjs";
export function createAgentExtensions({ skills, devices }) {
  const object = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  return {
    stamp(config) {
      return (
        (config.skillsEnabled ? skills.stamp() : "") +
        "|" +
        (config.boundDeviceId ? devices.stamp(config.boundDeviceId) : "")
      );
    },
    tools(config) {
      const out = [];
      if (config.skillsEnabled) {
        out.push(
          {
            name: "skills_list",
            description: "发现当前启用的专业技能，按描述选择相关技能。",
            inputSchema: object({}),
          },
          {
            name: "skills_read",
            description: "读取技能指令与可用文件。",
            inputSchema: object({ name: { type: "string", maxLength: 80 } }),
          },
          {
            name: "skills_file",
            description: "读取技能参考资料或脚本源文；仅作为文本，不执行脚本。",
            inputSchema: object({
              name: { type: "string", maxLength: 80 },
              file: { type: "string", maxLength: 180 },
            }),
          },
        );
      }
      if (config.boundDeviceId) {
        const d = devices.get(config.boundDeviceId);
        for (const name of d.capabilities)
          out.push({
            name: "device_" + name,
            description:
              "操作绑定设备 " +
              d.name +
              "：" +
              name +
              "。截图会发送给当前模型；点击使用原始屏幕坐标。",
            inputSchema: deviceSchemas[name],
          });
      }
      return out;
    },
    async call(config, name, args, options) {
      if (name === "skills_list" && config.skillsEnabled)
        return skills.catalog().slice(0, 50);
      if (name === "skills_read" && config.skillsEnabled)
        return skills.read(args.name);
      if (name === "skills_file" && config.skillsEnabled)
        return skills.read(args.name, args.file);
      if (config.boundDeviceId && name.startsWith("device_"))
        return devices.call(config.boundDeviceId, name.slice(7), args, options);
      throw Error("未授权的扩展操作");
    },
  };
}
