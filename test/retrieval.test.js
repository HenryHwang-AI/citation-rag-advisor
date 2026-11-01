/* Retrieval contract for the offline citation advisor. Run: node test/retrieval.test.js */
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var assert = require("assert");

var root = path.join(__dirname, "..");
var data = JSON.parse(fs.readFileSync(path.join(root, "data", "kb.json"), "utf8"));
var kbJs = fs.readFileSync(path.join(root, "js", "kb.js"), "utf8");
var sandbox = { window: {} };
vm.runInNewContext(kbJs, sandbox);
assert.equal(
  JSON.stringify(sandbox.window.ADVISOR_DATA),
  JSON.stringify(data),
  "js/kb.js drifted from data/kb.json"
);

data.chunks.forEach(function (chunk) {
  assert.ok(chunk.text.length >= 80, chunk.id + " text too short");
  assert.ok(chunk.text.indexOf("广告") !== -1, chunk.id + " should mention 广告");
  sentences(chunk.text).forEach(function (s) {
    assert.equal(s, s.trim());
  });
});
assert.equal(data.chunks.length >= 8 && data.chunks.length <= 12, true);
assert.equal(data.starters.length, 3);

var engine = require(path.join(root, "js", "engine.js")).create(data);
var report = engine.runEval();
var scored = report.filter(function (row) { return row.mode !== "gap"; });
var failed = scored.filter(function (row) { return row.pass !== true; });

console.log("docs", engine.stats.docs, "lexicon", engine.stats.terms, "avgdl", engine.stats.avgdl);
console.log("--- eval ---");
report.forEach(function (row) {
  var mark = row.mode === "gap" ? "GAP" : row.pass ? "PASS" : "FAIL";
  console.log(
    mark,
    row.id,
    row.mode,
    "decision=" + row.decision,
    "top=" + row.topIds.join(","),
    "cited=" + row.cited.join(","),
    "recall=" + row.recall.toFixed(2)
  );
});

assert.equal(failed.length, 0, "eval failures:\n" + failed.map(function (row) {
  return row.id + " " + row.question + "\n  expect " + row.expect.join(",") + "\n  top " + row.topIds.join(",") + "\n  cited " + row.cited.join(",") + "\n  " + row.reason;
}).join("\n"));

var answers = scored.filter(function (row) { return row.mode === "answer"; });
var refuses = scored.filter(function (row) { return row.mode === "refuse"; });
var recall = answers.reduce(function (s, row) { return s + row.recall; }, 0) / answers.length;
var refuseAcc = refuses.filter(function (row) { return row.pass; }).length / refuses.length;
assert.ok(recall >= 0.85, "Recall@3 " + recall);
assert.equal(refuseAcc, 1);

data.starters.forEach(function (starter) {
  var result = engine.answer({ query: starter.question, memory: null });
  assert.equal(result.decision, "answer", starter.id + " should answer");
  assert.ok(result.citations.length >= 1, starter.id + " needs citations");
  result.citations.forEach(function (cite) {
    cite.sentences.forEach(function (s) {
      assert.ok(cite.text.indexOf(s) !== -1, "sentence not in source " + cite.id);
    });
  });
  console.log("STARTER", starter.id, "cites", result.citations.map(function (c) { return c.n + ":" + c.id; }).join(" "), "rerank", result.citations.map(function (c) { return c.rerank; }).join(","));
});

var first = engine.answer({ query: data.starters[0].question, memory: null });
assert.ok(first.citations.some(function (c) { return c.id === "ad-abs-001"; }));
assert.ok(first.citations.some(function (c) { return c.id === "ad-sop-004"; }));
var memory = { query: data.starters[0].question, terms: first.memoryTerms };
var follow = engine.answer({ query: "再展开具体的审核步骤", memory: memory });
assert.equal(follow.isFollowup, true, "ellipsis should rewrite");
assert.equal(follow.decision, "answer");
console.log("FOLLOW", follow.addedTerms.join(" | "), "cites", follow.citations.map(function (c) { return c.id; }).join(","));

var shift = engine.answer({ query: "那落地页价格和素材不一致呢", memory: memory });
assert.equal(shift.isFollowup, false, "new topic should not inherit terms: " + shift.addedTerms.join(","));
assert.ok(shift.citations.some(function (c) { return c.id === "ad-lp-005"; }), "landing page shift");

var ood = engine.answer({ query: "家用核聚变反应堆的广告转化文案怎么写更有冲击力？", memory: memory });
assert.equal(ood.isFollowup, false);
assert.equal(ood.decision, "refuse");
assert.equal(ood.citations.length, 0);

var pronoun = engine.answer({
  query: "它和直播口播一样吗",
  memory: { query: data.starters[1].question, terms: engine.answer({ query: data.starters[1].question, memory: null }).memoryTerms }
});
assert.equal(pronoun.isFollowup, true);
assert.equal(pronoun.decision, "answer");
console.log("PRONOUN cites", pronoun.citations.map(function (c) { return c.id; }).join(","));

function citedIds(id) {
  var item = data.evalSet.filter(function (row) { return row.id === id; })[0];
  return engine.answer({ query: item.question, memory: null }).citations.map(function (c) { return c.id; });
}
assert.deepStrictEqual(citedIds("e4"), ["ad-lp-005"]);
assert.ok(citedIds("e5").indexOf("ad-fin-003") === -1, "minor question should not cite finance boilerplate");
assert.deepStrictEqual(citedIds("e12").length, 0);

console.log("recall@3", recall.toFixed(2), "refuseAcc", refuseAcc.toFixed(2));
console.log("ok");

function sentences(text) {
  return text.split(/[。！？]/).map(function (s) { return s.trim(); }).filter(Boolean);
}
