#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function usage() {
  console.error("Usage: node tools/build-vsix.js <extension-dir> [output.vsix]");
  process.exit(1);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    mkdirp(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function xmlEscape(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildVsixManifest(pkg) {
  const publisher = pkg.publisher || "local";
  const name = pkg.name || "extension";
  const displayName = pkg.displayName || name;
  const description = pkg.description || displayName;
  const version = pkg.version || "0.0.0";
  const engine = (pkg.engines && pkg.engines.vscode) || "*";

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(publisher)}.${xmlEscape(name)}" Version="${xmlEscape(version)}" Publisher="${xmlEscape(publisher)}" />
    <DisplayName>${xmlEscape(displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(description)}</Description>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="${xmlEscape(engine)}" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function buildContentTypesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="map" ContentType="application/json" />
  <Default Extension="xml" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
`;
}

function main() {
  const extensionDirArg = process.argv[2];
  if (!extensionDirArg) usage();

  const extensionDir = path.resolve(extensionDirArg);
  const pkgPath = path.join(extensionDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found: ${pkgPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const defaultOutput = path.resolve(
    process.argv[3] || path.join("dist", `${pkg.name || "extension"}-${pkg.version || "0.0.0"}.vsix`)
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-vsix-"));
  const staging = path.join(tempRoot, "staging");
  const extensionStaging = path.join(staging, "extension");

  mkdirp(extensionStaging);
  copyRecursive(extensionDir, extensionStaging);
  fs.writeFileSync(path.join(staging, "extension.vsixmanifest"), buildVsixManifest(pkg), "utf8");
  fs.writeFileSync(path.join(staging, "[Content_Types].xml"), buildContentTypesXml(), "utf8");
  mkdirp(path.dirname(defaultOutput));
  rmrf(defaultOutput);

  execFileSync("zip", ["-qr", defaultOutput, "."], { cwd: staging, stdio: "inherit" });
  rmrf(tempRoot);
  console.log(defaultOutput);
}

try {
  main();
} catch (err) {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}
