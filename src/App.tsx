import { motion } from "framer-motion";
import { FormEvent, useEffect, useMemo, useState } from "react";

type BuildStatus =
  | "idle"
  | "queued"
  | "cloning"
  | "analyzing"
  | "building"
  | "packaging"
  | "completed"
  | "failed";

type BuildJob = {
  id: string;
  status: BuildStatus;
  stage: string;
  progress: number;
  repoUrl: string;
  branch: string;
  privateRepo: boolean;
  logs: string[];
  artifactName?: string;
  downloadUrl?: string;
  error?: string;
  updatedAt: string;
};

const initialJob: BuildJob = {
  id: "",
  status: "idle",
  stage: "Ready",
  progress: 0,
  repoUrl: "",
  branch: "main",
  privateRepo: false,
  logs: [
    "Awaiting a GitHub repository link.",
    "The build worker will clone, inspect, and compile the Android project.",
    "Private repositories can be unlocked with a token and never stored.",
  ],
  updatedAt: new Date().toISOString(),
};

const demoLines = [
  "// apk-forge worker online",
  "$ clone github.com/owner/repo --depth 1",
  "$ detect Android project root",
  "$ ./gradlew assembleDebug",
  "$ package output as installable APK",
];

const stageTones: Record<BuildStatus, string> = {
  idle: "text-white/60 bg-white/5 border-white/10",
  queued: "text-sky-200 bg-sky-500/10 border-sky-400/20",
  cloning: "text-cyan-200 bg-cyan-500/10 border-cyan-400/20",
  analyzing: "text-violet-200 bg-violet-500/10 border-violet-400/20",
  building: "text-amber-200 bg-amber-500/10 border-amber-400/20",
  packaging: "text-emerald-200 bg-emerald-500/10 border-emerald-400/20",
  completed: "text-emerald-200 bg-emerald-500/15 border-emerald-400/30",
  failed: "text-rose-200 bg-rose-500/15 border-rose-400/30",
};

function formatStageLabel(status: BuildStatus, stage: string) {
  if (status === "idle") {
    return "Ready to start";
  }

  return stage;
}

