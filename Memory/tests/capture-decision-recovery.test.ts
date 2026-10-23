import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage, type LlmCompletionOptions, type JobType } from "../src/index.js";
import { isMemoryReadyForRetrieval } from "../src/algorithm/plugin-algorithms.js";
import { captureDecisionJobPayload } from "../src/service/import/import-job-processor.js";
import { Repositories } from "../src/storage/repositories.js";
import { addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const query = "请整理 CSV 编码检查步骤并保留源文件。";
afterEach(() => { fixture.cleanup(); vi.useRealTimers(); });

function setup(name: string, outcome: 'accept' | 'reject' = 'accept') {
  const calls: Array<{ operation: string; decision: boolean; failed: boolean }> = [];
  let failure: string | null = null;
  const base = createBatchReflectionLlm([], 'CSV 编码检查步骤已经整理，保留源文件。');
  const llm: LlmClient = {
    ...base,
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> {
      const decision = messages.some(m => m.content.includes('Judge L1 and User Memory'));
      calls.push({ operation: options.operation, decision, failed: Boolean(failure && options.operation === 'capture.summarize') });
      if (failure && options.operation === 'capture.summarize') throw new Error(failure);
      if (options.operation === 'capture.summarize' && decision) {
        return {
          l1: outcome === 'accept' ? {
            title: 'CSV 编码检查', summary: '整理 CSV 编码检查步骤并保留源文件。',
            evidence: [{ quote: query, role: 'user', kind: 'user_directive' }],
          } : null,
          user: null,
        } as unknown as T;
      }
      if (options.operation.startsWith('reward.')) return {
        goal_achievement: 0.6, process_quality: 0.7, user_satisfaction: 0.5,
        reason: 'deterministic synthetic reward',
      } as unknown as T;
      return base.completeJson<T>(messages, options);
    },
  };
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  const { db, service } = fixture.createTestService({ config, configLoader: () => ({ config }), llm });
  const repos = new Repositories(db.db);
  const namespace = { source: 'codex', profileId: 'memmy648-repro', userId: `synthetic-${name}` };
  const session = service.openSession({ namespace });
  const turn = service.completeTurn(`synthetic-turn-${name}`, {
    sessionId: session.sessionId, query,
    answer: '先读取源文件的编码，再使用副本验证 UTF-8 导入，保留源文件。',
  });
  const id = turn.l1MemoryId!;
  const originalJob = repos.runtime.getPendingJob(id, 'trace_summary')!;
  expect(originalJob.payload.decideCapture).toBe(true);
  const episodeId = originalJob.episodeId!;
  service.closeSession(session.sessionId, { namespace });

  function jobs() {
    return (db.db.prepare('SELECT id, job_type, status, payload_json FROM evolution_jobs WHERE episode_id = ? OR target_memory_id = ? ORDER BY rowid')
      .all(episodeId, id) as Array<{ id: string; job_type: string; status: string; payload_json: string }>).map(row => ({
        id: row.id, type: row.job_type, status: row.status, payload: JSON.parse(row.payload_json),
      }));
  }
  function snapshot() {
    const memory = repos.memories.getIncludingDeleted(id)!;
    const allJobs = jobs();
    return {
      memoryStatus: memory.status,
      captureDecision: (memory.properties.internal_info.capture_decision as Record<string, unknown>).status,
      evidenceStatus: memory.properties.internal_info.evidence_status ?? null,
      summary: memory.info.summary,
      processingState: repos.processing.get(id)?.state ?? null,
      retrievalEligible: isMemoryReadyForRetrieval(memory),
      episodeStatus: repos.runtime.getEpisode(episodeId)?.status,
      finalTitleScheduled: allJobs.some(j => j.type === 'episode_title' && j.payload.stage === 'final'),
      reflectionScheduled: allJobs.some(j => j.type === 'reflection'),
      rewardScheduled: allJobs.some(j => j.type === 'reward'),
      finalTitleCompleted: allJobs.some(j => j.type === 'episode_title' && j.payload.stage === 'final' && j.status === 'succeeded'),
      rewardPhase: sEpisode()?.rewardDetail.phase ?? null,
      rewardValue: sEpisode()?.rTask ?? null,
      jobs: allJobs,
    };
  }
  const run = () => service.runWorkerOnce(1, { targetMemoryIds: [id], priorityCohortOnly: true });
  async function failFirst(transient = false) {
    failure = transient ? '429 synthetic temporary provider failure' : '401 Unauthorized synthetic model failure';
    const runResult = await run();
    expect(runResult.failed).toBe(1);
    expect(repos.runtime.getJob(originalJob.id)?.status).toBe(transient ? 'failed' : 'dead_letter');
    expect(snapshot().captureDecision).toBe('pending');
    failure = null;
  }
  async function finish() {
    for (let i = 0; i < 4; i++) await run();
    return snapshot();
  }
  function sEpisode() { return repos.runtime.getEpisode(episodeId); }
  async function finishEpisodeQueue() {
    // Advance only Date past the normal 30-second feedback window. Timers and I/O stay real.
    const afterFeedbackWindow = Date.now() + 31_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(afterFeedbackWindow);
    for (let i = 0; i < 4; i++) {
      await service.runWorkerOnce(20);
      if (typeof sEpisode()?.rTask === 'number') break;
    }
    return snapshot();
  }
  return { db, service, repos, namespace, id, originalJob, episodeId, calls, jobs, snapshot, run, failFirst, finish, finishEpisodeQueue };
}

describe("MEMMY-648 capture decision recovery", () => {
  for (const route of ["manual", "lifecycle", "startup_missing", "embedding_guard"] as const) {
    for (const outcome of ["accept", "reject"] as const) {
      it(`${route}: rebuilt job completes the ${outcome} decision and unblocks the episode`, async () => {
        const s = setup(`${route}-${outcome}`, outcome);
        if (route === "manual" || route === "lifecycle") {
          await s.failFirst();
          if (route === "manual") expect(s.service.retryMemoryProcessing(s.id, { namespace: s.namespace }).accepted).toBe(true);
          else s.service.reloadConfig();
        } else {
          // Construct interrupted states in the fixture database to reach the repair branches.
          s.db.db.prepare("DELETE FROM evolution_jobs WHERE id = ?").run(s.originalJob.id);
          if (route === "startup_missing") {
            s.service.reconcileWorkerStartup();
          } else {
            s.repos.processing.update(s.id, { state: "embedding_pending", stage: "embedding", activeJobId: null });
            const at = new Date().toISOString();
            s.repos.runtime.enqueueJob({ id: "synthetic-embedding-guard", jobType: "embedding", status: "queued",
              userId: s.namespace.userId, sessionId: s.originalJob.sessionId, episodeId: s.episodeId,
              targetMemoryId: s.id, payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
            await s.run();
          }
        }
        const retry = s.repos.runtime.getPendingJob(s.id, "trace_summary")!;
        expect(retry).toBeDefined();
        expect(retry.id).not.toBe(s.originalJob.id);
        expect(retry.payload.decideCapture).toBe(true);
        const after = await s.finish();
        const accepted = outcome === "accept";
        expect(after.captureDecision).toBe(accepted ? "accepted" : "rejected");
        expect(after.memoryStatus).toBe(accepted ? "activated" : "deleted");
        expect(after.processingState).toBe(accepted ? "ready" : null);
        if (accepted) {
          expect(after.evidenceStatus).not.toBe("provisional");
          expect(after.retrievalEligible).toBe(true);
        }
        expect(after.finalTitleScheduled).toBe(true);
        expect(after.reflectionScheduled).toBe(accepted);
        const afterFullQueue = await s.finishEpisodeQueue();
        expect(afterFullQueue.finalTitleCompleted).toBe(true);
        expect(afterFullQueue.rewardPhase).toBe(accepted ? "final" : null);
        expect(s.calls.filter(c => c.operation === "capture.summarize").every(c => c.decision)).toBe(true);
        const decisionCalls = s.calls.filter(c => c.decision).length;
        s.service.reconcileWorkerStartup();
        await s.finish();
        expect(s.calls.filter(c => c.decision)).toHaveLength(decisionCalls);
      });
    }
  }

  it("automatic retry preserves the original job's decision", async () => {
    const s = setup("automatic");
    await s.failFirst(true);
    const after = await s.finish();
    expect(s.repos.runtime.getJob(s.originalJob.id)?.status).toBe("succeeded");
    expect(after.captureDecision).toBe("accepted");
    expect(after.retrievalEligible).toBe(true);
    expect((await s.finishEpisodeQueue()).rewardPhase).toBe("final");
    expect(s.calls.filter(c => c.operation === "capture.summarize").every(c => c.decision)).toBe(true);
  });

  it("placeholder startup repair keeps imports on import_summary", async () => {
    const s = setup("placeholder");
    const added = addAgentSourceImport(s.service, s.namespace, "synthetic imported CSV history", "placeholder-import");
    s.db.db.prepare("DELETE FROM evolution_jobs WHERE target_memory_id = ?").run(added.id);
    s.db.db.prepare("UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.trace.summary', '摘要排队中'), info_json = json_set(info_json, '$.summary', '摘要排队中') WHERE id = ?").run(added.id);
    s.repos.processing.update(added.id, { state: "ready", stage: null, activeJobId: null });
    expect(s.repos.memories.listImportMemoriesNeedingSummary().map(m => m.id)).not.toContain(s.id);
    s.service.reconcileWorkerStartup();
    const retry = s.repos.runtime.getPendingJob(added.id, "import_summary")!;
    expect(retry.payload.source).toBe("startup.placeholder_summary_repair");
    expect(retry.payload.decideCapture).toBeUndefined();
    await s.service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    await s.service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    expect(s.repos.processing.get(added.id)?.state).toBe("ready");
    expect(s.snapshot().captureDecision).toBe("pending");
  });

  it("does not request a capture decision for other jobs or completed decisions", () => {
    const s = setup("payload-boundaries");
    const memory = s.repos.memories.get(s.id)!;
    for (const jobType of ["embedding", "import_summary", "observation_extract"] as const satisfies readonly JobType[]) {
      expect(captureDecisionJobPayload(memory, jobType)).toEqual({});
    }
    expect(captureDecisionJobPayload({ ...memory, memoryLayer: "L2" }, "trace_summary")).toEqual({});
    for (const decision of [undefined, null, "pending", { status: "accepted" }, { status: "rejected" }]) {
      const existing = structuredClone(memory);
      existing.properties.internal_info.capture_decision = decision;
      expect(captureDecisionJobPayload(existing, "trace_summary")).toEqual({});
    }
  });

  for (const stage of ["summary", "embedding"] as const) {
    it(`retries an accepted L1's ${stage} without repeating capture`, async () => {
      const s = setup(`accepted-${stage}`);
      expect((await s.finish()).captureDecision).toBe("accepted");
      const decisionCalls = s.calls.filter(c => c.decision).length;
      s.repos.processing.update(s.id, { state: "failed", stage, retryAction: "retry", activeJobId: null });
      expect(s.service.retryMemoryProcessing(s.id, { namespace: s.namespace }).accepted).toBe(true);
      const retry = s.repos.runtime.getPendingJob(s.id, stage === "summary" ? "trace_summary" : "embedding")!;
      expect(retry.payload.decideCapture).toBeUndefined();
      const after = await s.finish();
      expect(after.captureDecision).toBe("accepted");
      expect(after.processingState).toBe("ready");
      expect(s.calls.filter(c => c.decision)).toHaveLength(decisionCalls);
    });
  }
});
