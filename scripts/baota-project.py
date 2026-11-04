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
    rows = public.M('sites').field('name,path,project_type,project_config').select()
    if not isinstance(rows, list):
        raise SystemExit('无法读取宝塔项目列表，请在宝塔确认 Node 项目已创建')
    matches = []
    for row in rows:
        settings = row.get('project_config') or {}
        if isinstance(settings, str):
            try:
                settings = json.loads(settings)
            except (ValueError, TypeError):
                settings = {}
        paths = [row.get('path'), settings.get('path'), settings.get('project_path')]
        if any(isinstance(path, str) and os.path.realpath(path) == os.path.realpath(root) for path in paths):
            candidate = manager.get_project_find(row['name'])
            if candidate:
                matches.append((row['name'], candidate))
    if len(matches) != 1:
        raise SystemExit('无法按目录唯一匹配宝塔 Node 项目，请在 .fastcat-update.json 设置 projectName 为宝塔实际项目名称')
    name, project = matches[0]
if project.get('path') and os.path.realpath(project['path']) != os.path.realpath(root):
    raise SystemExit('宝塔项目目录与当前仓库不一致，停止更新')
config = project.get('project_config') or {}
if isinstance(config, str):
    config = json.loads(config)
port = config.get('port') or config.get('project_port') or project.get('port') or 18763
if mode == 'runtime':
    from pathlib import Path
    override_file = Path(root) / '.fastcat-update.json'
    override = json.loads(override_file.read_text()) if override_file.exists() else {}
    node = override.get('nodePath')
    if not node:
        version = next((config.get(k) for k in ('nodejs_version', 'node_version', 'nodeVersion') if config.get(k)), None)
        if version:
            version = str(version)
            if not version.startswith('v'):
                version = 'v' + version
            if not all(c in 'v0123456789.' for c in version):
                raise SystemExit('宝塔 Node 版本格式无法识别，请在 .fastcat-update.json 设置 nodePath')
            node = str(Path('/www/server/nodejs') / version / 'bin/node')
        else:
            running = set()
            for pid in Path('/proc').glob('[0-9]*'):
                try:
                    if os.path.realpath(pid / 'cwd') == os.path.realpath(root):
                        exe = os.path.realpath(pid / 'exe')
                        if Path(exe).name == 'node' and Path(exe).is_file():
                            running.add(exe)
                except OSError:
                    pass
            if len(running) == 1:
                node = running.pop()
            else:
                installed = list(Path('/www/server/nodejs').glob('v*/bin/node'))
                if len(installed) == 1:
                    node = str(installed[0])
    if not node or not Path(node).is_file():
        raise SystemExit('无法唯一确定项目 Node 版本，请在宝塔选择版本，或在 .fastcat-update.json 设置 nodePath')
    print(json.dumps({'node': node}))
elif mode == 'check':
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