export default function App() {
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [job, setJob] = useState<BuildJob>(initialJob);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const currentLogs = useMemo(() => {
    if (job.id) {
      return job.logs.slice(-8);
    }

    return demoLines;
  }, [job]);

  useEffect(() => {
    if (!job.id || job.status === "completed" || job.status === "failed") {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`/api/build/${job.id}`);
        if (!response.ok) {
          return;
        }

        const nextJob = (await response.json()) as BuildJob;
        if (!cancelled) {
          setJob(nextJob);
        }
      } catch {
        // Polling can fail temporarily when the container is warming up.
      }
    };

    poll();
    const timer = window.setInterval(poll, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job.id, job.status]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);

    const normalizedRepo = repoUrl.trim();
    if (!normalizedRepo) {
      setMessage("Paste a GitHub repository URL first.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: normalizedRepo,
          branch: branch.trim() || "main",
          token: token.trim(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "The build request was rejected.");
      }

      const payload = (await response.json()) as { jobId: string };
      setJob({
        ...initialJob,
        id: payload.jobId,
        status: "queued",
        stage: "Queued",
        progress: 8,
        repoUrl: normalizedRepo,
        branch: branch.trim() || "main",
        privateRepo: Boolean(token.trim()),
        logs: [
          "Build request accepted.",
          "Worker is provisioning an isolated workspace.",
          token.trim() ? "Private repository token supplied for the clone step." : "Public repository clone selected.",
        ],
        updatedAt: new Date().toISOString(),
      });
      setMessage("Build started. The worker will stream updates below.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something stopped the build request.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const progress = job.id ? job.progress : 0;
  const statusTone = stageTones[job.status];

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <main className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.14),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(139,92,246,0.12),_transparent_22%),radial-gradient(circle_at_70%_75%,_rgba(16,185,129,0.12),_transparent_24%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:64px_64px] opacity-10" />

        <section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-6 lg:px-10">
          <header className="flex items-center justify-between gap-4 text-[10px] uppercase tracking-[0.4em] text-white/45">
            <div className="font-semibold tracking-[0.6em] text-white/80">APK FORGE</div>
            <div className="hidden text-right md:block">GitHub repo to APK pipeline for public and private repos</div>
          </header>

          <div className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1.04fr_0.96fr] lg:py-16">
            <div className="max-w-2xl space-y-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: "easeOut" }}
                className="space-y-5"
              >
                <p className="text-sm uppercase tracking-[0.35em] text-cyan-200/70">Android build automation</p>
                <h1 className="max-w-xl text-5xl font-semibold tracking-tight text-white sm:text-6xl lg:text-7xl">
                  Paste a GitHub repo. Ship an APK.
                </h1>
                <p className="max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
                  Drop in a repository URL, add a token for private sources, and let the worker clone,
                  inspect, and assemble the Android project into a downloadable APK.
                </p>
              </motion.div>

              <motion.form
                onSubmit={handleSubmit}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: "easeOut", delay: 0.08 }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <label htmlFor="repo" className="text-xs uppercase tracking-[0.3em] text-white/45">
                    GitHub Repository
                  </label>
                  <input
                    id="repo"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="w-full border-b border-white/15 bg-transparent px-0 py-4 text-base text-white outline-none transition placeholder:text-white/25 focus:border-cyan-300/70"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label htmlFor="branch" className="text-xs uppercase tracking-[0.3em] text-white/45">
                      Branch
                    </label>
                    <input
                      id="branch"
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                      placeholder="main"
                      className="w-full border-b border-white/15 bg-transparent px-0 py-4 text-base text-white outline-none transition placeholder:text-white/25 focus:border-violet-300/70"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="token" className="text-xs uppercase tracking-[0.3em] text-white/45">
                      Private Token
                    </label>
                    <input
                      id="token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder="ghp_..."
                      className="w-full border-b border-white/15 bg-transparent px-0 py-4 text-base text-white outline-none transition placeholder:text-white/25 focus:border-emerald-300/70"
                      autoComplete="off"
                      spellCheck={false}
                      type="password"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="inline-flex items-center justify-center rounded-full bg-white px-6 py-3 text-sm font-semibold text-slate-950 transition hover:scale-[1.01] hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmitting ? "Launching build..." : "Build APK"}
                  </button>

                  <p className="max-w-md text-sm leading-6 text-slate-400">
                    Token input is only used to access private repositories and is not stored after the
                    build session.
                  </p>
                </div>
                {message ? <p className="text-sm text-cyan-200/90">{message}</p> : null}
              </motion.form>
            </div>

            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.9, ease: "easeOut", delay: 0.12 }}
              className="relative"
            >
              <div className="absolute -inset-10 rounded-[2.75rem] bg-cyan-400/10 blur-3xl" />
              <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/40 backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-white/10 pb-4 text-xs uppercase tracking-[0.3em] text-white/40">
                  <span>Live build stream</span>
                  <span>{job.id ? job.branch : "demo"}</span>
                </div>

                <div className="relative mt-5 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                  <div className="space-y-4">
                    <div className="rounded-[1.5rem] border border-white/10 bg-slate-950/80 p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs uppercase tracking-[0.3em] text-white/40">Current stage</p>
                          <p className="mt-2 text-2xl font-semibold text-white">{formatStageLabel(job.status, job.stage)}</p>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] ${statusTone}`}>
                          {job.status}
                        </span>
                      </div>

                      <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/8">
                        <motion.div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-violet-300 to-emerald-300"
                          initial={false}
                          animate={{ width: `${progress}%` }}
                          transition={{ duration: 0.45, ease: "easeOut" }}
                        />
                      </div>

                      <div className="mt-3 flex items-center justify-between text-xs uppercase tracking-[0.25em] text-white/35">
                        <span>{progress}% complete</span>
                        <span>{job.privateRepo ? "private repo unlock active" : "public repo mode"}</span>
                      </div>
                    </div>

                    <div className="space-y-2 rounded-[1.5rem] border border-white/10 bg-black/30 p-4 font-mono text-[12px] leading-6 text-emerald-300">
                      {currentLogs.map((line, index) => (
                        <motion.p
                          key={`${line}-${index}`}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.35, delay: index * 0.04 }}
                        >
                          {line}
                        </motion.p>
                      ))}
                      <motion.p
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                        className="text-cyan-200"
                      >
                        _
                      </motion.p>
                    </div>
                  </div>

                  <div className="relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-gradient-to-b from-slate-900/80 to-slate-950/90 p-5">
                    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
                    <div className="flex h-full flex-col justify-between gap-6">
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-white/35">APK output</p>
                        <div className="mt-4 flex items-end justify-between gap-4">
                          <div>
                            <p className="text-4xl font-semibold tracking-tight text-white">1 build</p>
                            <p className="mt-2 max-w-40 text-sm leading-6 text-slate-400">
                              The worker can emit a signed or debug APK once the Android project is
                              detected.
                            </p>
                          </div>
                          <motion.div
                            animate={{ y: [0, -8, 0] }}
                            transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
                            className="flex h-28 w-28 items-center justify-center rounded-[1.75rem] border border-cyan-300/30 bg-cyan-400/10"
                          >
                            <svg
                              viewBox="0 0 100 100"
                              className="h-16 w-16 text-cyan-200"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M28 35c0-7 5-13 12-13h20c7 0 12 6 12 13v34c0 7-5 13-12 13H40c-7 0-12-6-12-13V35Z" />
                              <path d="M40 22l-8-8" />
                              <path d="M60 22l8-8" />
                              <path d="M34 54h32" />
                              <path d="M34 64h32" />
                            </svg>
                          </motion.div>
                        </div>
                      </div>

                      <div className="space-y-3 border-t border-white/10 pt-4 text-sm text-slate-400">
                        <div className="flex items-center justify-between">
                          <span>Repo</span>
                          <span className="max-w-[14rem] truncate text-white/80">{job.repoUrl || "github.com/owner/repo"}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Branch</span>
                          <span className="text-white/80">{job.branch}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Token</span>
                          <span className="text-white/80">{job.privateRepo ? "accepted" : "not required"}</span>
                        </div>
                        {job.downloadUrl ? (
                          <a
                            href={job.downloadUrl}
                            className="inline-flex w-full items-center justify-center rounded-full bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
                          >
                            Download APK
                          </a>
                        ) : (
                          <div className="rounded-full border border-white/10 px-4 py-3 text-center text-xs uppercase tracking-[0.3em] text-white/35">
                            Waiting for artifact
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="relative mx-auto max-w-7xl px-6 pb-24 lg:px-10">
          <div className="grid gap-6 border-t border-white/10 py-16 lg:grid-cols-[0.85fr_1.15fr] lg:gap-10">
            <div className="space-y-4">
              <p className="text-sm uppercase tracking-[0.35em] text-white/40">How it works</p>
              <h2 className="max-w-sm text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                One request, one workspace, one APK.
              </h2>
              <p className="max-w-md text-base leading-7 text-slate-400">
                The site keeps the flow sharp: enter the repo, unlock private access if needed, and let
                the worker drive the Android build from start to finish.
              </p>
            </div>

            <div className="grid gap-6 sm:grid-cols-3">
              {[
                ["01", "Clone", "Normalize the repo URL, attach the token only for private access, and clone in isolation."],
                ["02", "Inspect", "Find the Android root, verify the Gradle wrapper, and prepare the build task."],
                ["03", "Package", "Run the Gradle build and expose the APK artifact for download."],
              ].map(([index, title, copy]) => (
                <div key={title} className="space-y-3 border-t border-white/10 pt-4">
                  <p className="text-xs uppercase tracking-[0.35em] text-cyan-200/70">{index}</p>
                  <h3 className="text-xl font-semibold text-white">{title}</h3>
                  <p className="text-sm leading-6 text-slate-400">{copy}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-10 border-t border-white/10 py-16 lg:grid-cols-2">
            <div className="space-y-4">
              <p className="text-sm uppercase tracking-[0.35em] text-white/40">Docker ready</p>
              <h2 className="text-3xl font-semibold tracking-tight text-white">Runs as a single container.</h2>
              <p className="max-w-xl text-base leading-7 text-slate-400">
                The Docker image builds the React frontend, ships the API server, and includes the Android
                toolchain needed for repo analysis and APK assembly. It listens on the Koyeb PORT value so
                deployment stays plug-and-play.
              </p>
            </div>

            <div className="rounded-[1.5rem] border border-white/10 bg-black/30 p-5 font-mono text-sm leading-7 text-slate-300">
              <p className="text-xs uppercase tracking-[0.35em] text-white/35">Deployment snippet</p>
              <pre className="mt-4 overflow-x-auto whitespace-pre-wrap">
{`docker build -t apk-forge .
docker run -e PORT=8080 -p 8080:8080 apk-forge

# On Koyeb, use Dockerfile deploy mode, expose port 8080/http,
# and route / to 8080.`}
              </pre>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
