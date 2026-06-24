import express from "express";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 8080);
const distDir = path.join(__dirname, "dist");
const artifactRoot = path.join(os.tmpdir(), "apk-forge-artifacts");

const WEB_BUILD_OUTPUT_DIRS = ["dist", "build", "out", "public"];
const DEFAULT_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;
const BUILD_HEARTBEAT_MS = 30 * 1000;

await fs.mkdir(artifactRoot, { recursive: true });

app.use(express.json({ limit: "1mb" }));

const jobs = new Map();

function scrubAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "\n");
}

function pushLog(job, message) {
  const clean = scrubAnsi(message).trim();
  if (!clean) {
    return;
  }

  job.logs.push(clean);
  if (job.logs.length > 240) {
    job.logs.splice(0, job.logs.length - 240);
  }

  job.updatedAt = new Date().toISOString();
}

function setJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    repoUrl: job.repoUrl,
    branch: job.branch,
    privateRepo: job.privateRepo,
    logs: job.logs,
    artifactName: job.artifactName,
    downloadUrl: job.downloadUrl,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

function parseGitHubRepo(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("A GitHub repository URL is required.");
  }

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const normalized = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Paste a valid GitHub URL, for example https://github.com/owner/repo.");
  }

  if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) {
    throw new Error("Only GitHub repositories are supported.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("The repository URL must include an owner and a repo name.");
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  return { owner, repo };
}

function buildCloneUrl(repoUrl, token) {
  const { owner, repo } = parseGitHubRepo(repoUrl);
  if (token) {
    const encoded = encodeURIComponent(token);
    return `https://x-access-token:${encoded}@github.com/${owner}/${repo}.git`;
  }

  return `https://github.com/${owner}/${repo}.git`;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findAndroidRoot(startDir) {
  const queue = [{ dir: startDir, depth: 0 }];
  const ignored = new Set([".git", "node_modules", "build", "dist", ".gradle"]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const names = new Set(entries.map((entry) => entry.name));
    const isCandidate = (names.has("settings.gradle") || names.has("settings.gradle.kts")) && (names.has("build.gradle") || names.has("build.gradle.kts"));
    if (isCandidate) {
      return current.dir;
    }

    if (current.depth >= 3) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !ignored.has(entry.name)) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return null;
}

async function findWebRoot(startDir) {
  const queue = [{ dir: startDir, depth: 0 }];
  const ignored = new Set([".git", "node_modules", "build", "dist", ".gradle", "android", "ios"]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("package.json") || names.has("index.html")) {
      return current.dir;
    }

    if (current.depth >= 3) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !ignored.has(entry.name)) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return null;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function detectWebOutput(webRoot) {
  for (const outputDir of WEB_BUILD_OUTPUT_DIRS) {
    const candidate = path.join(webRoot, outputDir);
    if (await pathExists(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  if (await pathExists(path.join(webRoot, "index.html"))) {
    return webRoot;
  }

  return null;
}

async function prepareWebAssets(webRoot, workspace, job) {
  const packageJsonPath = path.join(webRoot, "package.json");
  if (await pathExists(packageJsonPath)) {
    const packageJson = await readJson(packageJsonPath);
    if (await pathExists(path.join(webRoot, "package-lock.json"))) {
      pushLog(job, "Installing web dependencies with npm ci.");
      await runCommand("npm", ["ci"], { cwd: webRoot }, job);
    } else {
      pushLog(job, "Installing web dependencies with npm install.");
      await runCommand("npm", ["install"], { cwd: webRoot }, job);
    }

    if (packageJson.scripts?.build) {
      pushLog(job, "Building web application with npm run build.");
      await runCommand("npm", ["run", "build"], { cwd: webRoot }, job);
    } else {
      pushLog(job, "No build script found; packaging existing static web files.");
    }
  }

  const webOutput = await detectWebOutput(webRoot);
  if (!webOutput) {
    throw new Error("No Android project or packageable web entrypoint was found. Add Gradle files, package.json, or index.html.");
  }

  const assetsDir = path.join(workspace, "generated-android", "app", "src", "main", "assets", "www");
  await copyDirectory(webOutput, assetsDir);
  return path.join(workspace, "generated-android");
}

function escapeXmlAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function writeGeneratedAndroidProject(androidRoot, appName) {
  const safeName = appName.replace(/[^A-Za-z0-9 _-]/g, " ").trim() || "APK Forge App";
  const label = escapeXmlAttribute(safeName);
  const files = new Map([
    ["settings.gradle", `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = '${safeName.replace(/'/g, "")}Android'\ninclude ':app'\n`],
    ["build.gradle", "plugins {\n    id 'com.android.application' version '8.5.2' apply false\n}\n"],
    ["app/build.gradle", "plugins { id 'com.android.application' }\n\nandroid {\n    namespace 'com.apkforge.generated'\n    compileSdk 34\n\n    defaultConfig {\n        applicationId 'com.apkforge.generated'\n        minSdk 23\n        targetSdk 34\n        versionCode 1\n        versionName '1.0'\n    }\n}\n"],
    ["app/src/main/AndroidManifest.xml", `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:theme="@style/AppTheme" android:label="${label}">\n        <activity android:name=".MainActivity" android:exported="true">\n            <intent-filter>\n                <action android:name="android.intent.action.MAIN" />\n                <category android:name="android.intent.category.LAUNCHER" />\n            </intent-filter>\n        </activity>\n    </application>\n</manifest>\n`],
    ["app/src/main/res/values/styles.xml", "<resources>\n    <style name=\"AppTheme\" parent=\"android:style/Theme.Material.Light.NoActionBar\">\n        <item name=\"android:windowLightStatusBar\">true</item>\n    </style>\n</resources>\n"],
    ["app/src/main/java/com/apkforge/generated/MainActivity.java", "package com.apkforge.generated;\n\nimport android.app.Activity;\nimport android.os.Bundle;\nimport android.webkit.WebSettings;\nimport android.webkit.WebView;\n\npublic class MainActivity extends Activity {\n    @Override\n    protected void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        WebView webView = new WebView(this);\n        WebSettings settings = webView.getSettings();\n        settings.setJavaScriptEnabled(true);\n        settings.setDomStorageEnabled(true);\n        settings.setAllowFileAccess(true);\n        setContentView(webView);\n        webView.loadUrl(\"file:///android_asset/www/index.html\");\n    }\n}\n"],
  ]);

  for (const [relativePath, contents] of files) {
    const target = path.join(androidRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

async function buildGeneratedAndroidProject(repoDir, workspace, job) {
  const webRoot = await findWebRoot(repoDir);
  if (!webRoot) {
    throw new Error("No Android project or web app was found. Add Gradle files, package.json, or index.html.");
  }

  pushLog(job, `Web project detected at ${path.relative(repoDir, webRoot) || "."}`);
  const androidRoot = await prepareWebAssets(webRoot, workspace, job);
  let appName = path.basename(repoDir);
  if (await pathExists(path.join(webRoot, "package.json"))) {
    const packageJson = await readJson(path.join(webRoot, "package.json")).catch(() => null);
    appName = packageJson?.name || appName;
  }

  await writeGeneratedAndroidProject(androidRoot, appName);
  return androidRoot;
}

async function resolveGradleCommand(androidRoot) {
  const gradlew = path.join(androidRoot, "gradlew");
  if (await pathExists(gradlew)) {
    await fs.chmod(gradlew, 0o755);
    return { command: "./gradlew", argsPrefix: ["--no-daemon"] };
  }

  const pluginVersion = await detectAndroidGradlePluginVersion(androidRoot);
  if (compareMajor(pluginVersion, 9) && (await pathExists("/opt/gradle-9.1.0/bin/gradle"))) {
    return { command: "/opt/gradle-9.1.0/bin/gradle", argsPrefix: ["--no-daemon"] };
  }

  if (await pathExists("/opt/gradle-8.7/bin/gradle")) {
    return { command: "/opt/gradle-8.7/bin/gradle", argsPrefix: ["--no-daemon"] };
  }

  return { command: "gradle", argsPrefix: ["--no-daemon"] };
}

async function findLatestApk(rootDir) {
  const apkFiles = [];

  async function walk(directory, depth = 0) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const nextPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 5) {
          await walk(nextPath, depth + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith(".apk")) {
        const stats = await fs.stat(nextPath);
        apkFiles.push({ path: nextPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  await walk(rootDir);
  apkFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return apkFiles[0]?.path || null;
}

function attachStreamLogger(stream, job) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      pushLog(job, line);
    }
  });

  stream.on("end", () => {
    if (buffer.trim()) {
      pushLog(job, buffer);
    }
  });
}

function runCommand(command, args, options, job) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastOutputAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const markOutput = () => {
      lastOutputAt = Date.now();
    };
    child.stdout.on("data", markOutput);
    child.stderr.on("data", markOutput);
    attachStreamLogger(child.stdout, job);
    attachStreamLogger(child.stderr, job);

    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const timeout = windowlessSetTimeout(() => {
      if (settled) {
        return;
      }

      pushLog(job, `${command} exceeded ${Math.round(timeoutMs / 60000)} minutes and was stopped.`);
      child.kill("SIGTERM");
      windowlessSetTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    const heartbeat = windowlessSetInterval(() => {
      const quietForSeconds = Math.round((Date.now() - lastOutputAt) / 1000);
      pushLog(job, `${command} is still running; no output for ${quietForSeconds}s.`);
    }, BUILD_HEARTBEAT_MS);

    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      reject(error);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const windowlessSetTimeout = globalThis.setTimeout;
const windowlessSetInterval = globalThis.setInterval;

async function cleanupDirectory(directory) {
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function detectAndroidGradlePluginVersion(androidRoot) {
  const buildFiles = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
  for (const buildFile of buildFiles) {
    const contents = await readTextIfExists(path.join(androidRoot, buildFile));
    const match = contents.match(/com\.android(?:\.application|\.library|\.test)?[^\n\r]*version[ '\"]+([0-9]+(?:\.[0-9]+){1,2})/) || contents.match(/com\.android\.tools\.build:gradle:\$?\{?([0-9]+(?:\.[0-9]+){1,2})/) || contents.match(/android_plugin_version\s*=\s*['\"]([0-9]+(?:\.[0-9]+){1,2})/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function compareMajor(version, major) {
  return Number.parseInt(String(version || "0").split(".")[0] || "0", 10) >= major;
}

async function writeLocalProperties(androidRoot) {
  const lines = [];
  if (process.env.ANDROID_SDK_ROOT) {
    lines.push(`sdk.dir=${process.env.ANDROID_SDK_ROOT}`);
  }

  if (process.env.ANDROID_NDK_HOME) {
    lines.push(`ndk.dir=${process.env.ANDROID_NDK_HOME}`);
    lines.push(`android.ndkPath=${process.env.ANDROID_NDK_HOME}`);
  }

  if (process.env.ANDROID_NDK_VERSION) {
    lines.push(`android.ndkFullVersion=${process.env.ANDROID_NDK_VERSION}`);
  }

  if (lines.length > 0) {
    await fs.writeFile(path.join(androidRoot, "local.properties"), `${lines.join("\n")}\n`);
  }
}

async function runBuild(job) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "apk-forge-"));
  const repoDir = path.join(workspace, "repo");

  try {
    setJob(job, { status: "cloning", stage: "Cloning repository", progress: 18 });
    pushLog(job, "Cloning GitHub repository into an isolated workspace.");

    const cloneUrl = buildCloneUrl(job.repoUrl, job.token || "");
    const cloneArgs = ["clone", "--depth", "1", "--recurse-submodules", "--shallow-submodules"];
    if (job.branch) {
      cloneArgs.push("--branch", job.branch);
    }
    cloneArgs.push(cloneUrl, repoDir);

    await runCommand("git", cloneArgs, { cwd: workspace }, job);

    setJob(job, { status: "analyzing", stage: "Inspecting repository structure", progress: 36 });
    pushLog(job, "Searching for an Android project root or packageable web app.");

    let androidRoot = await findAndroidRoot(repoDir);
    if (androidRoot) {
      pushLog(job, `Android root detected at ${path.relative(repoDir, androidRoot) || "."}`);
    } else {
      pushLog(job, "No Gradle Android project found. Trying web-to-APK packaging fallback.");
      androidRoot = await buildGeneratedAndroidProject(repoDir, workspace, job);
      pushLog(job, "Generated a minimal Android WebView wrapper for the web app.");
    }

    await writeLocalProperties(androidRoot);
    const gradleCommand = await resolveGradleCommand(androidRoot);

    setJob(job, { status: "building", stage: "Running Android build", progress: 68 });
    pushLog(job, `Executing ${gradleCommand.command} assembleDebug to generate the APK artifact.`);

    const gradleEnv = {
      ANDROID_HOME: process.env.ANDROID_SDK_ROOT,
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
      ANDROID_NDK_HOME: process.env.ANDROID_NDK_HOME,
      ANDROID_NDK_ROOT: process.env.ANDROID_NDK_HOME,
      GRADLE_USER_HOME: path.join(workspace, ".gradle"),
    };
    if (process.env.JAVA_HOME) {
      gradleEnv.JAVA_HOME = process.env.JAVA_HOME;
    }

    await runCommand(gradleCommand.command, [...gradleCommand.argsPrefix, "assembleDebug", "-x", "test", "-x", "lint"], { cwd: androidRoot, env: gradleEnv }, job);

    setJob(job, { status: "packaging", stage: "Packaging APK artifact", progress: 90 });
    pushLog(job, "Build finished. Locating the newest APK output.");

    const apkPath = await findLatestApk(androidRoot);
    if (!apkPath) {
      throw new Error("The build completed, but no APK output was found in the Gradle build folders.");
    }

    const artifactName = `${job.id}-${path.basename(apkPath)}`;
    const targetPath = path.join(artifactRoot, artifactName);
    await fs.copyFile(apkPath, targetPath);

    setJob(job, {
      status: "completed",
      stage: "APK ready",
      progress: 100,
      artifactName,
      downloadUrl: `/api/build/${job.id}/download`,
      updatedAt: new Date().toISOString(),
    });
    pushLog(job, `APK is ready: ${artifactName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The build worker failed unexpectedly.";
    setJob(job, { status: "failed", stage: "Build failed", progress: 100, error: message });
    pushLog(job, message);
  } finally {
    await cleanupDirectory(workspace);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "apk-forge" });
});

app.post("/api/build", async (req, res) => {
  const repoUrl = String(req.body?.repoUrl || "").trim();
  const branch = String(req.body?.branch || "main").trim() || "main";
  const token = String(req.body?.token || "").trim();

  try {
    parseGitHubRepo(repoUrl);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid repository URL." });
    return;
  }

  const job = {
    id: randomUUID(),
    status: "queued",
    stage: "Queued",
    progress: 8,
    repoUrl,
    branch,
    token,
    privateRepo: Boolean(token),
    logs: ["Build queued."],
    updatedAt: new Date().toISOString(),
  };

  jobs.set(job.id, job);
  res.json({ jobId: job.id });

  void runBuild(job).finally(() => {
    delete job.token;
  });
});

app.get("/api/build/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Build job not found." });
    return;
  }

  res.json(publicJob(job));
});

app.get("/api/build/:id/download", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Build job not found." });
    return;
  }

  if (job.status !== "completed" || !job.artifactName) {
    res.status(409).json({ error: "The APK is not ready yet." });
    return;
  }

  const filePath = path.join(artifactRoot, job.artifactName);
  if (!fsSync.existsSync(filePath)) {
    res.status(404).json({ error: "The APK artifact is no longer available." });
    return;
  }

  res.download(filePath, job.artifactName);
});

app.use(express.static(distDir));

app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`APK Forge listening on port ${port}`);
});