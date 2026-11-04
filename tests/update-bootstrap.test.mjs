import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
test("bootstrap starts npm with discovered Node without relying on shell PATH and rejects old Node", () => {
  const script = `
import importlib.util, tempfile, pathlib, json, os
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('bootstrap', ${JSON.stringify(resolve("scripts/update-bootstrap.py"))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Executed(Exception): pass
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp); node=root/'runtime/bin/node';node.parent.mkdir(parents=True);node.touch();(node.parent/'npm').touch()
 def execute(path,args,env):
  assert path==str(node)
  assert args==[str(node),str(node.parent/'npm'),'run','update']
  assert env['PATH'].split(os.pathsep)[0]==str(node.parent)
  raise Executed()
 with patch.dict(os.environ,{'PATH':''}),patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'node':str(node)}))),patch.object(m.subprocess,'check_output',return_value='v24.22.2'),patch.object(m.os,'execve',side_effect=execute),patch.object(m.os,'chdir'):
  try: m.launch(root)
  except Executed: pass
  else: raise AssertionError('npm was not launched')
 with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'node':str(node)}))),patch.object(m.subprocess,'check_output',return_value='v22.0.0'),patch.object(m.os,'execve') as execute:
  try: m.launch(root)
  except RuntimeError: pass
  else: raise AssertionError('old Node accepted')
  execute.assert_not_called()
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
