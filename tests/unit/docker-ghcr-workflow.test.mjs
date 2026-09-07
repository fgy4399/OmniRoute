import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("同步默认分支即可触发，不限制变更文件，且只允许目标 fork 发布", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main", "release/v*"]);
  assert.equal(workflow.on.push.paths, undefined);
  assert.equal(workflow.on.push["paths-ignore"], undefined);
  assert.equal(
    workflow.jobs.metadata.if,
    "github.repository == 'fgy4399/OmniRoute' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
  );
  assert.equal(job.needs, "metadata");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.equal(job.if, "github.repository == 'fgy4399/OmniRoute'");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read", packages: "write" });
});

test("只使用 GHCR 和提交 SHA 标签，不依赖 Docker Hub 凭证", () => {
  assert.equal(job.env.IMAGE, "${{ needs.metadata.outputs.image }}-${{ matrix.arch }}");
  assert.match(build.with.labels, /org.opencontainers.image.revision=\$\{\{ github.sha \}\}/);
  assert.equal(login.with.registry, "ghcr.io");
  assert.equal(login.with.password, "${{ secrets.GITHUB_TOKEN }}");
  assert.equal(steps.filter((step) => step.uses?.startsWith("docker/login-action@")).length, 1);
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with.ref, undefined);
});

test("实际执行标签脚本，使用提交前 8 位且不发布 latest", () => {
  const metadata = workflow.jobs.metadata;
  assert.equal(metadata.outputs.image, "${{ steps.image.outputs.image }}");
  const step = metadata.steps.find((entry) => entry.id === "image");
  assert.equal(step.shell, "bash");
  const directory = mkdtempSync(join(tmpdir(), "omniroute-ghcr-"));
  try {
    const output = join(directory, "output");
    execFileSync("bash", ["-c", step.run], {
      env: {
        ...process.env,
        GITHUB_SHA: "d6f315018af6ed59ff0df253f857ca17abad4974",
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(readFileSync(output, "utf8"), "image=ghcr.io/fgy4399/omniroute:d6f31501\n");
    assert.doesNotMatch(JSON.stringify(workflow.jobs), /:latest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("复用 Node 基础镜像及受限构建内存配置", () => {
  assert.equal(build.with.file, "Dockerfile");
  assert.equal(build.with.target, "runner-base");
  assert.equal(build.with.platforms, "${{ env.PLATFORM }}");
  assert.equal(job.env.PLATFORM, "linux/${{ matrix.arch }}");
  assert.match(build.with["build-args"], /^OMNIROUTE_USE_TURBOPACK=0$/m);
  assert.match(build.with["build-args"], /^OMNIROUTE_BUILD_WORKERS=2$/m);
  assert.match(build.with["build-args"], /^OMNIROUTE_BUILD_MEMORY_MB=6144$/m);
  assert.match(build.with["cache-to"], /ignore-error=true/);
  assert.equal(job["runs-on"], "${{ matrix.runner }}");
  assert.deepEqual(job.strategy.matrix.include, [
    { arch: "amd64", runner: "ubuntu-24.04" },
    { arch: "arm64", runner: "ubuntu-24.04-arm" },
  ]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(build.with["cache-from"], "type=gha,scope=ghcr-${{ matrix.arch }}");
});

test("全部架构成功后才合并，并验证远端包含 AMD64 与 ARM64", () => {
  const merge = workflow.jobs.merge;
  assert.deepEqual(merge.needs, ["metadata", "build"]);
  assert.equal(merge.if, "github.repository == 'fgy4399/OmniRoute'");
  assert.equal(merge.env.IMAGE, "${{ needs.metadata.outputs.image }}");
  assert.deepEqual(merge.permissions, { contents: "read", packages: "write" });
  const publish = merge.steps.find((step) => step.run?.includes("imagetools create"));
  assert.match(publish.run, /--tag "\$IMAGE" "\$IMAGE-amd64" "\$IMAGE-arm64"/);
  assert.match(publish.run, /imagetools inspect --raw/);
  assert.match(publish.run, /jq -e/);
  assert.match(publish.run, /sort == \["amd64", "arm64"\]/);
  assert.equal(publish["continue-on-error"], undefined);
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
