"""Use the installed panel's project manager; never print its configuration."""
import importlib
import json
import os
import sys

panel = '/www/server/panel'
sys.path[:0] = [panel, panel + '/class', panel + '/class_v2']
os.chdir(panel)
import public

mode, name, root = sys.argv[1:4]
manager = importlib.import_module('mod.project.nodejs.nodeMod').main()
project = manager.get_project_find(name)
if not project:
    raise SystemExit('宝塔中没有找到项目：' + name)
if project.get('path') and os.path.realpath(project['path']) != os.path.realpath(root):
    raise SystemExit('宝塔项目目录与当前仓库不一致，停止更新')
config = project.get('project_config', {})
if isinstance(config, str):
    config = json.loads(config)
port = config.get('port') or config.get('project_port') or project.get('port') or 18763
if mode == 'check':
    print(json.dumps({'port': int(port)}))
elif mode == 'restart':
    args = public.dict_obj()
    args.project_name = name
    result = manager.restart_project(args)
    if not isinstance(result, dict):
        raise SystemExit('宝塔返回了无法识别的重启结果')
    status = result.get('status')
    code = result.get('code', 0)
    if status is False or status == -1 or code not in (0, 200):
        raise SystemExit('宝塔重启失败，请查看面板项目日志')
    print('宝塔已执行重启')
else:
    raise SystemExit('无效操作')
