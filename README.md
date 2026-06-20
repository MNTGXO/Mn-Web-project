# APK Forge

Paste a GitHub repository URL, add a token for private repositories, and the app will try to clone the project and assemble an Android APK.

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