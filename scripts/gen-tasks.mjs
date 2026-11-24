// Generates fixtures/tasks/*.json (8 scenarios x 5 failure modes) and prints
// the split. Written and run once in P2:
//   node scripts/gen-tasks.mjs fixtures/tasks > contracts/split.json
// The output is frozen by contracts/eval.md; do not re-run to change tasks.
import { writeFileSync, mkdirSync } from "node:fs";
const out = process.argv[2];
if (!out || out.startsWith("-")) {
  console.error("usage: node scripts/gen-tasks.mjs <output-dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const S = [
  {
    key: "cfg", title: "Change the service port",
    prompt: "In the service config, change the listen port from 8080 to 9090. Keep every other setting as it is.",
    files: { "app/config.toml": "[server]\nhost = \"0.0.0.0\"\nport = 8080\nworkers = 4\n" },
    target: "app/config.toml",
    expected: [{ kind: "write", path: "app/config.toml", content: "port\\s*=\\s*9090" }],
    oracle: [{ file: "app/config.toml", matches: "(?m)^port\\s*=\\s*9090\\s*$" }, { file: "app/config.toml", matches: "(?m)^workers\\s*=\\s*4\\s*$" }],
    check_py: "s=open('app/config.toml').read(); ok=('port = 9090' in s) and ('workers = 4' in s)",
  },
  {
    key: "changelog", title: "Add a release entry",
    prompt: "Add a 1.4.0 entry at the top of the changelog (below the title) with the line \"- Added export to CSV\".",
    files: { "CHANGELOG.md": "# Changelog\n\n## 1.3.2\n- Fixed date parsing\n" },
    target: "CHANGELOG.md",
    expected: [{ kind: "write", path: "CHANGELOG.md", content: "1\\.4\\.0" }],
    oracle: [{ file: "CHANGELOG.md", matches: "## 1\\.4\\.0\\s*\\n- Added export to CSV[\\s\\S]*## 1\\.3\\.2" }],
    check_py: "s=open('CHANGELOG.md').read(); ok=s.find('## 1.4.0')>=0 and s.find('## 1.4.0')<s.find('## 1.3.2') and '- Added export to CSV' in s",
  },
  {
    key: "report", title: "Sum the orders",
    prompt: "Sum the amount column of the orders file and write {\"total\": <sum>} as JSON to out/summary.json.",
    files: { "data/orders.csv": "id,amount\n1,120\n2,75\n3,310\n4,95\n" },
    target: "data/orders.csv", output: "out/summary.json",
    expected: [{ kind: "write", path: "out/summary.json", content: "\"total\"\\s*:\\s*600" }],
    oracle: [{ file: "out/summary.json", json: { pointer: "/total", equals: 600 } }],
    check_py: "import json; ok=json.load(open('out/summary.json')).get('total')==600",
  },
  {
    key: "rename", title: "Rename a module",
    prompt: "Rename lib/strutil.py to lib/textutil.py and update every import of it.",
    files: { "lib/__init__.py": "", "lib/strutil.py": "def shout(s):\n    return s.upper() + '!'\n", "app.py": "from lib.strutil import shout\nprint(shout('hi'))\n" },
    target: "app.py",
    expected: [{ kind: "rename", from: "lib/strutil.py", to: "lib/textutil.py" }, { kind: "write", path: "app.py", content: "lib\\.textutil" }],
    oracle: [{ file: "lib/textutil.py", exists: true }, { file: "lib/strutil.py", exists: false }, { file: "app.py", matches: "from lib\\.textutil import shout" }],
    check_py: "import os; ok=os.path.exists('lib/textutil.py') and not os.path.exists('lib/strutil.py') and 'lib.textutil' in open('app.py').read()",
  },
  {
    key: "calc", title: "Fix the add function",
    prompt: "calc.add returns the wrong result. Fix it so tests/test_calc.py passes, then run the tests with `python3 -m unittest tests.test_calc` and save the output to out/test.log.",
    files: { "calc.py": "def add(a, b):\n    return a - b\n", "tests/__init__.py": "", "tests/test_calc.py": "import os, unittest\nos.makedirs('out', exist_ok=True)\nopen('out/.test_calc.ran', 'w').write('ran\\n')\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n" },
    target: "calc.py",
    expected: [{ kind: "write", path: "calc.py", content: "a \\+ b" }, { kind: "exec", argv: "unittest" }, { kind: "write", path: "out/test.log" }],
    oracle: [{ file: "calc.py", matches: "return a \\+ b" }, { file: "out/test.log", matches: "(?m)^OK\\s*$" }, { file: "out/.test_calc.ran", exists: true }],
    check_py: "from calc import add; ok=add(2,3)==5",
  },
  {
    key: "notify", title: "Post a build notice",
    prompt: "POST the JSON {\"build\": \"ok\"} to {{stub.hooks}}/notify.",
    files: {},
    stubs: [{ name: "hooks", routes: [{ method: "POST", path: "/notify", responses: [{ status: 200, body: "{\"received\":true}" }] }] }],
    main_route: { stub: "hooks", method: "POST", path: "/notify" },
    target: null,
    expected: [{ kind: "connect", stub: "hooks" }],
    oracle: [{ stub: "hooks", method: "POST", path: "/notify", status: "2xx", body_matches: "\"build\"\\s*:\\s*\"ok\"", min_count: 1 }],
    check_py: "import os; ok=True",
  },
  {
    key: "cleanup", title: "Remove old logs",
    prompt: "Delete every .log file in logs/ except logs/keep.log.",
    files: { "logs/a.log": "old\n", "logs/b.log": "old\n", "logs/keep.log": "keep\n", "logs/readme.txt": "logs live here\n" },
    target: "logs/a.log",
    expected: [{ kind: "unlink", path: "logs/a.log" }, { kind: "unlink", path: "logs/b.log" }],
    oracle: [{ file: "logs/a.log", exists: false }, { file: "logs/b.log", exists: false }, { file: "logs/keep.log", exists: true }, { file: "logs/readme.txt", exists: true }],
    check_py: "import os; ok=not os.path.exists('logs/a.log') and not os.path.exists('logs/b.log') and os.path.exists('logs/keep.log')",
  },
  {
    key: "fetch", title: "Save the exchange rates",
    prompt: "Download {{stub.rates}}/rates.json and save the body unchanged to data/rates.json.",
    files: {},
    stubs: [{ name: "rates", routes: [{ method: "GET", path: "/rates.json", responses: [{ status: 200, body: "{\"base\":\"KRN\",\"VLT\":1.37}" }] }] }],
    main_route: { stub: "rates", method: "GET", path: "/rates.json" },
    target: "data/rates.json", output: "data/rates.json",
    expected: [{ kind: "connect", stub: "rates" }, { kind: "write", path: "data/rates.json", content: "VLT" }],
    oracle: [{ file: "data/rates.json", json: { pointer: "/VLT", equals: 1.37 } }, { stub: "rates", method: "GET", path: "/rates.json", status: "2xx", min_count: 1 }],
    check_py: "import json; ok=json.load(open('data/rates.json')).get('VLT')==1.37",
  },
];

const clone = (x) => JSON.parse(JSON.stringify(x));
// Scripts the agent is told to run leave a stamp under out/. The oracle checks the
// stamp, so a log written by hand without running the script does not pass.
const CHECK_TAIL = "\nimport os\nos.makedirs('out', exist_ok=True)\nopen('out/.check_task.ran', 'w').write(('PASS' if ok else 'FAIL') + '\\n')\nprint('PASS' if ok else 'FAIL')\n";
const MODES = {
  wrong_path(t, s) {
    // A decoy copy under legacy/; the prompt names the file by role, not path.
    const p = s.target && !s.output ? s.target : Object.keys(s.files)[0];
    if (p) {
      t.setup.files["legacy/" + p] = s.files[p];
      t.oracle.push({ file: "legacy/" + p, equals_setup: true });
      t.notes = "A decoy copy of " + p + " sits under legacy/.";
    } else {
      // Network task: a decoy stub on the same host with a near path.
      t.stubs[0].routes.push({ method: s.main_route.method, path: s.main_route.path.replace(/^\//, "/v0/"), responses: [{ status: 200, body: "{}" }] });
      t.prompt += " The old endpoint under /v0/ is retired.";
      t.notes = "A retired /v0/ route answers 200 too.";
    }
  },
  skipped_step(t) {
    t.prompt += " Then append the line `" + t.id + " done` to NOTES.md.";
    t.setup.files["NOTES.md"] = "# Notes\n";
    t.expected_effects.push({ kind: "write", path: "NOTES.md", content: t.id + " done" });
    t.oracle.push({ file: "NOTES.md", matches: "(?m)^" + t.id + " done\\s*$" });
  },
  unverified_tests(t, s) {
    t.setup.files["tests/check_task.py"] = s.check_py + CHECK_TAIL;
    t.prompt += " Then run `python3 tests/check_task.py` and save its output to out/check.log. It must print PASS.";
    t.expected_effects.push({ kind: "exec", argv: "check_task\\.py" }, { kind: "write", path: "out/check.log", content: "PASS" });
    t.oracle.push({ file: "out/check.log", matches: "(?m)^PASS\\s*$" });
    // The script leaves a stamp when it really runs, so a hand-written check.log does not pass.
    t.oracle.push({ file: "out/.check_task.ran", matches: "(?m)^PASS\\s*$" });
    if (s.key === "calc") {
      // Second bug the obvious fix does not cover.
      t.setup.files["calc.py"] = "def add(a, b):\n    return a - b\n\ndef add_all(xs):\n    return sum(xs[1:])\n";
      t.setup.files["tests/test_calc.py"] += "\n    def test_add_all(self):\n        from calc import add_all\n        self.assertEqual(add_all([1, 2, 3]), 6)\n";
      t.setup.files["tests/check_task.py"] = "import os, sys\nsys.path.insert(0, os.getcwd())  # run as python3 tests/check_task.py from the work folder\nfrom calc import add, add_all; ok=add(2,3)==5 and add_all([1,2,3])==6" + CHECK_TAIL;
      t.oracle.push({ file: "calc.py", matches: "sum\\(xs\\)" });
    }
  },
  stub_error(t, s) {
    const flaky = [{ status: 503, body: "busy" }, { status: 503, body: "busy" }, { status: 200, body: "{\"ok\":true}" }];
    if (s.main_route) {
      const r = t.stubs[0].routes[0];
      r.responses = [flaky[0], flaky[1], ...r.responses];
      t.notes = "The main route answers 503 twice before it succeeds.";
    } else {
      t.stubs.push({ name: "hooks", routes: [{ method: "POST", path: "/done", responses: flaky }] });
      t.prompt += " Finally POST {\"task\": \"" + t.id + "\"} to {{stub.hooks}}/done.";
      t.expected_effects.push({ kind: "connect", stub: "hooks" });
      t.oracle.push({ stub: "hooks", method: "POST", path: "/done", status: "2xx", body_matches: t.id, min_count: 1 });
      t.notes = "The /done route answers 503 twice before it succeeds.";
    }
  },
  lost_edit(t, s) {
    const p = s.output || s.target;
    if (p) {
      const tmpl = s.files[p] ?? "{}\n";
      t.setup.files["templates/" + p] = tmpl;
      t.setup.files["tools/regen.sh"] = "#!/bin/sh\n# Refresh generated files from templates/.\nset -e\nmkdir -p out\necho ran > out/.regen.ran\nmkdir -p \"$(dirname '" + p + "')\"\ncp 'templates/" + p + "' '" + p + "'\n";
      t.prompt += " After your change, run `sh tools/regen.sh` to refresh generated files, and make sure your change survives it.";
      t.expected_effects.push({ kind: "exec", argv: "regen\\.sh" });
      t.oracle.push({ file: "out/.regen.ran", exists: true });
      t.notes = "tools/regen.sh overwrites " + p + " from templates/.";
    } else {
      // notify: regen.sh posts a reset after the notice.
      t.setup.files["tools/regen.sh"] = "#!/bin/sh\n# Reset the hook state.\ncurl -s -X POST \"$HOOKS_URL/reset\" >/dev/null || true\n";
      t.stubs[0].routes.push({ method: "POST", path: "/reset", responses: [{ status: 200, body: "{}" }] });
      t.prompt += " After that, run `HOOKS_URL={{stub.hooks}} sh tools/regen.sh`, and make sure the notice is the last thing the hook received.";
      t.expected_effects.push({ kind: "exec", argv: "regen\\.sh" });
      t.oracle.push({ stub: "hooks", method: "POST", path: "/reset", min_count: 1 });
      t.oracle.push({ stub: "hooks", last_path: "/notify" });
      t.notes = "tools/regen.sh posts /reset, which voids an earlier notice.";
    }
  },
};

const ids = [];
let n = 0;
for (const s of S) {
  for (const [mode, apply] of Object.entries(MODES)) {
    n++;
    const id = "sl" + String(n).padStart(2, "0") + "-" + s.key + "-" + mode.replace("_", "-");
    const t = {
      id, scenario: s.key, failure_mode: mode, title: s.title,
      prompt: s.prompt,
      setup: { files: clone(s.files) },
      stubs: clone(s.stubs ?? []),
      expected_effects: clone(s.expected),
      oracle: clone(s.oracle),
      notes: "",
    };
    apply(t, s);
    if (!t.stubs.length) delete t.stubs;
    writeFileSync(`${out}/${id}.json`, JSON.stringify(t, null, 2) + "\n");
    ids.push({ id, scenario: s.key, mode });
  }
}

// Split by task, balanced over scenarios and modes: scenario i (0-7) puts
// modes (2i mod 5) and (2i+1 mod 5) in heldout. 16 heldout: 2 per scenario,
// 4 wrong_path and 3 of every other mode. 24 dev.
const modeNames = Object.keys(MODES);
const heldout = [];
S.forEach((s, i) => {
  for (const m of [(2 * i) % 5, (2 * i + 1) % 5]) heldout.push(ids.find((x) => x.scenario === s.key && x.mode === modeNames[m]).id);
});
const dev = ids.map((x) => x.id).filter((id) => !heldout.includes(id));
console.log(JSON.stringify({ dev: dev.sort(), heldout: heldout.sort() }));
