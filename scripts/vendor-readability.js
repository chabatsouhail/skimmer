"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packageRoot = path.dirname(
  require.resolve("@mozilla/readability/package.json")
);
const sourceScript = path.join(packageRoot, "Readability.js");
const sourceLicense = path.join(packageRoot, "LICENSE.md");
const vendorDirectory = path.join(projectRoot, "vendor");
const targetScript = path.join(vendorDirectory, "readability.js");
const targetLicense = path.join(vendorDirectory, "LICENSE.readability.md");

fs.mkdirSync(vendorDirectory, { recursive: true });
fs.copyFileSync(sourceScript, targetScript);
fs.copyFileSync(sourceLicense, targetLicense);

console.log(`Vendored ${targetScript}`);
console.log(`Vendored ${targetLicense}`);
