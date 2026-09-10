#!/usr/bin/env python3
# 本机助手：把本地新鲜 browser-state.json 上传为 GitHub Release 资产 login-state（覆盖），
# 替代 OSS 上传。monitor 工作流每次运行也会把 mtop 刷新的新 token 回写该资产。
# 依赖：gh CLI 已登录（对当前仓库有 contents:write 权限）。
import sys, os, subprocess

LOCAL = 'browser-state.json'
TAG = 'login-state'


def repo_name():
    return subprocess.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
                          capture_output=True, text=True).stdout.strip()


def main():
    if not os.path.exists(LOCAL):
        print(f'未找到 {LOCAL}，请先在本机运行 refresh_session.py 生成')
        sys.exit(1)
    repo = repo_name()
    # 确保 release 存在
    r = subprocess.run(['gh', 'release', 'view', TAG], capture_output=True, text=True)
    if r.returncode != 0:
        print('创建 release', TAG)
        subprocess.run(['gh', 'release', 'create', TAG,
                        '--title', 'login-state (auto-managed)',
                        '--notes', '饿了么/淘宝登录态，由 upload_state_github.py / monitor 维护，勿手动删除',
                        '--latest=false'], check=True)
    subprocess.run(['gh', 'release', 'upload', TAG, '--clobber', LOCAL], check=True)
    print(f'[完成] 已上传 browser-state.json 到 release {TAG}；monitor 下次运行将自动拉取')


if __name__ == '__main__':
    main()
