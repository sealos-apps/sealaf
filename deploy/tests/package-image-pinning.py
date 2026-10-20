#!/usr/bin/env python3
"""Verify package image tags against real Git histories and rendered Helm output."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


class PackageImagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        shutil.copytree(ROOT / 'deploy/charts', self.repo / 'deploy/charts')
        for component in ('web', 'server'):
            (self.repo / component).mkdir()
            (self.repo / component / 'index.ts').write_text('initial')
        git(self.repo, 'init', '-b', 'main')
        git(self.repo, 'config', 'core.hooksPath', os.devnull)
        git(self.repo, 'config', 'user.name', 'Fixture')
        git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        self.initial = self.commit('initial')
        bindir = Path(self.tmp.name) / 'bin'
        bindir.mkdir()
        sudo = bindir / 'sudo'
        sudo.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
if sys.argv[1:4] == ['sealos', 'registry', 'save']:
    lines = pathlib.Path('charts/sealaf/values.yaml').read_text().splitlines()
    tags = [line.strip().split(':', 1)[1].strip().strip('"') for line in lines if line.startswith('    tag:')]
    assert tags == json.loads(os.environ['EXPECTED_TAGS']), tags
''')
        sudo.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{bindir}:{os.environ["PATH"]}')

    def commit(self, message):
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', message)
        return git(self.repo, 'rev-parse', 'HEAD')

    def change(self, path):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(path)
        return self.commit(path)

    def cache(self, source, expected, tag='latest'):
        text = (ROOT / '.github/workflows/build-sealos-cluster-image.yml').read_text()
        block = text.split('      - name: Cache images for sealos\n', 1)[1]
        block = block.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
        command = '\n'.join(line[10:] for line in block.splitlines() if line.strip())
        replacements = {'github.actor': 'fixture', 'secrets.GITHUB_TOKEN': 'fixture',
                        'github.repository': 'sealos-apps/sealaf', 'matrix.arch': 'amd64',
                        'needs.prepare.outputs.image_tag': tag,
                        'needs.prepare.outputs.source_sha': source}
        command = re.sub(r'\$\{\{\s*(.*?)\s*\}\}', lambda m: replacements[m[1]], command)
        env = dict(self.env, EXPECTED_TAGS=json.dumps(expected))
        result = subprocess.run(['bash', '-c', command], cwd=self.repo / 'deploy', env=env,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        rendered = subprocess.check_output(['helm', 'template', 'sealaf', str(self.repo / 'deploy/charts/sealaf')], text=True)
        images = '\n'.join(line for line in rendered.splitlines() if 'image:' in line)
        for component, expected_tag in zip(('web', 'server'), expected):
            self.assertIn(f'image: "ghcr.io/sealos-apps/sealaf/sealaf-{component}:{expected_tag}"', images)

    def test_component_changes_and_ignored_files(self):
        web = self.change('web/feature.ts')
        server = self.change('server/feature.ts')
        self.change('web/docs/nested/readme.md')
        self.change('server/package-lock.json')
        source = self.change('deploy/package.txt')
        self.cache(source, [f'sha-{web[:7]}', f'sha-{server[:7]}'])
        # Later commits must not affect a package built from an older source SHA.
        self.change('web/future.ts')
        self.cache(source, [f'sha-{web[:7]}', f'sha-{server[:7]}'])

    def test_merge_uses_published_merge_commit_tag(self):
        git(self.repo, 'checkout', '-qb', 'feature')
        self.change('web/feature.ts')
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '--no-ff', '-qm', 'merge feature', 'feature')
        merge = git(self.repo, 'rev-parse', 'HEAD')
        self.cache(merge, [f'sha-{merge[:7]}', f'sha-{self.initial[:7]}'])

    def test_workflow_change_rebuilds_component(self):
        source = self.change('.github/workflows/dockerize-web.yml')
        self.cache(source, [f'sha-{source[:7]}', f'sha-{self.initial[:7]}'])

    def test_explicit_sha_and_release_tags_remain_supported(self):
        for tag in ('sha-1234567', '1.2.3'):
            with self.subTest(tag=tag):
                self.cache(self.initial, [tag, tag], tag)


if __name__ == '__main__':
    unittest.main()
