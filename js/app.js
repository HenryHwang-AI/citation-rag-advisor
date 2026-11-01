/* Chat, citations, retrieval trace, and the in-browser eval harness. */
(function () {
  "use strict";

  var data = window.ADVISOR_DATA;
  var engine = window.AdvisorEngine.create(data);
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var narrow = window.matchMedia("(max-width: 960px)");

  var state = {
    view: "chat",
    messages: [],
    memory: null,
    activeId: null,
    seq: 1,
    examplesOpen: false,
    evalRows: null
  };

  var thread = document.getElementById("thread");
  var traceBody = document.getElementById("trace-body");
  var input = document.getElementById("q");
  var followHint = document.getElementById("follow-hint");
  var exampleList = document.getElementById("example-list");
  var live = document.getElementById("live-status");
  var INTENT = { judge: "判断", sop: "流程", case: "案例", brief: "说明" };

  document.querySelectorAll("[data-nav]").forEach(function (btn) {
    btn.addEventListener("click", function () { setView(btn.getAttribute("data-nav")); });
  });
  document.getElementById("btn-send").addEventListener("click", function () { send(input.value); });
  document.getElementById("btn-clear").addEventListener("click", reset);
  document.getElementById("btn-examples").addEventListener("click", toggleExamples);
  document.getElementById("btn-eval").addEventListener("click", runEval);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener("input", onDraft);
  thread.addEventListener("click", onThreadClick);
  exampleList.addEventListener("click", function (event) {
    var button = event.target.closest("[data-q]");
    if (button) send(button.getAttribute("data-q"));
  });

  renderExamples(document.getElementById("starters"));
  renderExamples(exampleList);
  renderTrace();
  fillConfig();
  renderCatalog();
  renderEval();
  syncSend();

  function setView(view) {
    state.view = view;
    document.body.dataset.view = view;
    document.querySelectorAll(".nav [data-nav]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-nav") === view ? "true" : "false");
    });
    if (view === "chat" && input && !narrow.matches) input.focus();
  }

  function reset() {
    state.messages = [];
    state.memory = null;
    state.activeId = null;
    state.examplesOpen = false;
    exampleList.hidden = true;
    document.getElementById("btn-examples").setAttribute("aria-expanded", "false");
    input.value = "";
    followHint.hidden = true;
    renderThread();
    renderTrace();
    syncSend();
  }

  function toggleExamples() {
    state.examplesOpen = !state.examplesOpen;
    exampleList.hidden = !state.examplesOpen;
    document.getElementById("btn-examples").setAttribute("aria-expanded", state.examplesOpen ? "true" : "false");
  }

  function onDraft() {
    syncSend();
    var text = input.value.trim();
    if (!text || !state.memory) {
      followHint.hidden = true;
      return;
    }
    var preview = engine.preview(text, state.memory);
    if (!preview.isFollowup) {
      followHint.hidden = true;
      return;
    }
    followHint.hidden = false;
    followHint.textContent = preview.addedTerms.length
      ? "本轮会结合上一问改写检索，补入：" + preview.addedTerms.join("、")
      : "本轮会按追问处理，沿用上一轮主题。";
  }

  function syncSend() {
    document.getElementById("btn-send").disabled = input.value.trim().length === 0;
  }

  function send(text) {
    var query = String(text || "").trim();
    if (!query) return;
    var userId = "m" + state.seq++;
    var asstId = "m" + state.seq++;
    state.messages.push({ id: userId, role: "user", text: query });
    var result = engine.answer({ query: query, memory: state.memory });
    state.messages.push({ id: asstId, role: "assistant", result: result });
    if (result.decision === "answer") {
      state.memory = { query: query, terms: result.memoryTerms };
    }
    state.activeId = asstId;
    state.examplesOpen = false;
    exampleList.hidden = true;
    input.value = "";
    followHint.hidden = true;
    setView("chat");
    renderThread();
    renderTrace();
    syncSend();
    var node = thread.querySelector('[data-msg="' + userId + '"]');
    if (node) node.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
    live.textContent = result.decision === "answer"
      ? "已回答，引用 " + result.citations.length + " 条"
      : "已拒答。" + result.reason;
  }

  function renderExamples(mount) {
    mount.innerHTML = data.starters.map(function (starter, index) {
      return '<button type="button" class="starter" data-q="' + esc(starter.question) + '">' +
        "<b>" + (index + 1) + ". " + esc(starter.question) + "</b>" +
        "<small>" + esc(starter.hint) + "</small></button>";
    }).join("");
  }

  function renderThread() {
    var inner = thread.querySelector(".thread-inner");
    if (!state.messages.length) {
      inner.innerHTML = document.getElementById("hero")
        ? inner.innerHTML
        : "";
      if (!inner.querySelector("#hero")) {
        inner.innerHTML = heroHtml();
        renderExamples(inner.querySelector("#starters"));
      }
      return;
    }
    inner.innerHTML = state.messages.map(renderMessage).join("");
  }

  function heroHtml() {
    var hero = document.getElementById("hero");
    if (hero) return "";
    return "";
  }

  function renderMessage(msg) {
    if (msg.role === "user") {
      return '<article class="msg msg-user" data-msg="' + msg.id + '" data-role="user"><p>' + esc(msg.text) + "</p></article>";
    }
    var result = msg.result;
    var active = msg.id === state.activeId ? " is-active is-fresh" : "";
    var body = result.decision === "answer" ? answerHtml(msg.id, result) : refuseHtml(result);
    var pill = result.decision === "answer"
      ? '<span class="pill ok">抽取式 · ' + result.citations.length + " 条引用</span>"
      : '<span class="pill bad">拒答</span>';
    var intent = result.decision === "answer"
      ? '<span class="pill ghost">' + esc(INTENT[result.intent] || "说明") + "</span>"
      : "";
    var rewrite = result.isFollowup
      ? '<p class="rewrite">多轮改写' + (result.addedTerms.length ? "，补入 " + esc(result.addedTerms.join("、")) : "") + "。</p>"
      : "";
    return '<article class="msg msg-assistant' + active + '" data-msg="' + msg.id + '" data-role="assistant">' +
      '<div class="msg-kicker"><span class="who">引溯</span>' + pill + intent + "</div>" +
      rewrite + body +
      '<div class="msg-tools"><button type="button" class="texty" data-show-trace="' + msg.id + '">查看检索轨迹</button></div>' +
      "</article>";
  }

  function answerHtml(msgId, result) {
    var points = result.citations.map(function (cite) {
      var lines = cite.sentences.map(function (sentence) {
        return "<p>" + esc(sentence) + "</p>";
      }).join("");
      return '<div class="point"><div class="point-copy">' + lines + "</div>" +
        '<button type="button" class="cite-ref" data-cite="' + cite.n + '" data-chunk="' + esc(cite.id) + '" data-msg="' + msgId + '" aria-label="查看来源 ' + cite.n + " " + esc(cite.title) + '">' + cite.n + "</button></div>";
    }).join("");
    var cards = result.citations.map(function (cite) {
      return '<article class="cite-card" id="cite-' + msgId + "-" + cite.n + '" data-chunk="' + esc(cite.id) + '">' +
        '<button type="button" class="cite-no" data-cite="' + cite.n + '" data-chunk="' + esc(cite.id) + '" data-msg="' + msgId + '" aria-label="来源 ' + cite.n + '">' + cite.n + "</button>" +
        "<div><h3>" + esc(cite.title) + "</h3>" +
        '<p class="meta">' + esc(cite.source) + " · " + esc(cite.section) + " · " + esc(cite.updated) + "</p>" +
        '<span class="cat">' + esc(cite.category) + "</span>" +
        '<p class="snip">' + highlight(cite.snippet, result.focus) + "</p>" +
        '<p class="full">' + highlight(cite.text, result.focus) + "</p>" +
        '<button type="button" class="expand" data-expand>展开全文</button></div></article>';
    }).join("");
    return '<p class="lead">' + esc(result.lead) + "</p>" +
      '<div class="points">' + points + "</div>" +
      '<p class="note">编号指向知识块。没有出现在编号里的话，不要当成依据。</p>' +
      '<div class="cards">' + cards + "</div>";
  }

  function refuseHtml(result) {
    var items = (result.suggestions || []).map(function (item) {
      return "<li><button type=\"button\" data-q=\"" + esc(item.question) + "\"><b>" + esc(item.title) + "</b><small>" + esc(item.note) + " · " + esc(item.source || "") + "</small></button></li>";
    }).join("");
    return '<div class="refuse"><p class="kicker">拒答</p><h3>知识库里没有足以引用的依据</h3><p>' + esc(result.reason) + "</p>" +
      (items ? "<p>可以改问这些文档：</p><ul class=\"suggest\">" + items + "</ul>" : "") +
      "</div>";
  }

  function onThreadClick(event) {
    var sendBtn = event.target.closest("[data-q]");
    if (sendBtn && thread.contains(sendBtn)) {
      send(sendBtn.getAttribute("data-q"));
      return;
    }
    var expand = event.target.closest("[data-expand]");
    if (expand) {
      var card = expand.closest(".cite-card");
      card.classList.toggle("is-open");
      expand.textContent = card.classList.contains("is-open") ? "收起全文" : "展开全文";
      return;
    }
    var cite = event.target.closest("[data-cite]");
    if (cite) {
      focusCite(cite.getAttribute("data-msg"), cite.getAttribute("data-cite"), cite.getAttribute("data-chunk"));
      return;
    }
    var traceBtn = event.target.closest("[data-show-trace]");
    if (traceBtn) {
      activate(traceBtn.getAttribute("data-show-trace"), true);
      return;
    }
    var msg = event.target.closest("[data-role='assistant']");
    if (msg) activate(msg.getAttribute("data-msg"), false);
  }

  function activate(id, openPanel) {
    state.activeId = id;
    thread.querySelectorAll(".msg-assistant").forEach(function (node) {
      node.classList.toggle("is-active", node.getAttribute("data-msg") === id);
    });
    renderTrace();
    if (openPanel && narrow.matches) setView("trace");
  }

  function focusCite(msgId, n, chunkId) {
    activate(msgId, false);
    document.querySelectorAll(".cite-card.is-hot, .trace-row.is-hot").forEach(function (node) {
      node.classList.remove("is-hot");
    });
    var card = document.getElementById("cite-" + msgId + "-" + n);
    if (card) {
      card.classList.add("is-hot", "is-open");
      var expand = card.querySelector("[data-expand]");
      if (expand) expand.textContent = "收起全文";
      card.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "nearest" });
    }
    var row = traceBody.querySelector('.trace-row[data-chunk="' + cssEscape(chunkId) + '"]');
    if (row) {
      row.classList.add("is-hot");
      row.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "nearest" });
    }
  }

  function activeResult() {
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var msg = state.messages[i];
      if (msg.role === "assistant" && (!state.activeId || msg.id === state.activeId)) return msg;
    }
    return null;
  }

  function renderTrace() {
    var msg = activeResult();
    if (!msg) {
      traceBody.innerHTML = '<p class="empty-trace">发送问题后，这里按顺序展示：原问、多轮改写、分词、BM25 Top ' +
        engine.config.topK + "、重排分，以及过阈值还是拒答。</p>";
      return;
    }
    var result = msg.result;
    var decisionClass = result.decision === "answer" ? "answer" : "refuse";
    var decisionLabel = result.decision === "answer" ? "引用 " + result.citations.length + " 条" : "拒答";
    var added = result.isFollowup
      ? (result.addedTerms.length ? "补入 " + esc(result.addedTerms.join("、")) : "沿用上一轮主题")
      : "首轮问题，未改写";
    var termChips = result.tokens.terms.map(function (term) {
      return '<span class="chip">' + esc(term) + "</span>";
    }).join("");
    var bigramChips = result.tokens.bigramCount
      ? '<span class="chip dim">二元组 ' + result.tokens.bigramCount + " 个</span>"
      : "";
    var visible = result.candidates.filter(function (row) { return row.bm25 > 0; });
    if (!visible.length) visible = result.candidates.slice(0, 3);
    var rows = visible.map(function (row) {
      var tag = row.above ? '<span class="pill ok">引用 ' + row.n + "</span>" : '<span class="pill ghost">' + (row.grounded ? "未过阈值" : "词项不足") + "</span>";
      return '<article class="trace-row' + (row.above ? " is-cited" : "") + '" data-chunk="' + esc(row.id) + '">' +
        "<header><div><p class=\"id\">" + esc(row.id) + "</p><h4>" + esc(row.title) + "</h4></div>" + tag + "</header>" +
        '<div class="scores"><span>BM25 ' + row.bm25.toFixed(2) + "</span>" + meter(row.bm25Norm, "cyan") + "<span>" + row.bm25Norm.toFixed(2) + "</span></div>" +
        '<div class="scores"><span>重排 ' + row.rerank.toFixed(2) + "</span>" + meter(row.rerank, "violet") + "<span>" + row.rerank.toFixed(2) + "</span></div>" +
        '<p class="meta">句覆盖 ' + row.coverage.toFixed(2) + " · 标题 " + row.titleHit.toFixed(2) +
        (shownHits(row, result).length ? " · " + esc(shownHits(row, result).join("、")) : "") + "</p></article>";
    }).join("");
    traceBody.innerHTML =
      '<div class="decision ' + decisionClass + '"><strong>' + decisionLabel + "</strong><span>" + esc(result.reason) + "</span></div>" +
      '<section class="trace-block"><h3>查询</h3><p class="label">原问</p><p class="query-text">' + esc(result.query) + "</p>" +
      '<p class="label">改写</p><p class="query-text">' + added + "</p></section>" +
      '<section class="trace-block"><h3>分词</h3><div class="chips">' + (termChips || '<span class="chip dim">无词表命中</span>') + bigramChips + "</div></section>" +
      '<section class="trace-block"><h3>Top ' + visible.length + " · 按重排分</h3>" + rows + "</section>" +
      '<p class="formula">' + esc(result.formula) + "</p>";
  }

  function shownHits(row, result) {
    var terms = result.tokens.terms || [];
    var picked = row.distinctive.filter(function (term) { return terms.indexOf(term) !== -1; });
    if (!picked.length) picked = row.distinctive.filter(function (term) { return term.length >= 2; }).slice(0, 3);
    return picked.slice(0, 6);
  }

  function meter(score, kind) {
    var n = 18;
    var on = Math.round(Math.max(0, Math.min(1, score)) * n);
    var cells = "";
    for (var i = 0; i < n; i++) cells += "<i" + (i < on ? ' class="on"' : "") + "></i>";
    return '<span class="meter meter-' + kind + '" aria-hidden="true">' + cells + "</span>";
  }

  function fillConfig() {
    var cfg = engine.config;
    var line = document.getElementById("cfg-line");
    line.textContent = "当前引擎：k1 " + cfg.k1 + "，b " + cfg.b +
      "，词表权重 " + cfg.termWeight + "，二元组权重 " + cfg.bigramWeight +
      "，饱和常数 " + cfg.bm25Sat +
      "。重排 = " + cfg.rerankBm25 + "×饱和 BM25 + " + cfg.rerankCoverage + "×句覆盖 + " + cfg.rerankTitle + "×标题。" +
      " 引用阈值 " + cfg.rerankFloor + "，相对阈值 " + cfg.relative +
      "，最多 " + cfg.maxCites + " 条。索引 " + engine.stats.docs + " 篇，词表 " + engine.stats.terms +
      "，平均长度 " + engine.stats.avgdl + " 字。";
  }

  function renderCatalog() {
    var rows = data.chunks.map(function (chunk) {
      return "<tr><td class=\"id\">" + esc(chunk.id) + "</td><td>" + esc(chunk.title) + "</td><td>" + esc(chunk.category) + "</td><td>" + chunk.text.length + "</td></tr>";
    }).join("");
    document.getElementById("kb-catalog").innerHTML =
      "<table><thead><tr><th>ID</th><th>标题</th><th>类目</th><th>字数</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function runEval() {
    state.evalRows = engine.runEval();
    renderEval();
  }

  function renderEval() {
    var root = document.getElementById("eval-root");
    var rows = state.evalRows;
    if (!rows) {
      root.innerHTML = "<p class=\"lede\">还没跑。下面先列出题目和期望文档，跑完再看是否命中。</p>" + evalTable(data.evalSet.map(function (item) {
        return {
          id: item.id,
          mode: item.mode,
          question: item.question,
          expect: item.expect,
          note: item.note,
          pending: true
        };
      }));
      return;
    }
    var answers = rows.filter(function (row) { return row.mode === "answer"; });
    var refuses = rows.filter(function (row) { return row.mode === "refuse"; });
    var recall = answers.reduce(function (sum, row) { return sum + row.recall; }, 0) / answers.length;
    var refuseAcc = refuses.filter(function (row) { return row.pass; }).length / refuses.length;
    var faithful = rows.filter(function (row) { return row.mode !== "gap"; }).every(function (row) { return row.faithful; });
    root.innerHTML =
      '<div class="metrics">' +
      metric(pct(recall), "Recall@3") +
      metric(pct(refuseAcc), "拒答准确率") +
      metric(faithful ? "100%" : "失败", "引用忠实") +
      "</div>" + evalTable(rows);
  }

  function metric(value, label) {
    return '<div class="metric"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>";
  }

  function evalTable(rows) {
    var body = rows.map(function (row) {
      var titles = (row.expect || []).map(titleOf).join("、") || "应拒答";
      var actual = row.pending ? "—" : ((row.cited && row.cited.length) ? row.cited.map(titleOf).join("、") : row.decision);
      var mark = row.pending ? "—" : row.mode === "gap" ? '<span class="gap">观察</span>' : row.pass ? '<span class="pass">通过</span>' : '<span class="fail">未过</span>';
      return "<tr><td class=\"id\">" + esc(row.id) + "</td><td>" + esc(row.question) + "</td><td>" + esc(titles) + "</td><td>" + esc(String(actual)) + "</td><td>" + mark + "</td></tr>";
    }).join("");
    return "<table><thead><tr><th>ID</th><th>问题</th><th>金标</th><th>本次引用</th><th>结果</th></tr></thead><tbody>" + body + "</tbody></table>";
  }

  function titleOf(id) {
    var chunk = data.chunks.filter(function (item) { return item.id === id; })[0];
    return chunk ? chunk.title : id;
  }

  function pct(n) {
    return Math.round(n * 100) + "%";
  }

  function highlight(text, terms) {
    var list = [] .concat(terms || []).filter(function (term, index, arr) {
      return term && term.length >= 2 && arr.indexOf(term) === index;
    }).sort(function (a, b) { return b.length - a.length; }).slice(0, 8);
    if (!list.length) return esc(text);
    var re = new RegExp(list.map(escapeReg).join("|"), "gi");
    var out = "";
    var last = 0;
    var match;
    var source = String(text);
    while ((match = re.exec(source))) {
      out += esc(source.slice(last, match.index)) + "<mark>" + esc(match[0]) + "</mark>";
      last = match.index + match[0].length;
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
    return out + esc(source.slice(last));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function escapeReg(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  var initialHero = thread.querySelector(".thread-inner").innerHTML;
  function renderThreadSafe() {
    if (!state.messages.length) {
      thread.querySelector(".thread-inner").innerHTML = initialHero;
      renderExamples(document.getElementById("starters"));
      return;
    }
    thread.querySelector(".thread-inner").innerHTML = state.messages.map(renderMessage).join("");
  }
  renderThread = renderThreadSafe;
})();
