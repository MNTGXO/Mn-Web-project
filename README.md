# APK Forge

Paste a GitHub repository URL, add a token for private repositories, and the app will try to clone the project and produce an APK. Native Android repositories are built with Gradle; repositories without Android structure fall back to web detection and are packaged into a generated Android WebView wrapper when they expose `package.json` or `index.html`.

## Local Dev

```bash
npm install
npm run build
```

## Docker

```bash
docker build -t apk-forge .
docker run --rm -p 8080:8080 -e PORT=8080 apk-forge
```

## Koyeb

Use the repository as a Docker deployment.

Suggested settings:

```text
Builder: Dockerfile
Port: 8080/http
Route: /:8080
Environment: PORT=8080
```

The app listens on `PORT`, so it is ready for a Koyeb Web Service without code changes.

## Build detection

APK Forge attempts these paths in order:

1. Find a Gradle Android project with `settings.gradle` / `settings.gradle.kts` and `build.gradle` / `build.gradle.kts`, then run `assembleDebug` via the repo wrapper or container Gradle.
2. If no Android project exists, detect a web app (`package.json` or `index.html`), install dependencies, run `npm run build` when available, and copy `dist`, `build`, `out`, `public`, or the static root into a generated Android WebView project.
3. Build the generated wrapper with the container Gradle installation and return the newest APK artifact.
