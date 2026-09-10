#!/usr/bin/env python3
# 下载运行所需状态到 dest 目录：
#   1) 比价快照/推送去重（notify-state.json / prev-snap.json）—— 来自 GitHub Artifact `snap`（自动管理）
#   2) 登录态 browser-state.json —— 来自 GitHub Release 资产 `login-state`（单一真源，可由本机/monitor 覆盖）
# 顺序：先快照后登录态，确保 login-state 资产始终优先（它才是权威登录态）。
# 用法：python fetch_state.py <dest_dir>
import sys, os, json, zipfile, tempfile, subprocess

KNOWN = ['browser-state.json', 'prev-snap.json', 'notify-state.json']
RELEASE_TAG = 'login-state'
SNAP_ART = 'snap'


def gh_api(args, binary=False):
    cmd = ['gh', 'api'] + args
    if binary:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    else:
        p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        err = p.stderr
        if isinstance(err, bytes):
            err = err.decode(errors='replace')
        raise RuntimeError((err or 'gh failed').strip())
    return p.stdout


def repo_name():
    if os.environ.get('GITHUB_REPOSITORY'):
        return os.environ['GITHUB_REPOSITORY']
    return subprocess.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
                          capture_output=True, text=True).stdout.strip()


def main():
    if len(sys.argv) < 2:
        print('usage: fetch_state.py <dest_dir>')
        sys.exit(2)
    dest = sys.argv[1]
    os.makedirs(dest, exist_ok=True)
    repo = repo_name()
    # 1) 快照（artifact）
    try:
        data = gh_api([f'repos/{repo}/actions/artifacts?per_page=100'])
        arts = json.loads(data).get('artifacts', [])
        matched = sorted([a for a in arts if a.get('name') == SNAP_ART],
                         key=lambda a: a.get('created_at', ''), reverse=True)
        if matched:
            aid = matched[0]['id']
            zpath = os.path.join(tempfile.gettempdir(), f'snap_{aid}.zip')
            with open(zpath, 'wb') as f:
                f.write(gh_api([f'repos/{repo}/actions/artifacts/{aid}/zip'], binary=True))
            with zipfile.ZipFile(zpath) as z:
                z.extractall(dest)
            for root, _, files in os.walk(dest):
                for f in files:
                    if f in KNOWN and os.path.abspath(root) != os.path.abspath(dest):
                        import shutil
                        shutil.copyfile(os.path.join(root, f), os.path.join(dest, f))
            print('[fetch_state] 已下载快照(snap 产物)')
        else:
            print('[fetch_state] 无 snap 产物（首次）')
    except Exception as e:
        print('[fetch_state] 快照下载失败（忽略）:', e)
    # 2) 登录态（release 资产，后下载以优先）
    try:
        p = subprocess.run(['gh', 'release', 'download', RELEASE_TAG, '-p', 'browser-state.json', '-D', dest],
                           capture_output=True, text=True)
        if p.returncode == 0:
            print('[fetch_state] 已下载登录态(login-state 资产)')
        else:
            print('[fetch_state] 无 login-state 资产（首次/未上传），将报 NO_STATE')
    except Exception as e:
        print('[fetch_state] 登录态下载失败:', e)
    print('[fetch_state] dest 内容:', sorted(os.listdir(dest)))


if __name__ == '__main__':
    main()
