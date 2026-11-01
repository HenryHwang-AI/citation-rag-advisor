/* Copy data/kb.json into js/kb.js so index.html works from file://. */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..");
var jsonPath = path.join(root, "data", "kb.json");
var outPath = path.join(root, "js", "kb.js");
var json = fs.readFileSync(jsonPath, "utf8");
JSON.parse(json);
var body = json.trim() + "\n";
var banner = "/* Synced from data/kb.json by scripts/sync-kb.js. Edit the JSON, then re-run the script. */\n";
fs.writeFileSync(outPath, banner + "window.ADVISOR_DATA = " + body + ";\n");
console.log("synced " + outPath);
