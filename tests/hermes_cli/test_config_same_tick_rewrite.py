"""Config caches see a same-size in-place rewrite made in the timestamp tick of the cached read.

Kernels without multigrain timestamps (CI runners, older hosts) stamp mtime/ctime from a coarse
clock, so ``config.yaml`` rewritten in place to a same-length value (``port 3`` -> ``port 5``) in the
tick of an earlier read keeps mtime, ctime, size and inode: the stat signature every config cache
keys on is unchanged, and the older parse was served for the rest of the process. This host may
have fine-grained timestamps, so ``coarse_clock`` reports both writes in one frozen tick, which is
what such a kernel returns."""
import json
import os
import time

import pytest


def _write(path, port):
    path.write_text(json.dumps({'model': {'provider': 'custom', 'base_url': f'http://127.0.0.1:{port}/v1'}}))


def _readers():
    from hermes_cli.config import load_config, load_config_readonly, read_raw_config
    from hermes_cli.config_backend import read_config_doc_readonly
    from hermes_cli.config_effective import load_user_config_effective
    from hermes_cli.config import get_config_path
    path = get_config_path()
    return {
        'load_config': lambda: load_config(),
        'load_config_readonly': lambda: load_config_readonly(),
        'read_raw_config': lambda: read_raw_config(),
        'load_user_config_effective': lambda: load_user_config_effective(path),
        'read_config_doc_readonly': lambda: read_config_doc_readonly(path),
    }


@pytest.fixture
def coarse_clock(monkeypatch):
    """Every stat signature reports one frozen mtime/ctime tick, like a coarse filesystem clock."""
    import utils
    real, tick = utils.file_signature, time.time_ns()
    monkeypatch.setattr(utils, 'file_signature', lambda st: (tick, *real(st)[1:3], tick))


def test_same_size_rewrite_in_one_tick_reaches_every_config_reader(coarse_clock):
    from hermes_cli.config import get_config_path
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    readers = _readers()
    _write(path, 3)
    assert {name: read()['model']['base_url'] for name, read in readers.items()} == dict.fromkeys(
        readers, 'http://127.0.0.1:3/v1')
    _write(path, 5)
    assert {name: read()['model']['base_url'] for name, read in readers.items()} == dict.fromkeys(
        readers, 'http://127.0.0.1:5/v1')


def test_an_unchanged_file_stays_one_parse_while_fresh_and_once_settled(coarse_clock):
    from hermes_cli.config import get_config_path
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    readonly = {k: v for k, v in _readers().items() if k in ('load_config_readonly', 'read_config_doc_readonly')}
    _write(path, 3)
    for read in readonly.values():  # inside the racy window: the content digest matches, still a hit
        assert read() is read()
    settled = time.time_ns() - 10_000_000_000
    os.utime(path, ns=(settled, settled))
    for read in readonly.values():
        assert read() is read()
