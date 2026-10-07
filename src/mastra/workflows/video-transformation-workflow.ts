import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { harnessMetrics } from '../observability/metrics.ts';
import {
  assembleOutput,
  pipelineRuntime,
  prepareVideo,
  runVideoTransformation as runVideoTransformationStage,
} from '../video/pipeline.ts';
import type { VideoTransformationInput } from '../video/types.ts';

/**
 * Mastra wrapper around the standalone video pipeline (src/mastra/video/).
 * Deliberately a straight-line chain of steps with no branching, retries,
 * or parallelism - the pipeline module itself already owns validation,
 * ffmpeg orchestration, and provider selection; this workflow exists only
 * to expose that same logic through Mastra (Studio visibility, future
 * scheduling/composition with other workflows), matching this repository's
 * existing coding-task-workflow.ts shape rather than introducing a new
 * orchestration style.
 */

const videoInputSchema = z.object({
  sourceVideo: z.string(),
  characterReference: z.string(),
  outfitReference: z.string().optional(),
  outputPath: z.string(),
  prompt: z.string().optional(),
  appearanceVariation: z.enum(['none', 'subtle']).optional(),
  targetFps: z.number().optional(),
  maxDimension: z.number().optional(),
}) satisfies z.ZodType<VideoTransformationInput>;

const preparedSchema = z.object({
  workDir: z.string(),
  framesDir: z.string(),
  framePattern: z.string(),
  frameCount: z.number(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  sourceProbe: z.object({
    durationSeconds: z.number(),
    fps: z.number(),
    width: z.number(),
    height: z.number(),
    hasAudio: z.boolean(),
    codec: z.string(),
  }),
  appearanceVariation: z.enum(['none', 'subtle']),
});

const providerOutputSchema = z.union([
  z.object({ kind: z.literal('video'), path: z.string() }),
  z.object({ kind: z.literal('frames'), dir: z.string(), fps: z.number(), pattern: z.string() }),
]);

const resultSchema = z.object({
  outputPath: z.string(),
  metadata: z.object({
    backend: z.enum(['comfyui', 'mock']),
    durationMs: z.number(),
    sourceDurationSeconds: z.number(),
    sourceFps: z.number(),
    sourceWidth: z.number(),
    sourceHeight: z.number(),
    outputFps: z.number(),
    outputWidth: z.number(),
    outputHeight: z.number(),
    frameCount: z.number(),
    appearanceVariation: z.enum(['none', 'subtle']),
    workDir: z.string(),
  }),
});

const validateInputStep = createStep({
  id: 'validate-input',
  description: 'Checks the source video, character/outfit reference images, and ffmpeg availability before any work starts.',
  inputSchema: videoInputSchema,
  outputSchema: videoInputSchema,
  execute: async ({ inputData }) => {
    await pipelineRuntime.createDeps().validateInput(inputData);
    return inputData;
  },
});

const prepareVideoStep = createStep({
  id: 'prepare-video',
  description: 'Probes the source video and extracts/normalizes its frames (fps + resolution capped, aspect ratio preserved) into a working directory.',
  inputSchema: videoInputSchema,
  outputSchema: z.object({ input: videoInputSchema, prepared: preparedSchema, startedAt: z.number() }),
  execute: async ({ inputData }) => {
    const startedAt = Date.now();
    const deps = pipelineRuntime.createDeps();
    const prepared = await prepareVideo(inputData, deps);
    return { input: inputData, prepared, startedAt };
  },
});

const runVideoTransformationStep = createStep({
  id: 'run-video-transformation',
  description: 'Submits the extracted frames plus character/outfit references to the configured AI backend (VIDEO_AI_BACKEND) and waits for the result.',
  inputSchema: z.object({ input: videoInputSchema, prepared: preparedSchema, startedAt: z.number() }),
  outputSchema: z.object({
    input: videoInputSchema,
    prepared: preparedSchema,
    startedAt: z.number(),
    providerOutput: providerOutputSchema,
    backend: z.enum(['comfyui', 'mock']),
  }),
  execute: async ({ inputData }) => {
    const deps = pipelineRuntime.createDeps();
    const providerOutput = await runVideoTransformationStage(inputData.input, inputData.prepared, deps.provider);
    return { input: inputData.input, prepared: inputData.prepared, startedAt: inputData.startedAt, providerOutput, backend: deps.provider.name };
  },
});

const assembleOutputStep = createStep({
  id: 'assemble-output',
  description: 'Reassembles the generated frames into an MP4, muxes the original audio back in, verifies the output exists, and cleans up the working directory.',
  inputSchema: z.object({
    input: videoInputSchema,
    prepared: preparedSchema,
    startedAt: z.number(),
    providerOutput: providerOutputSchema,
    backend: z.enum(['comfyui', 'mock']),
  }),
  outputSchema: resultSchema,
  execute: async ({ inputData }) => {
    const deps = pipelineRuntime.createDeps();
    return assembleOutput(inputData.input, inputData.prepared, inputData.providerOutput, inputData.backend, deps, inputData.startedAt);
  },
});

export const videoTransformationWorkflow = createWorkflow({
  id: 'video-transformation-workflow',
  inputSchema: videoInputSchema,
  outputSchema: resultSchema,
  options: {
    onStart: ({ workflowId, runId }) => harnessMetrics.workflowStarted(workflowId, runId),
    onFinish: ({ workflowId, runId, status }) => harnessMetrics.workflowFinished(workflowId, runId, status),
  },
})
  .then(validateInputStep)
  .then(prepareVideoStep)
  .then(runVideoTransformationStep)
  .then(assembleOutputStep)
  .commit();
