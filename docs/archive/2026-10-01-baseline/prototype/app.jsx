/*
 * Offline interaction study. Domain fixtures are fictional; ChatPanel deliberately uses
 * a transparent response simulator. Fixed node IDs model immutable evidence revisions.
 * Native dialog gives the recursive reader a single focus trap, regardless of depth.
 */
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./tweaks-panel.jsx";
import {
  nodes,
  articles,
  initialChanges,
  sources as seedSources,
} from "./data.js";
const { useTweaks, TweaksPanel, TweakSlider, TweakSelect } = window;
const I = ({ name, size = 18 }) => {
  const paths = {
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    book: (
      <>
        <path d="M12 5v16M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2z" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <path d="m14 6-6 6 6 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    chat: <path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0Z" />,
    link: (
      <>
        <path d="m10 13 4-4m-5-1 3-3a5 5 0 0 1 7 7l-3 3m-1 1-3 3a5 5 0 0 1-7-7l3-3" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    source: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
      </>
    ),
    send: (
      <>
        <path d="M12 20V4m-7 7 7-7 7 7" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a9 9 0 1 0 0 9M20 3v6h-6" />
      </>
    ),
    dots: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" fill="currentColor" />
        <circle cx="15" cy="17" r="3" fill="currentColor" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    spark: (
      <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
      </>
    ),
    flag: (
      <>
        <path d="M5 22V3c6-5 9 5 15 0v11c-6 5-9-5-15 0" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.book}
    </svg>
  );
};
const Btn = ({ children, icon, onClick, primary = false, ...rest }) => (
  <button
    className={"btn " + (primary ? "primary" : "")}
    onClick={onClick}
    {...rest}
  >
    {icon && <I name={icon} size={15} />} {children}
  </button>
);
const Chip = ({ children }) => <span className="chip">{children}</span>;
function loadChanges() {
  try {
    const x = JSON.parse(localStorage.getItem("omem-demo-v1"));
    return Array.isArray(x) &&
      x.every((v) => v.id && v.title && Array.isArray(v.refs))
      ? x
      : initialChanges;
  } catch {
    return initialChanges;
  }
}
function ChatPanel({
  focus = "policy",
  selection = "",
  inline = false,
  onCite,
  threads,
  setThreads,
  onSave,
  pathRefs = [],
}) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const timer = useRef(null);
  const body = useRef(null);
  const focusNode = nodes[focus] || nodes.policy;
  const threadKey = focus + (inline ? ":local" : ":global");
  const scope = threads["scope:" + threadKey] || "本段与直接依据";
  const setScope = (s) =>
    setThreads((t) => ({ ...t, ["scope:" + threadKey]: s }));
  const messages = threads[threadKey] || [];
  const question = threads["draft:" + threadKey] || "";
  const setQuestion = (q) =>
    setThreads((t) => ({ ...t, ["draft:" + threadKey]: q }));
  useEffect(() => {
    setBusy(false);
    setHint("");
    return () => clearTimeout(timer.current);
  }, [threadKey]);
  useEffect(() => {
    body.current?.scrollTo(0, body.current.scrollHeight);
  }, [messages, busy]);
  const submit = (preset) => {
    const q = (preset || question).trim();
    if (!q) {
      setHint("先写下你想了解的问题。");
      return;
    }
    if (busy) return;
    setHint("");
    setQuestion("");
    setBusy(true);
    const user = { id: Date.now() + "u", role: "user", text: q };
    setThreads((t) => ({ ...t, [threadKey]: [...(t[threadKey] || []), user] }));
    timer.current = setTimeout(() => {
      const extra =
        scope === "当前引用路径"
          ? pathRefs
          : scope === "授权知识库"
            ? ["policy", "incident", "trace"]
            : focusNode.refs.slice(0, 1).map((r) => r.id);
      const responseRefs = [...new Set([focus, ...extra])]
        .filter((id) => ["available", "superseded"].includes(nodes[id]?.status))
        .slice(0, 5);
      const available = ["available", "superseded"].includes(focusNode.status);
      const text = available
        ? `就「${focusNode.title}」而言，原文说明：${(selection || focusNode.quote).replace(/\n/g, "；")} ${/为什么|依据|原因/.test(q) ? "这解释了当前结论的来路，但不能由一次记录推断所有场景都适用。" : "应用时还需要核对适用范围、材料版本和当前条件。"}${focusNode.status === "superseded" ? " 当前查看的是历史版本，请对照现行条款。" : ""}`
        : "当前材料不可作为可核对的证据。我不能根据缺失的正文给出确定结论。请切换到可访问的来源。";
      setThreads((t) => ({
        ...t,
        [threadKey]: [
          ...(t[threadKey] || []),
          {
            id: Date.now() + "a",
            role: "assistant",
            text,
            refs: available ? responseRefs : [],
            scope,
            focus,
          },
        ],
      }));
      setBusy(false);
    }, 650);
  };
  return (
    <section
      className={"chat-panel " + (inline ? "inline-chat" : "")}
      aria-label={inline ? "当前片段问答" : "知识问答"}
    >
      <header className="chat-head">
        <span className="ai-mark">
          <I name="spark" />
        </span>
        <div>
          <strong>{inline ? "就这段原文追问" : "和记忆一起思考"}</strong>
          <small>演示回答 · 未连接模型</small>
        </div>
      </header>
      <div className="chat-scroll" ref={body}>
        <div className="focus-card">
          <span className="eyebrow">本次依据</span>
          <b>{focusNode.title}</b>
          <p>{selection || focusNode.quote || focusNode.body}</p>
          <span className="muted">
            {focusNode.version} · {selection ? "选中片段" : "固定原文"}
          </span>
        </div>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <p>把结论问清楚，也把依据看明白。</p>
            <small>回答中的引用仍然可以继续打开。</small>
            <div className="suggestions">
              {["为什么有这条要求？", "有哪些适用边界？"].map((q) => (
                <button key={q} onClick={() => submit(q)}>
                  {q}
                  <I name="arrow" size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={"message " + m.role}>
            {m.role === "assistant" && (
              <div className="message-label">
                <I name="spark" size={13} /> omem · 演示
              </div>
            )}
            <p>{m.text}</p>
            {m.refs?.length > 0 && (
              <>
                <div className="answer-refs">
                  {m.refs.map((id, i) => (
                    <button key={id} onClick={() => onCite(id)}>
                      <span>{i + 1}</span>
                      {nodes[id].title}
                      <I name="external" size={12} />
                    </button>
                  ))}
                </div>
                <div className="answer-actions">
                  <button onClick={() => onSave(m)}>沉淀为候选</button>
                  <span>{m.scope}</span>
                </div>
              </>
            )}
          </div>
        ))}
        {busy && (
          <div className="thinking" role="status">
            正在组织演示回答<span>···</span>
          </div>
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="scope-label">
          回答范围
          <select
            aria-label="回答范围"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option>本段与直接依据</option>
            <option>当前引用路径</option>
            <option>授权知识库</option>
          </select>
        </label>
        <div className="compose-box">
          <textarea
            aria-label={inline ? "追问当前片段" : "输入问题"}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="从这段内容继续问…"
            rows={2}
          />
          {busy ? (
            <button
              type="button"
              aria-label="停止回答"
              className="send"
              onClick={() => {
                clearTimeout(timer.current);
                setBusy(false);
                setHint("已停止生成演示回答。");
              }}
            >
              ■
            </button>
          ) : (
            <button className="send" aria-label="发送问题">
              <I name="send" size={17} />
            </button>
          )}
        </div>
        <small role="status">
          {hint || "离线原型，仅使用示例片段模拟回答。"}
        </small>
      </form>
    </section>
  );
}
function App() {
  const [view, setView] = useState("read");
  const [article, setArticle] = useState("release");
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [frames, setFrames] = useState([]);
  const [loop, setLoop] = useState(null);
  const [selection, setSelection] = useState(null);
  const [focus, setFocus] = useState("policy");
  const [threads, setThreads] = useState({});
  const [changes, setChanges] = useState(loadChanges);
  const [sourceList, setSources] = useState(seedSources);
  const [toast, setToast] = useState("");
  const [changeDetail, setChangeDetail] = useState(null);
  const [engineOn, setEngineOn] = useState(true);
  const [decision, setDecision] = useState("pending");
  const [tweak, setTweak] = useTweaks(window.OMEM_TWEAKS);
  const dialog = useRef(null);
  const modalBody = useRef(null);
  const returnFocus = useRef(null);
  const timer = useRef(null);
  const reader = useRef(null);
  const current = frames.at(-1);
  const node = current ? nodes[current.id] : null;
  const currentArticle = articles.find((a) => a.id === article) || articles[0];
  const say = (text) => {
    clearTimeout(timer.current);
    setToast(text);
    timer.current = setTimeout(() => setToast(""), 3200);
  };
  useEffect(() => {
    try {
      localStorage.setItem("omem-demo-v1", JSON.stringify(changes));
    } catch {}
  }, [changes]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && !dialog.current?.open) {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const d = dialog.current;
    if (frames.length) {
      if (!d.open) d.showModal();
    } else if (d.open) {
      d.close();
      returnFocus.current?.isConnected && returnFocus.current.focus();
    }
  }, [frames.length]);
  useEffect(() => {
    if (current) {
      modalBody.current.scrollTop = current.scroll || 0;
      dialog.current?.querySelector(".trace-current-title")?.focus();
    }
  }, [current?.id, frames.length]);
  useEffect(() => {
    const id = location.hash.slice(1);
    if (nodes[id]) setFrames([{ id, tab: "excerpt", ask: false, scroll: 0 }]);
  }, []);
  const updateFrame = (patch) =>
    setFrames((f) =>
      f.map((x, i) => (i === f.length - 1 ? { ...x, ...patch } : x)),
    );
  const openNode = (id) => {
    if (!nodes[id]) return;
    setSelection(null);
    setLoop(null);
    const existing = frames.findIndex((f) => f.id === id);
    if (existing >= 0) {
      setLoop(existing);
      return;
    }
    if (!frames.length) {
      returnFocus.current = document.activeElement;
      setFrames([{ id, tab: "excerpt", ask: false, scroll: 0 }]);
    } else
      setFrames((f) => [
        ...f.slice(0, -1),
        { ...f.at(-1), scroll: modalBody.current?.scrollTop || 0 },
        { id, tab: "excerpt", ask: false, scroll: 0 },
      ]);
  };
  const back = () => {
    setLoop(null);
    setSelection(null);
    setFrames((f) => f.slice(0, -1));
  };
  const close = () => {
    setFrames([]);
    setLoop(null);
    setSelection(null);
  };
  const jump = (i) => {
    setFrames((f) => f.slice(0, i + 1));
    setLoop(null);
  };
  const navigate = (v) => {
    setView(v);
    setQuery("");
    setNavOpen(false);
    setSelection(null);
  };
  const openArticle = (id) => {
    setArticle(id);
    navigate("read");
    setFocus(articles.find((a) => a.id === id).refs[0]);
    if (reader.current) reader.current.scrollTop = 0;
  };
  const cite = (id, label, index) => (
    <button
      className="cite"
      onClick={() => openNode(id)}
      title={"查看引用：" + nodes[id].title}
    >
      {label || nodes[id].title}
      <sup>{index || "↗"}</sup>
    </button>
  );
  const saveAnswer = (m) => {
    const id = "candidate-" + m.id;
    if (changes.some((c) => c.id === id)) {
      say("这条回答已经进入候选。");
      return;
    }
    setChanges((c) => [
      {
        id,
        title: "从追问中提炼的知识候选",
        type: "问答候选",
        time: "刚刚",
        why: "需要回到原始片段核对；演示回答不会直接成为正式事实。",
        before: "尚未沉淀。",
        after: m.text,
        refs: m.refs,
        state: "candidate",
      },
      ...c,
    ]);
    say("已加入候选；正式系统会核对原始证据后再应用。");
  };
  const copyLink = async () => {
    const url = location.href.split("#")[0] + "#" + current.id;
    try {
      await navigator.clipboard.writeText(url);
      say("已复制固定片段链接。");
    } catch {
      say("浏览器限制剪贴板；地址栏已定位到当前片段。");
      history.replaceState(null, "", "#" + current.id);
    }
  };
  const selectText = (e) => {
    if (e.target.closest("button,textarea,select,input")) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      const host = sel.anchorNode?.parentElement?.closest("[data-selectable]");
      const endHost =
        sel.focusNode?.parentElement?.closest("[data-selectable]");
      const text = sel.toString().trim();
      if (host && host === endHost && text.length > 1) {
        const box = r.getBoundingClientRect();
        setSelection({
          text,
          focus: host.dataset.focus || focus,
          inModal: !!host.closest("dialog"),
          x: Math.max(12, Math.min(box.left, innerWidth - 165)),
          y: Math.max(8, Math.min(box.bottom + 8, innerHeight - 60)),
        });
      }
    }, 0);
  };
  const askSelection = () => {
    if (selection.inModal)
      updateFrame({ ask: true, selection: selection.text });
    else {
      setFocus(selection.focus);
      setRightOpen(true);
    }
    setSelection((s) => ({ ...s, active: true }));
    window.getSelection()?.removeAllRanges();
  };
  const restore = (c) => {
    if (c.state !== "applied") {
      say("该项不是可恢复的已生效变更。");
      return;
    }
    const next = {
      id: "restore-" + Date.now(),
      title: "恢复：" + c.title,
      type: "恢复记录",
      time: "刚刚",
      why: "恢复为新修订，并保留原变更历史。",
      before: c.after,
      after: c.before,
      refs: c.refs,
      state: "applied",
    };
    setChanges((list) => [
      next,
      ...list.map((x) => (x.id === c.id ? { ...x, state: "restored" } : x)),
    ]);
    setChangeDetail(next.id);
    say("已在演示历史中生成恢复记录。");
  };
  const sync = (id) => {
    setSources((s) =>
      s.map((x) => (x.id === id ? { ...x, state: "同步中" } : x)),
    );
    setTimeout(() => {
      setSources((s) =>
        s.map((x) =>
          x.id === id ? { ...x, state: "已同步", last: "刚刚（模拟）" } : x,
        ),
      );
      say("模拟同步完成，示例材料没有新版本。");
    }, 900);
  };
  const panelView = query ? "search" : view;
  const activeChange = changes.find((c) => c.id === changeDetail);
  const backlinks = node
    ? Object.entries(nodes).filter(
        ([id, n]) =>
          !id.startsWith("long-") && n.refs.some((r) => r.id === current.id),
      )
    : [];
  return (
    <div
      className={"app density-" + tweak.density}
      style={{ "--reading-size": tweak.fontSize + "px" }}
      onMouseUp={selectText}
    >
      <header className="topbar">
        <button
          className="mobile-menu icon-btn"
          aria-label="打开导航"
          onClick={() => setNavOpen(!navOpen)}
        >
          <I name="menu" />
        </button>
        <button
          className="brand"
          onClick={() => navigate("read")}
          aria-label="omem 首页"
        >
          <span className="logo">
            <I name="layers" size={22} />
          </span>
          <span>
            <b>
              omem<span className="brand-dot">.</span>
            </b>
            <small>有来处的记忆</small>
          </span>
        </button>
        <div className="global-search">
          <I name="search" size={17} />
          <input
            id="global-search"
            aria-label="搜索知识、材料和经历"
            placeholder="搜索知识、材料与经历…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setView("read");
            }}
          />
          <kbd>⌘ K</kbd>
          {query && (
            <button aria-label="清空搜索" onClick={() => setQuery("")}>
              <I name="close" size={14} />
            </button>
          )}
        </div>
        <div className="top-end">
          <span className="demo-label">交互原型 · 示例数据</span>
          <button
            className="icon-btn"
            title="阅读风格"
            aria-label="阅读风格"
            onClick={() =>
              window.postMessage({ type: "miaoda:tweaks:activate" }, "*")
            }
          >
            <I name="settings" />
          </button>
          <button
            className="avatar"
            aria-label="查看工作区"
            onClick={() =>
              say("当前为本地演示工作区，所有材料和问答均为示例。")
            }
          >
            L
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className={"sidebar " + (navOpen ? "mobile-open" : "")}>
          <div className="workspace-name">
            <span className="workspace-symbol">O</span>
            <div>
              <b>我的工作记忆</b>
              <small>个人空间 / omem</small>
            </div>
          </div>
          <nav className="main-nav" aria-label="主导航">
            {[
              ["read", "book", "知识阅读"],
              ["memory", "spark", "经验与方法"],
              ["sources", "source", "材料来源"],
              ["activity", "clock", "变更与学习"],
              ["engines", "settings", "能力与连接"],
            ].map(([id, icon, label]) => (
              <button
                className={view === id ? "active" : ""}
                key={id}
                onClick={() => navigate(id)}
              >
                <I name={icon} size={17} />
                {label}
                {id === "activity" && (
                  <span className="nav-count">{changes.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="side-divider" />
          <div className="side-heading">
            知识目录 <span>{articles.length}</span>
          </div>
          <div className="doc-tree">
            {articles.map((a) => (
              <div key={a.id}>
                <div className="folder">
                  <I name="arrow" size={11} />
                  {a.group}
                </div>
                <button
                  onClick={() => openArticle(a.id)}
                  className={
                    "tree-item " +
                    (article === a.id && view === "read" ? "selected" : "")
                  }
                >
                  <I name="book" size={14} />
                  <span>{a.title}</span>
                </button>
              </div>
            ))}
          </div>
          <div className="side-bottom">
            <details className="demo-tools">
              <summary>
                体验引用边界 <I name="arrow" size={12} />
              </summary>
              <div>
                {[
                  ["policy", "8 层证据链"],
                  ["long-1", "100 层长链"],
                  ["restricted", "来源无权限"],
                  ["deleted", "来源已删除"],
                  ["unresolved", "定位待核对"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => {
                      setNavOpen(false);
                      openNode(id);
                    }}
                  >
                    {label}
                    <I name="external" size={12} />
                  </button>
                ))}
              </div>
            </details>
            <div className="learning-status">
              <span className="status-dot" />
              <div>
                记忆持续整理中<small>自动整理，例外再找你 · 演示</small>
              </div>
            </div>
          </div>
        </aside>
        <main className="main-area">
          <div className="breadcrumb">
            <span>我的工作记忆</span>
            <I name="arrow" size={12} />
            <b>
              {panelView === "read"
                ? currentArticle.group
                : {
                    search: "搜索结果",
                    memory: "经验与方法",
                    sources: "材料来源",
                    activity: "变更与学习",
                    engines: "能力与连接",
                  }[panelView]}
            </b>
            <div className="crumb-end">
              <button
                className="mobile-ai"
                onClick={() => setRightOpen(!rightOpen)}
              >
                <I name="chat" size={17} />
                追问
              </button>
              <span>私有工作区</span>
            </div>
          </div>
          <div className="content-grid">
            <div className="reader-scroll" ref={reader}>
              {panelView === "read" && (
                <article className="article" data-screen-label="知识阅读">
                  <div className="article-kicker">
                    <span className="tiny-line" />
                    {currentArticle.kind}
                    <span className="status-tag">
                      <I name="check" size={12} />
                      有证据支持
                    </span>
                  </div>
                  <h1>{currentArticle.title}</h1>
                  <p className="article-deck">{currentArticle.summary}</p>
                  <div className="byline">
                    <span className="small-avatar">o</span>
                    <span>omem 整理</span>
                    <span>·</span>
                    <span>更新于 09 月 24 日</span>
                    <Chip>固定版本</Chip>
                  </div>
                  <div className="reading-note">
                    <I name="link" size={17} />
                    <span>
                      每一条引用，都可以继续往下看。
                      <small>点击文中深色引用，或选中一段文字直接追问。</small>
                    </span>
                  </div>
                  <div
                    className="prose"
                    data-selectable="true"
                    data-focus={currentArticle.refs[0]}
                  >
                    {article === "release" ? (
                      <>
                        <p>
                          “有回滚脚本”并不意味着“能够顺利回滚”。一次看似完成的镜像回退，可能因为配置没有同步恢复，让问题继续存在。
                        </p>
                        <h2>
                          <span>01</span>先确认回得去，再决定发出去
                        </h2>
                        <p>
                          当前规范把回滚验证放在发布之前：
                          {cite(
                            "policy",
                            "回滚方案、负责人和验证结果必须到位",
                            1,
                          )}
                          。这里的重点是<strong>验证结果</strong>
                          ，而不仅是准备了一份脚本。
                        </p>
                        <blockquote>
                          从“准备好”到“验证过”，差的是一次可核对的执行记录。
                        </blockquote>
                        <h2>
                          <span>02</span>一条经验，保留完整来路
                        </h2>
                        <p>
                          这条方法来自
                          {cite("incident", "一次配置未同步恢复的发布复盘", 2)}
                          。沿着引用继续查看，可以依次找到操作手册、任务轨迹、代码修订、测试和原始观测。
                        </p>
                        <div className="inline-route">
                          <span>知识结论</span>
                          <I name="arrow" size={13} />
                          <button onClick={() => openNode("policy")}>
                            发布规范
                          </button>
                          <I name="arrow" size={13} />
                          <span>任务经历</span>
                          <I name="arrow" size={13} />
                          <span>原始记录</span>
                        </div>
                        <h2>
                          <span>03</span>明确这条方法的边界
                        </h2>
                        <p>
                          它适用于本例中的应用发布。数据库不可逆迁移、外部系统副作用，需要独立的恢复设计，不能仅凭这条经验判断安全。
                        </p>
                        <p>
                          历史条款{cite("old", "r6", 3)}
                          只要求准备脚本。旧引用保留当时的正文，并明确提示已有新版本。
                        </p>
                      </>
                    ) : article === "memory" ? (
                      <>
                        <p>
                          Agent
                          的长期记忆应该保留它做过什么、哪里出错、怎样纠正，以及怎样确认真正解决了问题。
                        </p>
                        <h2>
                          <span>01</span>一次任务不是一条永久规则
                        </h2>
                        <p>
                          {cite("incident", "发布复盘", 1)}
                          记录了配置遗漏。单次经历可以形成方法候选，但不能自动泛化到所有发布场景。
                        </p>
                        <h2>
                          <span>02</span>把成功与命中分开
                        </h2>
                        <p>
                          被检索到很多次，不会让一条说法变得更真实。
                          {cite("trace", "验证轨迹", 2)}
                          和反例测试，才支持“这个方法在这些条件下有效”。
                        </p>
                        <h2>
                          <span>03</span>下次遇到时，能想起来
                        </h2>
                        <p>
                          提炼后的{cite("runbook", "回滚操作手册", 3)}
                          以适用条件、步骤和验证结果组织。每次使用后的纠正继续进入学习闭环。
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          每一个引用都固定到材料的某个版本。更新不会改变过去回答的依据。
                        </p>
                        <h2>
                          <span>01</span>旧版本可看，新版本可比
                        </h2>
                        <p>
                          打开{cite("old", "历史规范 r6", 1)}
                          ，可以查看更新提示、固定原文与版本差异，再跳到
                          {cite("policy", "现行规范 r7", 2)}。
                        </p>
                        <h2>
                          <span>02</span>缺失证据，明确说出来
                        </h2>
                        <p>
                          当{cite("unresolved", "原文定位不唯一", 3)}
                          ，系统不会编造高亮位置。无权访问与已删除来源也有独立状态。
                        </p>
                      </>
                    )}
                  </div>
                  <section className="article-refs">
                    <div className="section-label">
                      <I name="link" size={16} />
                      <h3>这篇知识的依据</h3>
                      <span>{currentArticle.refs.length} 份材料</span>
                    </div>
                    {currentArticle.refs.map((id, i) => (
                      <button
                        key={id}
                        className="reference-row"
                        onClick={() => openNode(id)}
                      >
                        <span className="reference-num">{i + 1}</span>
                        <span>
                          <b>{nodes[id].title}</b>
                          <small>
                            {nodes[id].kind} · {nodes[id].section} ·{" "}
                            {nodes[id].version}
                          </small>
                        </span>
                        <I name="arrow" size={16} />
                      </button>
                    ))}
                  </section>
                  <div className="article-foot">
                    <span>本文及引用内容均为原型示例</span>
                    <button
                      onClick={() => {
                        navigate("activity");
                        setChangeDetail("change-3");
                      }}
                    >
                      <I name="clock" size={13} />
                      查看变更来路
                    </button>
                  </div>
                </article>
              )}
              {panelView === "search" && (
                <div className="management" data-screen-label="搜索">
                  <span className="eyebrow">知识与材料</span>
                  <h1>搜索“{query}”</h1>
                  <p className="muted">在本地示例的标题、摘要和片段中检索。</p>
                  {articles
                    .filter((a) => (a.title + a.summary).includes(query))
                    .map((a) => (
                      <button
                        key={a.id}
                        className="result-row"
                        onClick={() => openArticle(a.id)}
                      >
                        <Chip>知识</Chip>
                        <b>{a.title}</b>
                        <p>{a.summary}</p>
                      </button>
                    ))}
                  {Object.entries(nodes)
                    .filter(
                      ([id, n]) =>
                        !id.startsWith("long-") &&
                        (n.title + n.quote).includes(query),
                    )
                    .map(([id, n]) => (
                      <button
                        key={id}
                        className="result-row"
                        onClick={() => openNode(id)}
                      >
                        <Chip>{n.kind}</Chip>
                        <b>{n.title}</b>
                        <p>{n.quote || n.body}</p>
                      </button>
                    ))}
                  {![
                    ...articles.map((a) => a.title + a.summary),
                    ...Object.entries(nodes)
                      .filter(([id]) => !id.startsWith("long-"))
                      .map(([, n]) => n.title + n.quote),
                  ].some((t) => t.includes(query)) && (
                    <div className="empty">
                      <I name="search" size={30} />
                      <h3>没有找到相关示例</h3>
                      <p>试试“回滚”“配置”或“验证”。</p>
                      <Btn onClick={() => setQuery("回滚")}>搜索回滚</Btn>
                    </div>
                  )}
                </div>
              )}
              {panelView === "memory" && (
                <div className="management" data-screen-label="经验与方法">
                  <span className="eyebrow">从经历到可复用的方法</span>
                  <h1>一次问题，留下下一次的经验</h1>
                  <p className="lead">保存过程，更关心它是否真的解决了问题。</p>
                  <div className="learning-flow">
                    {[
                      ["incident", "任务经历"],
                      ["trace", "结果验证"],
                      ["runbook", "复用方法"],
                    ].map(([id, label], i) => (
                      <React.Fragment key={id}>
                        {i > 0 && <I name="arrow" />}
                        <button onClick={() => openNode(id)}>
                          <span>{label}</span>
                          <b>{nodes[id].title}</b>
                          <small>
                            {i === 0
                              ? "配置未随镜像回退"
                              : i === 1
                                ? "工具结果与健康指标一致"
                                : "应用于下一次相同场景"}
                          </small>
                        </button>
                      </React.Fragment>
                    ))}
                  </div>
                  <h2>已沉淀的方法</h2>
                  <div className="method-card">
                    <div>
                      <Chip>有支持证据</Chip>
                      <h3>回滚时，同时恢复镜像与配置</h3>
                      <p>适用条件：应用发布，存在独立配置版本。</p>
                      <p>验证方式：检查版本一致性，再看健康指标。</p>
                    </div>
                    <Btn icon="arrow" onClick={() => openNode("runbook")}>
                      查看方法与依据
                    </Btn>
                  </div>
                  <h2>需要你的判断</h2>
                  <div className="decision-card">
                    <Chip>{decision === "pending" ? "待判断" : "已记录"}</Chip>
                    <h3>能否推广到数据库迁移？</h3>
                    <p>
                      当前证据仅覆盖应用发布。系统保留了原有方法，没有自动扩大适用范围。
                    </p>
                    {decision === "pending" ? (
                      <div className="button-row">
                        <Btn
                          onClick={() => {
                            setDecision("kept");
                            say("已记录：保留为应用发布方法，不扩大范围。");
                          }}
                        >
                          保持现有范围
                        </Btn>
                        <Btn
                          onClick={() => {
                            setDecision("research");
                            say("已记录补证建议（原型不会启动真实采集）。");
                          }}
                        >
                          先补充迁移案例
                        </Btn>
                      </div>
                    ) : (
                      <p className="decision-result">
                        <I name="check" size={15} />
                        {decision === "kept"
                          ? "保持现有范围"
                          : "已加入补证计划（演示）"}
                      </p>
                    )}
                  </div>
                </div>
              )}
              {panelView === "sources" && (
                <div className="management" data-screen-label="材料来源">
                  <span className="eyebrow">自动更新的起点</span>
                  <h1>材料来源</h1>
                  <p className="lead">让记忆跟上原文，也保留它曾经的样子。</p>
                  {sourceList.map((s) => (
                    <div className="source-row" key={s.id}>
                      <div className="source-icon">
                        <I
                          name={s.id === "agent" ? "spark" : "source"}
                          size={22}
                        />
                      </div>
                      <div>
                        <h3>{s.name}</h3>
                        <p>
                          {s.kind} · {s.scope}
                        </p>
                        <small>
                          {s.state} · {s.last}
                        </small>
                      </div>
                      <Btn
                        icon="refresh"
                        disabled={s.state === "同步中"}
                        onClick={() => sync(s.id)}
                      >
                        {s.state === "同步中" ? "同步中…" : "模拟同步"}
                      </Btn>
                    </div>
                  ))}
                  <div className="explanation">
                    <h3>同步不是覆盖历史</h3>
                    <p>
                      源内容变化后创建新版本。已发布的知识会标记待刷新，旧引用仍可查看固定快照。
                    </p>
                    <Btn onClick={() => openNode("old")} icon="layers">
                      体验版本变化
                    </Btn>
                  </div>
                </div>
              )}
              {panelView === "activity" && (
                <div className="management" data-screen-label="变更与学习">
                  <span className="eyebrow">每次变化都有来路</span>
                  <h1>变更与学习</h1>
                  <p className="lead">
                    常规整理自动进行。你可以查看依据、比较内容，也可以恢复。
                  </p>
                  <div className="activity-summary">
                    <span>
                      <I name="check" size={16} />
                      {changes.filter((c) => c.state === "applied").length}{" "}
                      项当前生效
                    </span>
                    <span>
                      <I name="clock" size={16} />
                      完整演示历史
                    </span>
                  </div>
                  {changes.map((c) => (
                    <div
                      className={
                        "change-card " +
                        (changeDetail === c.id ? "expanded" : "")
                      }
                      key={c.id}
                    >
                      <button
                        className="change-heading"
                        onClick={() =>
                          setChangeDetail(changeDetail === c.id ? null : c.id)
                        }
                      >
                        <span className="timeline-dot">
                          <I
                            name={c.type === "自动学习" ? "spark" : "refresh"}
                            size={16}
                          />
                        </span>
                        <span>
                          <b>{c.title}</b>
                          <small>
                            {c.time} · {c.type}
                          </small>
                        </span>
                        <Chip>
                          {c.state === "restored"
                            ? "已恢复"
                            : c.state === "candidate"
                              ? "待核对"
                              : "已生效"}
                        </Chip>
                        <I name="arrow" size={16} />
                      </button>
                      {changeDetail === c.id && (
                        <div className="change-body">
                          <p>{c.why}</p>
                          <div className="diff">
                            <div>
                              <span>变更前</span>
                              <p>{c.before}</p>
                            </div>
                            <div>
                              <span>变更后</span>
                              <p>{c.after}</p>
                            </div>
                          </div>
                          <div className="button-row">
                            {c.refs.slice(0, 2).map((id) => (
                              <button
                                key={id}
                                className="text-link"
                                onClick={() => openNode(id)}
                              >
                                <I name="link" size={13} />
                                {nodes[id]?.title || "材料"}
                              </button>
                            ))}
                          </div>
                          {c.state === "applied" && (
                            <Btn icon="back" onClick={() => restore(c)}>
                              恢复为变更前内容
                            </Btn>
                          )}
                          {c.state === "restored" && (
                            <small>
                              原变更仍保留，恢复已作为一条新记录追加。
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  <p className="management-foot">
                    演示变更保存在当前浏览器；数据库和外部引擎尚未连接。
                  </p>
                  <Btn
                    onClick={() => {
                      setChanges(initialChanges);
                      setChangeDetail(null);
                      say("已重置本地演示历史。");
                    }}
                  >
                    重置演示历史
                  </Btn>
                </div>
              )}
              {panelView === "engines" && (
                <div className="management" data-screen-label="能力与连接">
                  <span className="eyebrow">一份记忆，多种能力</span>
                  <h1>能力与连接</h1>
                  <p className="lead">
                    材料和引用属于 omem。引擎提供可替换的检索与学习能力。
                  </p>
                  <div className="engine-row">
                    <span className="engine-initial">W</span>
                    <div>
                      <h3>WeKnora</h3>
                      <p>文档解析与混合检索 · 推荐 PoC</p>
                    </div>
                    <Chip>待接入</Chip>
                  </div>
                  <div className="engine-row">
                    <span className="engine-initial">H</span>
                    <div>
                      <h3>Hindsight</h3>
                      <p>经历巩固与反思 · 候选生成</p>
                    </div>
                    <button
                      className={"switch " + (engineOn ? "on" : "")}
                      role="switch"
                      aria-label="演示启用 Hindsight"
                      aria-checked={engineOn}
                      onClick={() => {
                        setEngineOn(!engineOn);
                        say(
                          engineOn
                            ? "已模拟停用学习引擎，原文与引用仍可读。"
                            : "已模拟启用学习引擎。",
                        );
                      }}
                    >
                      <span />
                    </button>
                  </div>
                  <p className="explanation">
                    {engineOn
                      ? "演示配置：学习引擎输出候选，再由 omem 核对证据。"
                      : "演示配置：学习引擎已停用，已有知识与固定引用不受影响。"}{" "}
                    此开关只改变原型状态。
                  </p>
                  <h2>给你的 Agent 接上记忆</h2>
                  <div className="integration-grid">
                    {[
                      ["MCP", "检索、读取证据、记录经历"],
                      ["Skills", "什么时候记，什么时候用"],
                      ["API / SDK", "连接已有工作流"],
                    ].map(([name, text]) => (
                      <div key={name}>
                        <b>{name}</b>
                        <p>{text}</p>
                        <small>服务端实施范围 · 当前未连接</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <aside
              className={"right-panel " + (rightOpen ? "mobile-open" : "")}
            >
              <button
                className="close-mobile-chat"
                onClick={() => setRightOpen(false)}
                aria-label="关闭问答"
              >
                <I name="close" />
              </button>
              <ChatPanel
                key={focus}
                focus={focus}
                selection={
                  selection?.active && !selection.inModal ? selection.text : ""
                }
                onCite={openNode}
                threads={threads}
                setThreads={setThreads}
                onSave={saveAnswer}
              />
            </aside>
          </div>
        </main>
      </div>
      <dialog
        ref={dialog}
        className={"trace-dialog " + (current?.ask ? "with-chat" : "")}
        aria-labelledby="trace-title"
        onCancel={(e) => {
          e.preventDefault();
          back();
        }}
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
      >
        {node && (
          <div className="trace-shell" data-screen-label="递归引用弹窗">
            <div className="trace-top">
              <div className="trace-label">
                <I name="layers" size={16} />
                证据路径<Chip>第 {frames.length} 层</Chip>
              </div>
              <button
                className="icon-btn"
                aria-label="关闭全部引用"
                onClick={close}
              >
                <I name="close" />
              </button>
            </div>
            <nav className="trace-breadcrumb" aria-label="引用路径">
              {frames.map((f, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <I name="arrow" size={10} />}
                  <button
                    onClick={() => jump(i)}
                    aria-current={i === frames.length - 1 ? "step" : undefined}
                  >
                    <span>{i + 1}</span>
                    {nodes[f.id].title}
                  </button>
                </React.Fragment>
              ))}
            </nav>
            {frames.length > 1 && (
              <div className="parent-peek">
                <button onClick={back}>
                  <I name="back" size={14} />
                  <span>来自第 {frames.length - 1} 层</span>{" "}
                  {nodes[frames.at(-2).id].title}
                </button>
              </div>
            )}
            <div className="trace-content">
              <div className="trace-reader">
                <header className="trace-heading">
                  <div className="article-kicker">
                    {node.kind}
                    <span className="muted">{node.version}</span>
                  </div>
                  <h2
                    id="trace-title"
                    className="trace-current-title"
                    tabIndex={-1}
                  >
                    {node.title}
                  </h2>
                  <p>{node.section}</p>
                  <div className="trace-meta">
                    <span>{node.owner || "来源状态"}</span>
                    <span>{node.date}</span>
                    <span>固定原文快照</span>
                  </div>
                </header>
                <div
                  className="trace-tabs"
                  role="tablist"
                  aria-label="片段视图"
                >
                  {[
                    ["excerpt", "引用片段"],
                    ["context", "上下文"],
                    ["backlinks", "谁引用了它"],
                    ["versions", "版本"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={current.tab === key}
                      onClick={() => updateFrame({ tab: key })}
                    >
                      {label}
                      {key === "backlinks" && <small>{backlinks.length}</small>}
                    </button>
                  ))}
                </div>
                <div className="trace-body" ref={modalBody}>
                  {loop !== null && (
                    <div className="loop-notice" role="status">
                      <I name="refresh" />
                      <div>
                        <b>这份材料已在路径第 {loop + 1} 层</b>
                        <p>检测到循环引用，当前路径保持不变。</p>
                        <button onClick={() => jump(loop)}>
                          返回已打开的那一层 <I name="back" size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                  {node.status === "superseded" && (
                    <div className="state-banner">
                      <I name="clock" size={17} />
                      <span>正在查看历史版本 r6，现行版本是 r7。</span>
                      <button onClick={() => openNode("policy")}>
                        查看现行版本
                      </button>
                    </div>
                  )}
                  {!["available", "superseded"].includes(node.status) ? (
                    <div className="empty evidence-empty">
                      <I
                        name={node.status === "restricted" ? "flag" : "link"}
                        size={30}
                      />
                      <h3>
                        {
                          {
                            restricted: "当前无权查看",
                            deleted: "原始内容已删除",
                            anchor_unresolved: "原文位置尚待核对",
                          }[node.status]
                        }
                      </h3>
                      <p>{node.body}</p>
                      <Btn onClick={back}>返回引用处</Btn>
                    </div>
                  ) : current.tab === "backlinks" ? (
                    <>
                      <span className="eyebrow">直接引用此固定版本</span>
                      {backlinks.length ? (
                        backlinks.map(([id, n]) => (
                          <button
                            className="reference-row"
                            key={id}
                            onClick={() => openNode(id)}
                          >
                            <I name="book" />
                            <span>
                              <b>{n.title}</b>
                              <small>
                                {n.kind} · {n.version}
                              </small>
                            </span>
                            <I name="arrow" size={15} />
                          </button>
                        ))
                      ) : (
                        <p className="muted">本例没有记录其他直接引用。</p>
                      )}
                    </>
                  ) : current.tab === "versions" ? (
                    <div className="version-view">
                      <h3>引用固定到 {node.version}</h3>
                      <p>新版本不会修改这段历史原文。</p>
                      {["old", "policy"].includes(current.id) ? (
                        <>
                          <div className="diff">
                            <div>
                              <span>r6 · 历史</span>
                              <p>{nodes.old.quote}</p>
                              <button
                                className="text-link"
                                onClick={() => openNode("old")}
                              >
                                打开历史版本
                              </button>
                            </div>
                            <div>
                              <span>r7 · 现行</span>
                              <p>{nodes.policy.quote}</p>
                              <button
                                className="text-link"
                                onClick={() => openNode("policy")}
                              >
                                打开现行版本
                              </button>
                            </div>
                          </div>
                          <p className="muted">
                            变化：新增回滚验证与执行记录要求。
                          </p>
                        </>
                      ) : (
                        <p className="muted">此示例片段仅有一个已保存版本。</p>
                      )}
                    </div>
                  ) : (
                    <div data-selectable="true" data-focus={current.id}>
                      <div className="quote-label">
                        <I name="link" size={14} />
                        {current.tab === "excerpt"
                          ? "被引用的原文"
                          : "原文与必要上下文"}
                      </div>
                      {current.tab === "context" && (
                        <p className="context-before">
                          以下片段位于“{node.section}
                          ”。这里保留当前段及对理解它有帮助的相邻说明。
                        </p>
                      )}
                      <blockquote className="evidence-quote">
                        {node.quote}
                      </blockquote>
                      <p className="evidence-body">{node.body}</p>
                      <div className="next-refs">
                        <div className="section-label">
                          <h3>
                            {node.refs.length
                              ? "这段材料还引用了"
                              : "这条路径的原始记录"}
                          </h3>
                          <span>
                            {node.refs.length
                              ? node.refs.length + " 条关系"
                              : "已到达末端"}
                          </span>
                        </div>
                        {node.refs.map((r) => (
                          <button
                            className="reference-row"
                            key={r.id}
                            onClick={() => openNode(r.id)}
                          >
                            <span className="reference-icon">
                              <I name="link" size={16} />
                            </span>
                            <span>
                              <b>{r.label}</b>
                              <small>
                                {r.type} · {nodes[r.id].version}
                                {frames.some((f) => f.id === r.id)
                                  ? " · 已在当前路径"
                                  : ""}
                              </small>
                            </span>
                            <I name="arrow" size={15} />
                          </button>
                        ))}
                      </div>
                      <p className="evidence-note">
                        引用关系描述材料的来路；是否支持某个结论，需逐条核对。以上为演示数据。
                      </p>
                    </div>
                  )}
                </div>
                <footer className="trace-footer">
                  <Btn icon="back" onClick={back}>
                    {frames.length > 1 ? "返回上一层" : "返回阅读"}
                  </Btn>
                  <button
                    className="copy-link"
                    onClick={copyLink}
                    title="复制片段链接"
                    aria-label="复制片段链接"
                  >
                    <I name="link" size={17} />
                  </button>
                  <Btn
                    primary
                    icon="chat"
                    disabled={
                      !["available", "superseded"].includes(node.status)
                    }
                    onClick={() => updateFrame({ ask: !current.ask })}
                  >
                    {current.ask ? "收起追问" : "就这段追问"}
                  </Btn>
                </footer>
              </div>
              {current.ask && (
                <ChatPanel
                  key={current.id + ":local"}
                  focus={current.id}
                  selection={current.selection || ""}
                  inline
                  pathRefs={frames.map((f) => f.id)}
                  onCite={openNode}
                  threads={threads}
                  setThreads={setThreads}
                  onSave={saveAnswer}
                />
              )}
            </div>
          </div>
        )}
        {selection?.inModal && !selection.active && (
          <button
            className="selection-action"
            style={{ left: selection.x, top: selection.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={askSelection}
          >
            <I name="spark" size={15} />
            追问选中内容
          </button>
        )}
        {toast && (
          <div className="toast" role="status">
            <I name="check" size={16} />
            {toast}
          </div>
        )}
      </dialog>
      {selection && !selection.inModal && !selection.active && (
        <button
          className="selection-action"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={askSelection}
        >
          <I name="spark" size={15} />
          追问选中内容
        </button>
      )}
      {toast && !frames.length && (
        <div className="toast" role="status">
          <I name="check" size={16} />
          {toast}
        </div>
      )}
      <TweaksPanel title="阅读风格">
        <TweakSlider
          label="正文字号"
          value={tweak.fontSize}
          min={14}
          max={20}
          unit="px"
          onChange={(v) => setTweak("fontSize", v)}
        />
        <TweakSelect
          label="阅读密度"
          value={tweak.density}
          options={["舒展", "紧凑"]}
          onChange={(v) => setTweak("density", v)}
        />
      </TweaksPanel>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
