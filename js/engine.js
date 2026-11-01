/* Client-side retriever for the citation advisor.
   BM25 over a domain lexicon + character bigrams, then an explainable rerank stand-in.
   No network, no embeddings. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AdvisorEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CONFIG = {
    k1: 1.2,
    b: 0.72,
    termWeight: 1.45,
    bigramWeight: 0.42,
    numberWeight: 0.9,
    rerankBm25: 0.62,
    rerankCoverage: 0.28,
    rerankTitle: 0.1,
    rerankFloor: 0.46,
    relative: 0.58,
    bm25Sat: 3,
    topK: 5,
    maxCites: 3,
    lexDfRatio: 0.67,
    bigramDfRatio: 0.42,
    memoryTerms: 6
  };

  var STOP_BIGRAM = {
    "这个": 1, "那个": 1, "我们": 1, "你们": 1, "他们": 1, "它们": 1, "一个": 1, "一种": 1,
    "一下": 1, "如何": 1, "怎么": 1, "怎样": 1, "什么": 1, "哪些": 1, "哪个": 1, "是否": 1,
    "可以": 1, "如果": 1, "因为": 1, "所以": 1, "以及": 1, "或者": 1, "还是": 1, "需要": 1,
    "进行": 1, "通过": 1, "其中": 1, "对于": 1, "关于": 1, "自己": 1, "已经": 1, "这样": 1,
    "那样": 1, "这里": 1, "那里": 1, "请问": 1, "知道": 1, "时候": 1, "的话": 1, "没有": 1,
    "就是": 1, "还要": 1, "不会": 1, "不是": 1, "怎么": 1, "什么": 1, "我们": 1, "你们": 1
  };

  var ANAPHORA = /它|这个|那个|上述|刚才|前面|上一轮|上面说的/;

  function normalize(input) {
    return String(input || "")
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function unique(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || seen[t]) continue;
      seen[t] = 1;
      out.push(t);
    }
    return out;
  }

  function countOf(hay, needle) {
    var n = 0;
    var from = 0;
    var step = Math.max(needle.length, 1);
    while (from <= hay.length - needle.length) {
      var idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      n += 1;
      from = idx + step;
    }
    return n;
  }

  function charLen(norm) {
    var cjk = (norm.match(/[\u4e00-\u9fff]/g) || []).length;
    var ascii = (norm.match(/[a-z0-9]+/g) || []).length;
    return Math.max(cjk + ascii, 1);
  }

  function tokenize(text, lexicon) {
    var norm = normalize(text);
    var terms = [];
    var bigrams = [];
    var numbers = [];
    for (var i = 0; i < lexicon.length; i++) {
      var term = lexicon[i];
      var c = countOf(norm, term);
      for (var k = 0; k < c; k++) terms.push(term);
    }
    var segs = norm.match(/[\u4e00-\u9fff]+/g) || [];
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      for (var j = 0; j < seg.length - 1; j++) {
        var bg = seg.slice(j, j + 2);
        if (STOP_BIGRAM[bg]) continue;
        if (/[的了是在和与或及把被对为以而也就都还]/.test(bg)) continue;
        bigrams.push(bg);
      }
    }
    var nums = norm.match(/\d{2,}/g) || [];
    for (var n = 0; n < nums.length; n++) numbers.push(nums[n]);
    var ascii = norm.match(/[a-z][a-z0-9]{1,}/g) || [];
    return { norm: norm, terms: terms, bigrams: bigrams, numbers: numbers, ascii: ascii, len: charLen(norm) };
  }

  function addCounts(map, tokens, weight) {
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var slot = map.get(t);
      if (!slot) map.set(t, { tf: 1, w: weight });
      else slot.tf += 1;
    }
  }

  function sentencesOf(text) {
    var out = [];
    var buf = "";
    for (var i = 0; i < text.length; i++) {
      buf += text[i];
      var ch = text[i];
      if (ch === "。" || ch === "！" || ch === "？") {
        var s = buf.trim();
        if (s.length >= 8) out.push(s);
        buf = "";
      }
    }
    if (buf.trim().length >= 8) out.push(buf.trim());
    return out;
  }

  function intentOf(query) {
    if (/案例|坑|复盘|ROI|roi|口径|300/.test(query)) return "case";
    if (/怎么|如何|流程|步骤|SOP|sop|清单|审核/.test(query)) return "sop";
    if (/能不能|能否|可以吗|是否|行不行|允许|禁止|红线|合格|越线/.test(query)) return "judge";
    return "brief";
  }

  function leadFor(intent, sentences) {
    var joined = sentences.join("");
    if (intent === "judge" && /不得|禁止|不能|不允许|必须退回|不合格/.test(joined)) {
      return "按收录口径，这落在禁止或限制项里。下面每句都是知识库原文，编号对应来源卡片。";
    }
    if (intent === "sop") return "按已收录的操作口径，关键句如下。每句都能回到来源卡片核对。";
    if (intent === "case") return "知识库里有可对照的案例和口径限制。先看原文结论，再打开卡片看完整背景。";
    if (/不得|禁止|不能|不允许/.test(joined)) {
      return "按收录口径，下面是直接相关的限制。编号可以点开，核对高亮句是否支持这句话。";
    }
    return "以下摘自越过引用阈值的条款。没有写进编号的内容，不会用常识补上。";
  }

  function create(data) {
    if (!data || !data.chunks || !data.chunks.length) throw new Error("知识库为空");
    var lexicon = unique((data.lexicon || []).map(normalize).filter(function (t) { return t.length >= 2; }));
    lexicon.sort(function (a, b) { return b.length - a.length; });
    var lexSet = Object.create(null);
    for (var i = 0; i < lexicon.length; i++) lexSet[lexicon[i]] = 1;
    var vague = Object.create(null);
    (data.vague || []).forEach(function (t) { vague[normalize(t)] = 1; });

    var built = data.chunks.map(function (chunk) {
      var body = chunk.title + "\n" + chunk.text;
      var tok = tokenize(body, lexicon);
      var tf = new Map();
      addCounts(tf, tok.terms, CONFIG.termWeight);
      addCounts(tf, tok.bigrams, CONFIG.bigramWeight);
      addCounts(tf, tok.numbers, CONFIG.numberWeight);
      var tokenSet = Object.create(null);
      tf.forEach(function (_v, key) { tokenSet[key] = 1; });
      return {
        chunk: chunk,
        tf: tf,
        tokenSet: tokenSet,
        len: tokenize(chunk.text + chunk.title, []).len,
        sentences: sentencesOf(chunk.text)
      };
    });

    var N = built.length;
    var df = new Map();
    built.forEach(function (doc) {
      Object.keys(doc.tokenSet).forEach(function (t) {
        df.set(t, (df.get(t) || 0) + 1);
      });
    });
    var avgdl = built.reduce(function (s, d) { return s + d.len; }, 0) / N;
    var lexDfMax = Math.max(1, Math.floor(N * CONFIG.lexDfRatio));
    var bgDfMax = Math.max(1, Math.floor(N * CONFIG.bigramDfRatio));

    function idf(token) {
      var dfi = df.get(token) || 0;
      return Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
    }

    function isDistinctLex(token) {
      if (!lexSet[token]) return false;
      var dfi = df.get(token) || 0;
      return dfi > 0 && dfi <= lexDfMax;
    }

    function isDistinctBg(token) {
      if (lexSet[token]) return false;
      var dfi = df.get(token) || 0;
      return dfi > 0 && dfi <= bgDfMax;
    }

    function bm25(doc, qUnique) {
      var score = 0;
      for (var i = 0; i < qUnique.length; i++) {
        var t = qUnique[i].token;
        var slot = doc.tf.get(t);
        if (!slot) continue;
        var tf = slot.tf;
        var denom = tf + CONFIG.k1 * (1 - CONFIG.b + CONFIG.b * doc.len / avgdl);
        var sat = (tf * (CONFIG.k1 + 1)) / denom;
        score += qUnique[i].weight * idf(t) * sat;
      }
      return score;
    }

    function queryTokens(tok) {
      var bag = [];
      unique(tok.terms).forEach(function (t) { bag.push({ token: t, weight: CONFIG.termWeight, kind: "term" }); });
      unique(tok.bigrams).forEach(function (t) { bag.push({ token: t, weight: CONFIG.bigramWeight, kind: "bigram" }); });
      unique(tok.numbers).forEach(function (t) { bag.push({ token: t, weight: CONFIG.numberWeight, kind: "number" }); });
      return bag;
    }

    function contentTerms(tok) {
      return unique(tok.terms).filter(function (t) { return !vague[t] && isDistinctLex(t); });
    }

    function shouldFollow(query, tok, memory) {
      if (!memory || !memory.terms || !memory.terms.length) return false;
      if (ANAPHORA.test(query)) return true;
      var content = unique(tok.terms).filter(function (t) { return !vague[t]; });
      if (!content.length) {
        var compact = String(query || "").replace(/\s+/g, "");
        if (compact.length <= 16) return true;
        if (/详细|展开|继续|具体|再说|讲讲|说说/.test(query)) return true;
        return false;
      }
      return content.every(function (t) { return memory.terms.indexOf(t) !== -1; });
    }

    function overlapScore(sentence, focusTerms) {
      var norm = normalize(sentence);
      var score = 0;
      for (var i = 0; i < focusTerms.length; i++) {
        if (norm.indexOf(focusTerms[i]) !== -1) score += focusTerms[i].length >= 4 ? 2 : 1;
      }
      return score;
    }

    function focusTerms(tok) {
      var terms = unique(tok.terms).filter(isDistinctLex);
      if (terms.length) return terms;
      return unique(tok.bigrams).filter(isDistinctBg).slice(0, 8);
    }

    function bestSentences(doc, focus) {
      var pool = doc.sentences.map(function (s, idx) {
        var norm = normalize(s);
        var terms = focus.filter(function (t) { return norm.indexOf(t) !== -1; });
        return { s: s, idx: idx, terms: terms, score: overlapScore(s, focus) };
      });
      var covered = Object.create(null);
      var picked = [];
      for (var n = 0; n < 2; n++) {
        var best = null;
        for (var i = 0; i < pool.length; i++) {
          var item = pool[i];
          if (picked.some(function (p) { return p.idx === item.idx; })) continue;
          var novel = item.terms.filter(function (t) { return !covered[t]; });
          var novelScore = 0;
          for (var k = 0; k < novel.length; k++) novelScore += novel[k].length >= 4 ? 2 : 1;
          if (novelScore <= 0) continue;
          if (!best || novelScore > best.novelScore || (novelScore === best.novelScore && item.score > best.item.score)) {
            best = { item: item, novelScore: novelScore };
          }
        }
        if (!best) break;
        picked.push(best.item);
        best.item.terms.forEach(function (t) { covered[t] = 1; });
      }
      picked.sort(function (a, b) { return a.idx - b.idx; });
      if (!picked.length && doc.sentences[0]) return [doc.sentences[0]];
      return picked.map(function (p) { return p.s; });
    }

    function coverage(doc, focus) {
      if (!focus.length || !doc.sentences.length) return 0;
      var best = 0;
      for (var i = 0; i < doc.sentences.length; i++) {
        var norm = normalize(doc.sentences[i]);
        var hit = 0;
        for (var j = 0; j < focus.length; j++) {
          if (norm.indexOf(focus[j]) !== -1) hit += 1;
        }
        best = Math.max(best, hit / focus.length);
      }
      return best;
    }

    function titleHit(title, focus) {
      if (!focus.length) return 0;
      var norm = normalize(title);
      var hit = 0;
      for (var i = 0; i < focus.length; i++) {
        if (norm.indexOf(focus[i]) !== -1) hit += 1;
      }
      return hit / focus.length;
    }

    function grounding(doc, tok) {
      var lexHits = unique(tok.terms).filter(function (t) {
        return doc.tokenSet[t] && isDistinctLex(t);
      });
      var bgHits = unique(tok.bigrams.concat(tok.numbers)).filter(function (t) {
        return doc.tokenSet[t] && isDistinctBg(t);
      });
      return { lexHits: lexHits, bgHits: bgHits };
    }

    function isGrounded(g) {
      return g.lexHits.length >= 1;
    }

    function prepare(query, memory) {
      var raw = String(query || "").trim();
      var own = tokenize(raw, lexicon);
      var follow = shouldFollow(raw, own, memory);
      var added = [];
      if (follow) {
        added = memory.terms.filter(function (t) { return normalize(raw).indexOf(t) === -1; }).slice(0, CONFIG.memoryTerms);
      }
      var retrievalText = added.length ? raw + " " + added.join(" ") : raw;
      var tok = tokenize(retrievalText, lexicon);
      return { raw: raw, retrievalText: retrievalText, isFollowup: follow, addedTerms: added, tok: tok };
    }

    function scoreAll(tok) {
      var qUnique = queryTokens(tok);
      var focus = focusTerms(tok);
      var rows = built.map(function (doc) {
        var rawScore = bm25(doc, qUnique);
        var g = grounding(doc, tok);
        return {
          id: doc.chunk.id,
          title: doc.chunk.title,
          source: doc.chunk.source,
          section: doc.chunk.section,
          category: doc.chunk.category,
          owner: doc.chunk.owner,
          updated: doc.chunk.updated,
          text: doc.chunk.text,
          bm25: rawScore,
          coverage: coverage(doc, focus),
          titleHit: titleHit(doc.chunk.title, focus),
          distinctive: g.lexHits.concat(g.bgHits),
          lexHits: g.lexHits,
          grounded: isGrounded(g),
          _doc: doc
        };
      });
      rows.forEach(function (row) {
        row.bm25Norm = row.bm25 > 0 ? row.bm25 / (row.bm25 + CONFIG.bm25Sat) : 0;
        row.rerank = CONFIG.rerankBm25 * row.bm25Norm + CONFIG.rerankCoverage * row.coverage + CONFIG.rerankTitle * row.titleHit;
      });
      rows.sort(function (a, b) {
        if (b.rerank !== a.rerank) return b.rerank - a.rerank;
        if (b.bm25 !== a.bm25) return b.bm25 - a.bm25;
        return a.id < b.id ? -1 : 1;
      });
      return { rows: rows, focus: focus };
    }

    function catalogSuggestions() {
      var prefer = ["合规红线", "审核流程", "案例复盘", "用户保护", "披露规范", "品牌安全"];
      var out = [];
      prefer.forEach(function (cat) {
        var hit = data.chunks.filter(function (c) { return c.category === cat; })[0];
        if (!hit) return;
        out.push({
          id: hit.id,
          title: hit.title,
          source: hit.source,
          category: hit.category,
          question: hit.title + "里规定了什么？",
          note: "目录建议 · " + cat
        });
      });
      return out.slice(0, 4);
    }

    function answer(opts) {
      var query = (opts && opts.query) || "";
      var memory = (opts && opts.memory) || null;
      var prep = prepare(query, memory);
      var intent = intentOf(prep.raw);
      var scored = scoreAll(prep.tok);
      var rows = scored.rows;
      var top = rows[0];
      var display = rows.slice(0, CONFIG.topK).map(function (row, idx) {
        return {
          rank: idx + 1,
          id: row.id,
          title: row.title,
          source: row.source,
          section: row.section,
          category: row.category,
          owner: row.owner,
          updated: row.updated,
          text: row.text,
          bm25: round(row.bm25),
          bm25Norm: round(row.bm25Norm),
          coverage: round(row.coverage),
          titleHit: round(row.titleHit),
          rerank: round(row.rerank),
          distinctive: row.distinctive.slice(0, 8),
          grounded: row.grounded,
          above: false,
          snippet: "",
          sentences: []
        };
      });

      var decision = "answer";
      var reason = "";
      var suggestions = [];
      if (!prep.raw) {
        decision = "refuse";
        reason = "还没有问题。";
      } else if (!top || top.bm25 <= 0 || !top.grounded) {
        decision = "refuse";
        reason = "查询和知识库没有共享的有效术语，所以不引用任何文档。";
        suggestions = catalogSuggestions();
      } else if (top.rerank < CONFIG.rerankFloor) {
        decision = "refuse";
        reason = "最接近的文档重排分为 " + round(top.rerank).toFixed(2) + "，低于引用阈值 " + CONFIG.rerankFloor.toFixed(2) + "，因此拒答。";
        suggestions = rows.slice(0, 3).map(function (row) {
          return {
            id: row.id,
            title: row.title,
            source: row.source,
            category: row.category,
            question: row.title + "里规定了什么？",
            note: "未达引用阈值 · 重排 " + round(row.rerank).toFixed(2)
          };
        });
      }

      var used = [];
      if (decision === "answer") {
        var ownFocus = focusTerms(tokenize(prep.raw, lexicon));
        function rareTerms(list, minLen) {
          return list.filter(function (t) {
            var dfi = df.get(t) || 0;
            return t.length >= minLen && dfi > 0 && dfi <= 2;
          });
        }
        var anchors = rareTerms(scored.focus, 3);
        if (!anchors.length) anchors = rareTerms(scored.focus, 2);
        used = rows.filter(function (row) {
          if (!row.grounded || row.rerank < CONFIG.rerankFloor) return false;
          if (row.rerank < top.rerank * CONFIG.relative) return false;
          if (row.id === top.id) return true;
          var hitAnchor = anchors.some(function (t) { return row.lexHits.indexOf(t) !== -1; });
          if (hitAnchor) return true;
          if (prep.isFollowup && ownFocus.some(function (t) { return row.lexHits.indexOf(t) !== -1; })) return true;
          return anchors.length === 0;
        }).slice(0, CONFIG.maxCites);
        if (!used.length) {
          decision = "refuse";
          reason = "没有文档同时越过绝对阈值和相对阈值。";
          suggestions = catalogSuggestions();
        }
      }

      var focus = scored.focus;
      var citations = used.map(function (row, i) {
        var sentences = bestSentences(row._doc, focus);
        return {
          n: i + 1,
          id: row.id,
          title: row.title,
          source: row.source,
          section: row.section,
          category: row.category,
          owner: row.owner,
          updated: row.updated,
          text: row.text,
          snippet: sentences[0] || row.text,
          sentences: sentences,
          rerank: round(row.rerank),
          bm25: round(row.bm25)
        };
      });

      var aboveIds = Object.create(null);
      citations.forEach(function (c) { aboveIds[c.id] = c.n; });
      display.forEach(function (row) {
        if (aboveIds[row.id]) {
          row.above = true;
          row.n = aboveIds[row.id];
          var cite = citations[aboveIds[row.id] - 1];
          row.snippet = cite.snippet;
          row.sentences = cite.sentences;
        } else {
          var src = rows.filter(function (r) { return r.id === row.id; })[0];
          var ss = src ? bestSentences(src._doc, focus) : [];
          row.snippet = ss[0] || "";
          row.sentences = ss;
        }
      });

      var flatSentences = [];
      citations.forEach(function (c) { c.sentences.forEach(function (s) { flatSentences.push(s); }); });
      var highlight = unique(focus).slice(0, 10);

      var memoryTerms = [];
      if (decision === "answer") {
        var bag = [];
        citations.forEach(function (c) {
          var row = rows.filter(function (r) { return r.id === c.id; })[0];
          if (row) bag = bag.concat(row.lexHits);
        });
        memoryTerms = unique(bag).sort(function (a, b) { return idf(b) - idf(a); }).slice(0, CONFIG.memoryTerms);
      }

      return {
        query: prep.raw,
        retrievalText: prep.retrievalText,
        isFollowup: prep.isFollowup,
        addedTerms: prep.addedTerms,
        intent: intent,
        tokens: {
          terms: unique(prep.tok.terms).slice(0, 16),
          bigrams: unique(prep.tok.bigrams).slice(0, 8),
          bigramCount: unique(prep.tok.bigrams).length,
          numbers: unique(prep.tok.numbers)
        },
        focus: highlight,
        candidates: display,
        decision: decision,
        reason: decision === "answer"
          ? "引用 " + citations.length + " 条。重排分需 ≥ " + CONFIG.rerankFloor.toFixed(2) + "，且 ≥ 第一名的 " + Math.round(CONFIG.relative * 100) + "%。除第一名外，还要命中问句里至少 3 个字、文档频率 ≤ 2 的词。"
          : reason,
        threshold: {
          floor: CONFIG.rerankFloor,
          relative: CONFIG.relative,
          topRerank: top ? round(top.rerank) : 0
        },
        citations: citations,
        lead: decision === "answer" ? leadFor(intent, flatSentences) : "",
        suggestions: suggestions,
        memoryTerms: memoryTerms,
        formula: "重排 = " + CONFIG.rerankBm25 + "×饱和 BM25 + " + CONFIG.rerankCoverage + "×句级覆盖 + " + CONFIG.rerankTitle + "×标题命中。饱和 BM25 = 原始分 / (原始分 + " + CONFIG.bm25Sat + ")，避免弱匹配被归一化成 1。这是可解释替身，不是交叉编码器。"
      };
    }

    function preview(query, memory) {
      var prep = prepare(query, memory);
      return {
        isFollowup: prep.isFollowup,
        addedTerms: prep.addedTerms,
        retrievalText: prep.retrievalText
      };
    }

    function runEval() {
      return (data.evalSet || []).map(function (item) {
        var result = answer({ query: item.question, memory: null });
        var topIds = result.candidates.slice(0, 3).map(function (c) { return c.id; });
        var cited = result.citations.map(function (c) { return c.id; });
        var expect = item.expect || [];
        var recall = expect.length ? expect.filter(function (id) { return topIds.indexOf(id) !== -1; }).length / expect.length : (result.decision === "refuse" ? 1 : 0);
        var citedCover = expect.length ? expect.filter(function (id) { return cited.indexOf(id) !== -1; }).length / expect.length : 0;
        var faithful = result.citations.every(function (c) {
          return result.candidates.some(function (row) { return row.id === c.id && row.above; });
        });
        var pass = false;
        if (item.mode === "refuse") pass = result.decision === "refuse" && cited.length === 0;
        else if (item.mode === "answer") pass = result.decision === "answer" && recall === 1 && citedCover === 1 && faithful;
        else pass = null;
        return {
          id: item.id,
          mode: item.mode,
          question: item.question,
          expect: expect,
          note: item.note || "",
          decision: result.decision,
          topIds: topIds,
          cited: cited,
          recall: recall,
          citedCover: citedCover,
          faithful: faithful,
          pass: pass,
          reason: result.reason
        };
      });
    }

    return {
      answer: answer,
      preview: preview,
      runEval: runEval,
      config: CONFIG,
      stats: { docs: N, terms: lexicon.length, avgdl: Math.round(avgdl) }
    };
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  return { create: create, CONFIG: CONFIG, normalize: normalize };
});
