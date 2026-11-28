"""Read-only projection of published omem data. This process never opens the database."""
import errno
import functools
import json
import os
from pathlib import PurePosixPath
import re
import select
import signal
import threading
import stat
import subprocess
import sys

import fuse

fuse.fuse_python_api = (0, 2)
host = os.pidfd_open(os.getppid())
policy = json.load(sys.stdin)
root = os.open(policy["data"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
home = policy.get("socketsHidden", False)
owner = not home and policy["spaces"] is None
spaces = set(policy.get("spaces") or [])
repos = set(policy.get("repos", []))
artifacts = set(policy.get("artifacts", []))
artifact_links = policy.get("artifactLinks", {})
files = set(policy.get("files", []))
nodes = {"/": "dir"}
links = dict(policy["links"])
for path, kind in [*policy["mounts"], *((path, "link") for path in links)]:
    nodes[path] = kind
    for parent in PurePosixPath(path).parents:
        nodes.setdefault(str(parent), "dir")


def open_at(path, flags):
    fd = os.dup(root)
    try:
        parts = PurePosixPath(path).parts[1:]
        for index, name in enumerate(parts):
            if name in ("..", "."):
                raise FileNotFoundError
            child = os.open(name, (flags if index + 1 == len(parts) else os.O_DIRECTORY) |
                            os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


@functools.lru_cache(maxsize=128)
def tracked(repo):
    fd = open_at("/" + repo, os.O_DIRECTORY)
    try:
        result = subprocess.run(["/usr/bin/git", "-c", "core.fsmonitor=false", "ls-files", "--cached", "-z"],
                                cwd="/proc/self/fd/" + str(fd), pass_fds=(fd,), stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=10,
                                env={"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0",
                                     "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                                     "GIT_ALLOW_PROTOCOL": "", "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0",
                                     "GIT_CEILING_DIRECTORIES": os.path.dirname(policy["data"] + "/" + repo)})
        names = set()
        if result.returncode == 0:
            for raw in result.stdout.split(b"\0"):
                name = os.fsdecode(raw)
                while name and name not in names:
                    names.add(name)
                    name = os.path.dirname(name)
        return names
    finally:
        os.close(fd)


def visible(path):
    if home:
        return True
    parts = PurePosixPath(path).parts[1:]
    if not parts:
        return True
    if any(x.startswith(".") or x.lower() in {
        "secrets", "credentials", "cookies", "auth.json", "credentials.json", "token.json",
        "storage_state.json", "storage-state.json", "id_rsa", "id_ed25519", "login data",
    } or x.lower().endswith((".key", ".p12", ".pem", ".pfx")) for x in parts):
        return False
    area, *rest = parts
    if area == "files":
        return not rest or len(rest) == 1 and re.fullmatch(r"[a-f0-9]{16}\.[a-z0-9]+", rest[0]) and (owner or rest[0] in files)
    if area == "library":
        return not rest or (owner or rest[0] in spaces)
    if area == "artifacts":
        return not rest or rest[0] in artifacts
    if area == "runs":
        if not owner:
            return False
        if len(rest) < 2:
            return True
        if rest[1] == "patches":
            return len(rest) == 2 or len(rest) == 3 and rest[2].endswith(".patch")
        if rest[1] not in {"work", "applied", "snap"}:
            return False
        nested = rest[1] == "snap" and len(rest) > 2 and re.fullmatch(r"v[0-9]+", rest[2])
        count = 5 if nested else 4
    elif area == "repos":
        if not rest:
            return True
        if not owner and rest[0] not in repos:
            return False
        count = 2
    elif area == "workspaces":
        if rest and not owner and rest[0] not in spaces:
            return False
        if len(rest) < 2:
            return True
        if not rest[1].isdigit():
            return False
        count = 3
    else:
        return False
    return len(parts) <= count or "/".join(parts[count:]) in tracked("/".join(parts[:count]))


def readable_file(path, info):
    if not stat.S_ISREG(info.st_mode):
        return False
    return home or info.st_nlink == 1 or artifact_links.get(path) == f"{info.st_dev}:{info.st_ino}:{info.st_ctime_ns}"


def workspace_link(path):
    parts = PurePosixPath(path).parts
    if not owner or len(parts) != 5 or parts[1] != "runs" or parts[3] != "work":
        return None
    parent = open_at(os.path.dirname(path), os.O_DIRECTORY)
    try:
        raw = os.readlink(parts[4], dir_fd=parent)
        target = os.path.normpath(os.path.join(policy["data"] + os.path.dirname(path), raw))
        relative = os.path.relpath(target, policy["data"]).split("/")
        if len(relative) == 3 and relative[:2] == ["workspaces", parts[4]] and relative[2].isdigit():
            return os.path.join(policy["data"], *relative)
    finally:
        os.close(parent)


def access(fn):
    @functools.wraps(fn)
    def guarded(self, path, *args):
        try:
            return fn(self, path, *args)
        except (OSError, subprocess.SubprocessError):
            return -errno.ENOENT
    return guarded


class View(fuse.Fuse):
    def fsinit(self):
        def stop_with_host():
            poll = select.poll()
            poll.register(host, select.POLLIN)
            poll.poll()
            os.kill(os.getpid(), signal.SIGTERM)
        threading.Thread(target=stop_with_host, daemon=True).start()

    @access
    def getattr(self, path):
        if path in nodes:
            mode = stat.S_IFDIR | 0o555 if nodes[path] == "dir" else stat.S_IFREG | 0o444
            if path in links:
                mode = stat.S_IFLNK | 0o777
            return os.stat_result((mode, 0, 0, 1, os.getuid(), os.getgid(), 0, 0, 0, 0))
        if not visible(path):
            return -errno.ENOENT
        fd = open_at(path, os.O_PATH)
        try:
            info = os.fstat(fd)
            if stat.S_ISLNK(info.st_mode) and (home or workspace_link(path)):
                return info
            if stat.S_ISDIR(info.st_mode) or readable_file(path, info):
                return info
            return -errno.ENOENT
        finally:
            os.close(fd)

    @access
    def readdir(self, path, offset):
        if path not in nodes and not visible(path):
            return -errno.ENOENT
        names = {os.path.basename(p) for p in nodes if os.path.dirname(p) == path and p != "/"}
        if visible(path):
            fd = open_at(path, os.O_DIRECTORY)
            try:
                names.update(n for n in os.listdir(fd) if visible(os.path.join(path, n)))
            finally:
                os.close(fd)
        return [fuse.Direntry(n) for n in [".", "..", *names]]

    @access
    def readlink(self, path):
        if home:
            parent = open_at(os.path.dirname(path), os.O_DIRECTORY)
            try:
                return os.readlink(os.path.basename(path), dir_fd=parent)
            finally:
                os.close(parent)
        return links.get(path) or workspace_link(path) or -errno.ENOENT

    @access
    def read(self, path, size, offset):
        if path in nodes or not visible(path):
            return -errno.ENOENT
        fd = open_at(path, os.O_PATH)
        try:
            info = os.fstat(fd)
            if not readable_file(path, info):
                return -errno.ENOENT
            reader = os.open("/proc/self/fd/" + str(fd), os.O_RDONLY)
            try:
                return os.pread(reader, size, offset)
            finally:
                os.close(reader)
        finally:
            os.close(fd)


view = View(dash_s_do="setsingle")
view.parse(errex=1)
view.main()
