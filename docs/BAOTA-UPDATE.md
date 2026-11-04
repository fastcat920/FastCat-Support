# 宝塔一键更新

项目内置 `npm run update`，不需要在服务器手写更新脚本。首次部署仍需先安装 Node.js 24、拉取代码、安装依赖并在宝塔创建 Node 项目。

## 全新部署（直接使用网站目录）

统一使用 `/www/wwwroot/support.fastcat.lol`，不再创建 app 子目录。宝塔 Node 项目目录必须与代码目录一致。

重新部署前先停止旧项目，并备份旧 data 目录及推送私钥。此处是全新部署步骤，不要直接删除已有目录。确认目标目录为空；宝塔默认页面或旧文件需先移到备份位置，不能用强制覆盖替代备份。

```sh
cd /www/wwwroot/support.fastcat.lol
git clone https://github.com/fastcat920/FastCat-Support.git .
export PATH=/www/server/nodejs/v24.22.2/bin:$PATH
npm ci --omit=dev
mkdir -p data
chown -R www:www data node_modules
```

`git clone` 最后的 `.` 表示直接下载到当前目录。首次创建网站目录可用宝塔文件管理器完成；空目录才能使用此克隆命令。

如需保留旧业务数据，在首次启动前将备份的 data 目录恢复到这里，再确认 www 用户可读写。新建宝塔 Node 项目：

| 设置      | 值                                 |
| --------- | ---------------------------------- |
| 项目目录  | `/www/wwwroot/support.fastcat.lol` |
| 项目名称  | `fastcat-support`                  |
| Node 版本 | 24 或更高版本                      |
| 包管理器  | npm                                |
| 启动脚本  | start（node server.mjs）           |
| 运行用户  | www                                |
| 项目端口  | 18763                              |
| 实例数量  | 1                                  |

项目环境变量设置 `HOST=127.0.0.1`、`PORT=18763`；HTTPS 域名访问时设置 `COOKIE_SECURE=1`。仅填写宝塔“项目端口”不会改变 Node 的监听端口。推送密钥路径需要按新服务器实际位置重新配置，勿放在公开目录。

项目启动后通过宝塔绑定域名及 SSL；同一域名不要同时绑定两个站点。首次部署先在宝塔启动一次，后续才使用下面的更新命令。

## 日常使用

在仓库目录（包含 package.json 的目录）执行：

```sh
npm run update
```

默认宝塔项目名 `fastcat-support`，找不到时按当前代码目录自动匹配唯一宝塔项目。脚本识别自身所在目录，预检宝塔项目是否存在、仓库是否干净、分支是否为 main；随后 fast-forward 拉取 origin/main，依赖声明/锁文件变化或 node_modules 不存在时运行 npm ci --omit=dev，再调用宝塔自身的 restart_project 并检查本机服务。无需安装第二套 PM2，不修改宝塔启动命令、环境变量或数据目录。

失败不会强制覆盖本地文件，也不会自动回退数据库。拉取或安装依赖失败不执行重启；若依赖安装失败，需根据日志修复后重新执行，期间现有进程仍可能受缺失依赖影响。项目端口优先从宝塔配置读取；读取不到时使用 18763。健康检查是本机 /api/setup 返回 200，不代表域名 SSL、代理、AI 或推送通道均正常。

## 首次取得本命令

旧服务器还没有 update 脚本时，只需先执行一次：

```sh
cd /www/wwwroot/support.fastcat.lol
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
