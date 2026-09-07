import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// 使用项目已有 YAML 解析器校验实际配置，避免把注释误判为工作流行为。
const { load } = createRequire(import.meta.url)("js-yaml");
const workflow = load(
  readFileSync(new URL("../../.github/workflows/docker-ghcr.yml", import.meta.url), "utf8")
);
const job = workflow.jobs.build;
const steps = job.steps;
const build = steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
const login = steps.find((step) => step.uses?.startsWith("docker/login-action@"));

test("只允许目标 fork 的手动或专用分支工作流发布", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["codex/ghcr-docker"]);
  assert.deepEqual(workflow.on.push.paths, [".github/workflows/docker-ghcr.yml"]);
  assert.equal(job.if, "github.repository == 'fgy4399/OmniRoute'");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read", packages: "write" });
});

test("只使用 GHCR 和提交 SHA 标签，不依赖 Docker Hub 凭证", () => {
  assert.equal(job.env.IMAGE, "ghcr.io/fgy4399/omniroute:sha-${{ github.sha }}");
  assert.equal(login.with.registry, "ghcr.io");
  assert.equal(login.with.password, "${{ secrets.GITHUB_TOKEN }}");
  assert.equal(steps.filter((step) => step.uses?.startsWith("docker/login-action@")).length, 1);
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with.ref, undefined);
});

test("复用 Node 基础镜像及受限构建内存配置", () => {
  assert.equal(build.with.file, "Dockerfile");
  assert.equal(build.with.target, "runner-base");
  assert.equal(build.with.platforms, "linux/amd64");
  assert.match(build.with["build-args"], /^OMNIROUTE_USE_TURBOPACK=0$/m);
  assert.match(build.with["build-args"], /^OMNIROUTE_BUILD_WORKERS=2$/m);
  assert.match(build.with["build-args"], /^OMNIROUTE_BUILD_MEMORY_MB=6144$/m);
  assert.match(build.with["cache-to"], /ignore-error=true/);
  assert.equal(job["runs-on"], "ubuntu-24.04");
});

test("镜像通过健康检查后才发布，失败时仍清理容器", () => {
  assert.equal(build.with.load, true);
  assert.equal(build.with.push, false);
  const smoke = steps.find((step) => step.id === "smoke");
  const publish = steps.find((step) => step.run?.includes('docker push "$IMAGE"'));
  assert.ok(steps.indexOf(build) < steps.indexOf(smoke));
  assert.ok(steps.indexOf(smoke) < steps.indexOf(login));
  assert.ok(steps.indexOf(login) < steps.indexOf(publish));
  assert.equal(smoke["continue-on-error"], undefined);
  assert.equal(publish.if, undefined);
  assert.match(smoke.run, /health.*healthy/);
  assert.match(smoke.run, /exit 1/);
  const cleanup = steps.find((step) => step.run === "docker rm -f omniroute-smoke");
  assert.equal(cleanup.if, "always() && steps.smoke.outcome != 'skipped'");
  assert.match(publish.run, /docker buildx imagetools inspect/);
});
