# 宝塔一键更新

项目内置 `npm run update`，不需要在服务器手写更新脚本。首次部署仍需先安装 Node.js 24、拉取代码、安装依赖并在宝塔创建 Node 项目。

## 日常使用

在仓库目录（包含 package.json 的目录）执行：

```sh
npm run update
```

默认宝塔项目名 `fastcat-support`。脚本识别自身所在目录，预检宝塔项目是否存在、仓库是否干净、分支是否为 main；随后 fast-forward 拉取 origin/main，依赖声明/锁文件变化或 node_modules 不存在时运行 npm ci --omit=dev，再调用宝塔自身的 restart_project 并检查本机服务。无需安装第二套 PM2，不修改宝塔启动命令、环境变量或数据目录。

失败不会强制覆盖本地文件，也不会自动回退数据库。拉取或安装依赖失败不执行重启；若依赖安装失败，需根据日志修复后重新执行，期间现有进程仍可能受缺失依赖影响。项目端口优先从宝塔配置读取；读取不到时使用 18763。健康检查是本机 /api/setup 返回 200，不代表域名 SSL、代理、AI 或推送通道均正常。

## 首次取得本命令

旧服务器还没有 update 脚本时，只需先执行一次：

```sh
cd /www/wwwroot/support.fastcat.lol/app
git pull --ff-only origin main
npm run update
```

## 项目名称或端口不同

只需在仓库根目录保存 `.fastcat-update.json`（该文件已排除 Git，不会上传）：

```json
{ "projectName": "你的宝塔项目名称", "port": 18763 }
```

也可以临时使用 `UPDATE_BT_PROJECT=名称 UPDATE_PORT=18763 npm run update`。默认名称和端口适用时无需创建配置。迁移到新服务器时沿用宝塔项目名称即可，无需重写脚本。

## 运行环境

使用能够管理宝塔项目的 root 终端运行。宝塔会按原来的 www 运行用户重启项目。Python 使用 `/www/server/panel/pyenv/bin/python3`，调用已确认的 `/www/server/panel/mod/project/nodejs/nodeMod.py`。若宝塔将来调整内部接口，需更新项目内的适配文件；不会尝试用陌生 PM2 接管进程。

如果终端找不到 npm，先在宝塔设置命令行 Node 版本，或按实际安装版本执行：

```sh
export PATH=/www/server/nodejs/v24.22.2/bin:$PATH
npm run update
```

运行期间使用进程锁避免同时更新；异常结束留下的锁会在下次执行时检查 PID 并清理。正常使用不会停止另一个更新任务。
