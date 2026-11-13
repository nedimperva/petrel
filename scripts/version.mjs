// Sets Petrel's version everywhere it is written, so a release tag and the app agree:
//   node scripts/version.mjs 0.2.0
// tauri.conf.json (what the updater compares), package.json and package-lock.json, and the Cargo workspace
// (Cargo.lock follows on the next build). Then: commit, `git tag v0.2.0`, push the tag; .github/workflows/release.yml
// builds and publishes it.

import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2]?.replace(/^v/, "");
if (!v || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
  console.error("usage: node scripts/version.mjs 1.2.3");
  process.exit(1);
}

const json = (path, set) => {
  const data = JSON.parse(readFileSync(path, "utf8"));
  set(data);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

json("src-tauri/tauri.conf.json", (d) => (d.version = v));
json("package.json", (d) => (d.version = v));
json("package-lock.json", (d) => {
  d.version = v;
  if (d.packages?.[""]) d.packages[""].version = v;
});

const cargo = readFileSync("Cargo.toml", "utf8");
const next = cargo.replace(/(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${v}$2`);
if (next === cargo && !cargo.includes(`version = "${v}"`)) {
  console.error("Cargo.toml: no [workspace.package] version found");
  process.exit(1);
}
writeFileSync("Cargo.toml", next);

console.log(`Petrel ${v}: tauri.conf.json, package.json, package-lock.json, Cargo.toml.`);
console.log(`Next: git commit -am "Petrel ${v}" && git tag v${v} && git push && git push origin v${v}`);
