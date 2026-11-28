"""Host-side overlay snapshots. All paths below the store are private to omem."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


def discard(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
    else:
        # overlayfs creates a mode-000 work/work directory.
        for folder, dirs, _ in os.walk(path, topdown=True):
            os.chmod(folder, 0o700)
            for child in dirs:
                candidate = Path(folder, child)
                if not candidate.is_symlink():
                    candidate.chmod(0o700)
        shutil.rmtree(path)


def merge(source, target):
    # Keep whiteout devices as hard links and opaque directories as opaque.
    # Never traverse a link from either a current generation or an incoming delta.
    for entry in source.iterdir():
        dest = target / entry.name
        mode = entry.lstat().st_mode
        # Sockets refer to running processes. They cannot become persistent state.
        if stat.S_ISSOCK(mode) or stat.S_ISFIFO(mode):
            continue
        directory = stat.S_ISDIR(mode)
        opaque = directory and "user.overlay.opaque" in os.listxattr(entry)
        if directory and dest.is_dir() and not dest.is_symlink() and not opaque:
            merge(entry, dest)
            shutil.copystat(entry, dest)
        else:
            discard(dest)
            if directory:
                dest.mkdir()
                merge(entry, dest)
                shutil.copystat(entry, dest)
            else:
                os.link(entry, dest, follow_symlinks=False)


def private(path):
    path.mkdir(mode=0o700, exist_ok=True)
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError("身份层目录需要由服务账号独占")


def publish(path, value):
    tmp = path.with_suffix(".new")
    tmp.write_text(value)
    os.replace(tmp, path)


def main():
    req = json.load(sys.stdin)
    root = Path(req["root"])
    if root.parent.parent == Path("/var/tmp"):
        private(root.parent)
    private(root)
    action = req["action"]
    if action == "probe":
        with tempfile.TemporaryDirectory(dir=root) as tmp:
            path = Path(tmp)
            for name in ("lower", "upper", "work"):
                (path / name).mkdir()
            (path / "lower" / "sample").write_text("host")
            result = subprocess.run([req["bwrap"], "--unshare-user", "--unshare-pid", "--ro-bind", "/", "/",
                                     "--overlay-src", path / "lower", "--overlay", path / "upper", path / "work",
                                     "/mnt", "--", "/bin/sh", "-ec", "echo layer > /mnt/sample"],
                                    capture_output=True, timeout=5)
            if result.returncode or not (path / "upper" / "sample").exists():
                raise ValueError(result.stderr.decode(errors="replace").strip() or "挂载后未写入独立上层")
        return True
    if action == "list":
        result = []
        for folder in root.iterdir():
            if (folder / "identity").is_file():
                head = folder / "head"
                size = subprocess.check_output(["/usr/bin/du", "-s", "-B1", "--", folder / head.read_text()]).split()[0] if head.exists() else 0
                result.append(dict(identity=(folder / "identity").read_text(), bytes=int(size)))
        return result
    folder = root / hashlib.sha256(req["identity"].encode()).hexdigest()
    private(folder)
    with (folder / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        (folder / "identity").write_text(req["identity"])
        head = folder / "head"
        current = head.read_text() if head.exists() else ""
        epoch = folder / "epoch"
        if not epoch.exists() or action == "clear":
            publish(epoch, uuid.uuid4().hex)
        if action == "clear":
            head.unlink(missing_ok=True)
        elif action == "begin":
            run = Path(tempfile.mkdtemp(prefix="run-", dir=folder))
            for name in ("upper", "work", "mask"):
                (run / name).mkdir()
            (run / "epoch").write_text(epoch.read_text())
            (run / "base").write_text(current)
            (run / "pid").write_text(str(os.getppid()))
            # Above the real HOME and the immutable base. An opaque directory or
            # an empty file also covers a login first created after launch.
            mask = run / "mask"
            for rel in req["parents"]:
                (mask / rel).mkdir(parents=True, exist_ok=True)
            for rel, directory in req["masks"]:
                dest = mask / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if directory:
                    dest.mkdir(exist_ok=True)
                    os.setxattr(dest, "user.overlay.opaque", b"y")
                else:
                    dest.touch()
            return dict(run=str(run), base=str(folder / current) if current else None)
        elif action == "finish":
            run = Path(req["run"])
            if run.parent != folder or not run.name.startswith("run-"):
                raise ValueError("身份层运行目录不匹配")
            applied = (run / "epoch").read_text() == epoch.read_text() and any((run / "upper").iterdir())
            concurrent = applied and (run / "base").read_text() != current
            if applied:
                new = "gen-" + uuid.uuid4().hex
                target = folder / new
                if current:
                    subprocess.run(["/bin/cp", "-al", "--", folder / current, target], check=True)
                else:
                    target.mkdir()
                merge(run / "upper", target)
                publish(head, new)
            discard(run)
        keep = {head.read_text()} if head.exists() else set()
        for run in folder.glob("run-*"):
            if (run / "pid").exists() and Path("/proc", (run / "pid").read_text()).exists():
                keep.add((run / "base").read_text())
            else:
                discard(run)
        for gen in folder.glob("gen-*"):
            if gen.name not in keep:
                discard(gen)
        return concurrent if action == "finish" else True


try:
    print(json.dumps(main()))
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
