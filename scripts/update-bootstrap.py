"""Find the project's runtime before invoking npm; no shell PATH assumptions."""
import json
import os
from pathlib import Path
import subprocess
import sys


def launch(root, python=sys.executable):
    root = Path(root).resolve()
    config_file = root / '.fastcat-update.json'
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    name = os.environ.get('UPDATE_BT_PROJECT') or config.get('projectName') or 'fastcat-support'
    result = subprocess.run([python, str(root / 'scripts/baota-project.py'), 'runtime', name, str(root)],
                            text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or '无法识别宝塔项目的 Node 环境')
    metadata = json.loads(result.stdout)
    node = Path(config.get('nodePath') or metadata['node'])
    version = subprocess.check_output([str(node), '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 24:
        raise RuntimeError('此项目需要 Node.js 24 或更高版本，请先在宝塔调整项目运行版本')
    npm = node.parent / 'npm'
    if not npm.is_file():
        raise RuntimeError('项目 Node 环境缺少 npm，请在宝塔修复该运行版本')
    env = dict(os.environ)
    env['PATH'] = str(node.parent) + os.pathsep + env.get('PATH', '')
    os.chdir(root)
    print('已识别项目 Node 环境：' + version, flush=True)
    os.execve(str(node), [str(node), str(npm), 'run', 'update'], env)


if __name__ == '__main__':
    try:
        launch(Path(__file__).resolve().parent.parent)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
