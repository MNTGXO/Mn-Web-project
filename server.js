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
    const isCandidate = names.has("gradlew") && (names.has("settings.gradle") || names.has("settings.gradle.kts"));
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    attachStreamLogger(child.stdout, job);
    attachStreamLogger(child.stderr, job);

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function cleanupDirectory(directory) {
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

async function runBuild(job) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "apk-forge-"));
  const repoDir = path.join(workspace, "repo");

  try {
    setJob(job, { status: "cloning", stage: "Cloning repository", progress: 18 });
    pushLog(job, "Cloning GitHub repository into an isolated workspace.");

    const cloneUrl = buildCloneUrl(job.repoUrl, job.token || "");
    const cloneArgs = ["clone", "--depth", "1"];
    if (job.branch) {
      cloneArgs.push("--branch", job.branch);
    }
    cloneArgs.push(cloneUrl, repoDir);

    await runCommand("git", cloneArgs, { cwd: workspace }, job);

    setJob(job, { status: "analyzing", stage: "Inspecting Android structure", progress: 36 });
    pushLog(job, "Searching for the Android project root and Gradle wrapper.");

    const androidRoot = await findAndroidRoot(repoDir);
    if (!androidRoot) {
      throw new Error("No Android project was found. The repository needs a Gradle Android app or module.");
    }

    pushLog(job, `Android root detected at ${path.relative(repoDir, androidRoot) || "."}`);

    const gradlew = path.join(androidRoot, "gradlew");
    if (!(await pathExists(gradlew))) {
      throw new Error("The repository is missing gradlew. Add the Gradle wrapper for reliable APK builds.");
    }

    await fs.chmod(gradlew, 0o755);

    setJob(job, { status: "building", stage: "Running Gradle build", progress: 68 });
    pushLog(job, "Executing ./gradlew assembleDebug to generate the APK artifact.");

    const gradleEnv = {
      GRADLE_USER_HOME: path.join(workspace, ".gradle"),
    };
    if (process.env.JAVA_HOME) {
      gradleEnv.JAVA_HOME = process.env.JAVA_HOME;
    }

    await runCommand("./gradlew", ["assembleDebug", "-x", "test", "-x", "lint"], { cwd: androidRoot, env: gradleEnv }, job);

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