// Pull a named function or object-method body out of a source file by
// brace-matching, so tests exercise the SHIPPED code in extension/background.js
// rather than a copy that can drift out of sync with it.
//
// background.js is a service-worker script, not a module: it has no exports and
// its top level touches chrome.* immediately. Extracting the pieces under test
// and injecting their dependencies is what makes it testable in plain Node.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKGROUND = path.join(ROOT, "extension", "background.js");
export const BG_DIR = path.join(ROOT, "extension", "bg");

// background.js was split into extension/bg/*.js modules (#4). With no explicit
// file, search background.js first, then every bg/ module, and use the first
// file that contains the needle.
function locate(needle, file) {
  const files = file
    ? [file]
    : [BACKGROUND, ...fs.readdirSync(BG_DIR).filter((f) => f.endsWith(".js")).sort().map((f) => path.join(BG_DIR, f))];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (src.includes(needle)) return { src, file: f };
  }
  return { src: "", file: files.join(", ") };
}

function matchBraces(src, from) {
  let depth = 0;
  let i = src.indexOf("{", from);
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  throw new Error("unbalanced braces from index " + from);
}

/** Top-level `function foo(...) {...}` (keeps a leading `async`). */
export function extractFunction(name, file) {
  const { src, file: where } = locate(`function ${name}(`, file);
  let i = src.indexOf(`function ${name}(`);
  if (i === -1) throw new Error(`function ${name} not found in ${where}`);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  return src.slice(i, matchBraces(src, i));
}

/** Object method `async foo(args) {...}`, returned wrapped as `{ foo(){} }`. */
export function extractMethod(name, file) {
  const { src, file: where } = locate(`  async ${name}(args)`, file);
  const i = src.indexOf(`  async ${name}(args)`);
  if (i === -1) throw new Error(`method ${name} not found in ${where}`);
  return src.slice(i, matchBraces(src, i)).trim();
}

/** Build a callable from extracted source with dependencies injected. */
export function compile(source, deps, returnExpr) {
  const names = Object.keys(deps);
  const fn = new Function(...names, `${source}\nreturn ${returnExpr};`);
  return fn(...names.map((n) => deps[n]));
}
