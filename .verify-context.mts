import { resolvePath, resolveRemotePath } from "./src/modules/ai/tools/context.ts";

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function throws(fn, re, label) {
  try {
    fn();
    fail++;
    console.log(`FAIL ${label}: did not throw`);
  } catch (e) {
    if (re.test(String(e))) pass++;
    else {
      fail++;
      console.log(`FAIL ${label}: wrong error ${e}`);
    }
  }
}

// resolveRemotePath
eq(resolveRemotePath("src/main.ts", "/root/app"), "/root/app/src/main.ts", "relative vs cwd");
eq(resolveRemotePath("config.yaml", "/root/app/"), "/root/app/config.yaml", "no double slash");
eq(resolveRemotePath("/var/www", "/root"), "/var/www", "absolute passthrough");
eq(resolveRemotePath("/", "/root"), "/", "root passthrough");
eq(resolveRemotePath("C:\\Users\\me\\file.txt", "/root"), null, "win backslash stays local");
eq(resolveRemotePath("C:/Users/me/file.txt", "/root"), null, "win fwd stays local");
throws(() => resolveRemotePath("src/main.ts", null), /no remote cwd yet/, "relative without cwd throws");

// resolvePath unchanged
eq(resolvePath("src\\main.ts", "C:\\project"), "C:\\project\\src\\main.ts", "resolvePath win");
eq(resolvePath("src/main.ts", "/root"), "/root/src/main.ts", "resolvePath posix");
eq(resolvePath("C:/x/y", "/root"), "C:/x/y", "resolvePath absolute win passthrough");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
