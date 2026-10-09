"""Model admission without loading weights. Automatic mode never selects 9B."""

REQUIRED_GIB = {"0.8b": 4, "2b": 8, "4b": 14, "9b": 28}


def choose_model(mode, installed, headroom, load):
    # 9B's 28 GiB is a conservative provisional budget, not a measured peak.
    # It must be explicitly selected and cannot silently replace a smaller model.
    if mode == "auto":
        sizes = ["4b", "2b", "0.8b"] if load < .85 else ["2b", "0.8b"]
        for size in sizes:
            if size in installed and headroom >= REQUIRED_GIB[size]:
                return size
        if any(size in installed for size in sizes):
            raise RuntimeError("可用内存不足，保留原检索并交给常规 Agent")
        raise RuntimeError("自动决策需要已安装的 0.8B、2B 或 4B 模型")
    if mode not in REQUIRED_GIB:
        raise RuntimeError("未知决策模型大小")
    if mode not in installed:
        raise RuntimeError("所选决策模型尚未通过 omem setup decisions 安装")
    if headroom < REQUIRED_GIB[mode]:
        raise RuntimeError("可用内存不足，保留原检索并交给常规 Agent")
    return mode


def retain_current(mode, current, choice, elapsed, headroom):
    # Delay only upgrades. Admission failures and downgrades never wait five minutes.
    return (mode == "auto" and current is not None and current != choice
            and elapsed < 300 and REQUIRED_GIB[current] < REQUIRED_GIB[choice]
            and headroom >= REQUIRED_GIB[current])
