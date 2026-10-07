"""Model admission without loading weights. Automatic mode never selects 9B."""

REQUIRED_GIB = {"2b": 8, "4b": 14, "9b": 28}


def choose_model(mode, installed, headroom, load):
    # 9B's 28 GiB is a conservative provisional budget, not a measured peak.
    # It must be explicitly selected and cannot silently replace a smaller model.
    choice = ("4b" if headroom >= 14 and load < .85 else "2b") if mode == "auto" else mode
    if choice not in REQUIRED_GIB:
        raise RuntimeError("未知决策模型大小")
    if headroom < REQUIRED_GIB[choice]:
        if mode == "auto" and headroom >= 8:
            choice = "2b"
        else:
            raise RuntimeError("可用内存不足，保留原检索并交给常规 Agent")
    if choice not in installed:
        if mode == "auto" and "2b" in installed:
            choice = "2b"
        else:
            raise RuntimeError("所选决策模型尚未通过 omem setup decisions 安装")
    return choice
