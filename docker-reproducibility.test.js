const { readFileSync } = require("node:fs");
const { describe, expect, test } = require("bun:test");

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
const compose = readFileSync(
  new URL("./docker-compose.yml", import.meta.url),
  "utf8",
);
const localCompose = readFileSync(
  new URL("./docker-compose.local.yml", import.meta.url),
  "utf8",
);
const legacyApi = readFileSync(new URL("./src/api.py", import.meta.url), "utf8");

describe("Docker build inputs", () => {
  test("pins the Python image by immutable OCI digest", () => {
    expect(dockerfile).toContain(
      "FROM python:3.11.15-slim-trixie@sha256:90744cff8f32887f075c47d747a173ff333e9e98801667af93c357fa9f5e28ff",
    );
    expect(dockerfile).not.toMatch(/^FROM python:3\.11-slim\s*$/m);
  });

  test("does not depend on a mutable Dockerfile frontend or apt repositories", () => {
    expect(dockerfile).not.toMatch(/^# syntax=/m);
    const instructions = dockerfile.replace(/^\s*#.*$/gm, "");
    expect(instructions).not.toMatch(/\bapt(?:-get)?\b/);
  });

  test("installs only hash-verified wheels", () => {
    expect(dockerfile).toContain(
      "pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock.txt",
    );
  });

  test("starts the API with the source directory on the import path", () => {
    expect(dockerfile).toContain(
      'CMD ["python", "-m", "uvicorn", "api:app", "--app-dir", "/app/src",',
    );
  });

  test("serves only byte-matching content-addressed frontend aliases", () => {
    expect(legacyApi).toContain('hashlib.sha256(path.read_bytes()).hexdigest()[:12]');
    expect(legacyApi).toContain('@app.get("/app-{asset_hash}.js", include_in_schema=False)');
    expect(legacyApi).toContain('@app.get("/static/app-{asset_hash}.css", include_in_schema=False)');
    expect(legacyApi).toContain('"Cache-Control": "public, max-age=31536000, immutable"');
  });

  test("uses the pinned runtime for its health check", () => {
    for (const definition of [compose, localCompose]) {
      expect(definition).toContain(
        'test: ["CMD", "python", "-c", "import urllib.request;',
      );
      expect(definition).not.toMatch(/test:\s*\[[^\]]*"curl"/);
    }
  });
});

describe("Compose deployment images", () => {
  test("pins nginx and Certbot to exact releases and OCI digests", () => {
    expect(compose).toContain(
      "image: nginx:1.31.3-alpine3.24@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752",
    );
    expect(compose).toContain(
      "image: certbot/certbot:v5.7.0@sha256:34ee91d2f43008eb78a007d22f23ed4b2eaa9a454cb27ca2c042b49527a695b4",
    );
  });

  test("has no unpinned external service image", () => {
    const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(
      ([, image]) => image,
    );

    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(/:[^@\s]+@sha256:[0-9a-f]{64}$/);
    }
  });

  test("defaults CORS to the current production origins", () => {
    expect(compose).toContain(
      "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://epsteinproject.org,https://www.epsteinproject.org}",
    );
    expect(compose).not.toContain("epsteinfiles.org");
  });
});
