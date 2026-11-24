"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.argv[2]) || 4173;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};

function send(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/" || requestUrl.pathname === "/popup.html") {
    const popup = fs.readFileSync(path.join(projectRoot, "popup.html"), "utf8");
    const preview = popup.replace(
      '<script src="popup.js"></script>',
      '<script src="scripts/preview-mock.js"></script>\n' +
      '  <script src="popup.js"></script>'
    );
    send(response, 200, preview, mimeTypes[".html"]);
    return;
  }

  const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
  const target = path.resolve(projectRoot, relative);
  const safePrefix = `${projectRoot}${path.sep}`;
  if (!target.startsWith(safePrefix) || !fs.existsSync(target)) {
    send(response, 404, "Not found", mimeTypes[".txt"]);
    return;
  }

  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    send(response, 404, "Not found", mimeTypes[".txt"]);
    return;
  }
  send(
    response,
    200,
    fs.readFileSync(target),
    mimeTypes[path.extname(target).toLocaleLowerCase("en")] ||
      "application/octet-stream"
  );
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Skimmer preview: http://127.0.0.1:${port}/`);
});
