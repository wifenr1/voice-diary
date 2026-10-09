// Builds the home-screen app from index.html, the same page that runs inside Claude.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";

const page = readFileSync("index.html", "utf8");
const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#4249d6">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Diary">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" href="icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
`;
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
writeFileSync("dist/index.html", head + page + "\n</body>\n</html>\n");
console.log("Built dist/index.html");
