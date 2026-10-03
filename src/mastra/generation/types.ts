/**
 * Cloud generation types for the marketing video MVP.
 *
 * Domain model: the application thinks in capabilities
 * (virtual_try_on / image_edit / image_to_video). A provider/model registry
 * maps each capability to the configured provider+model. Provider-specific
 * request shapes stay inside adapters; this file only contains the
 * normalized application-level contracts.
 */

// ---------------------------------------------------------------------------
// Capability taxonomy
// ---------------------------------------------------------------------------

/** A generation capability the application can request. */
export type GenerationCapability = 'virtual_try_on' | 'image_edit' | 'image_to_video';

// ---------------------------------------------------------------------------
// Normalized request types
// ---------------------------------------------------------------------------

/**
 * Generate a marketing keyframe by compositing a garment onto a person/scene.
 * The producing provider handles VTON logic internally.
 */
export interface GenerateImageRequest {
  /** One or more absolute paths to product reference photos. */
  productImages: string[];
  /** Optional absolute path to a person/scene/body reference image. */
  personImage?: string;
  /** Optional free-text steering instructions. */
  prompt?: string;
  /** Target width in pixels (provider may round/override). */
  width?: number;
  /** Target height in pixels. */
  height?: number;
  /** Caller-supplied idempotency / correlation label (not sent to provider). */
  label?: string;
}

/**
 * Animate an already-approved keyframe image.
 * Motion should be restrained to preserve garment identity.
 */
export interface GenerateVideoRequest {
  /** Absolute path to the approved keyframe PNG/JPEG. */
  keyframePath: string;
  /** Target duration in seconds (provider may cap). */
  durationSeconds?: number;
  /**
   * Motion prompt. Keep verbs restrained:
   * "subtle body movement", "gentle camera push", "natural fabric sway".
   */
  prompt?: string;
  /** Target width in pixels. */
  width?: number;
  /** Target height in pixels. */
  height?: number;
  /** Caller-supplied label. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Async job lifecycle
// ---------------------------------------------------------------------------

export type GenerationStatus = 'queued' | 'running' | 'completed' | 'failed';

/** A handle returned immediately after submission. */
export interface GenerationJob {
  /** The provider's own external job/request identifier. */
  externalJobId: string;
  /** Which provider handled this job. */
  provider: string;
  /** Which model was used. */
  model: string;
  /** The capability that was requested. */
  capability: GenerationCapability;
  status: GenerationStatus;
  /** ISO-8601 wall-clock submission time. */
  submittedAt: string;
}

/** Full record persisted for benchmarking and fidelity review. */
export interface GenerationRecord extends GenerationJob {
  /** ISO-8601 completion time (undefined while still running). */
  completedAt?: string;
  /** Approximate latency in milliseconds (undefined while running). */
  latencyMs?: number;
  /** Local path to the downloaded result artifact, once available. */
  resultPath?: string;
  /** Fidelity gate outcome set by a human reviewer. */
  approved?: boolean;
  /** Short description of why the keyframe was rejected (human-written). */
  rejectionReason?: string;
  /** Reported cost in USD at submission time, if the provider exposes it. */
  costUsd?: number;
  /** Attempt number within the same shot/task (1-indexed). */
  attempt?: number;
  /** Free-form extra metadata the adapter wishes to preserve. */
  providerMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Normalized interface every cloud provider adapter must implement.
 *
 * Design: submit returns immediately with an external job ID (async-first).
 * Polling works today; the same ID can be used by a future webhook handler
 * without changing application workflow code.
 */
export interface GenerationProvider {
  readonly providerName: string;
  /** The model IDs this adapter supports. */
  readonly supportedModels: string[];

  /**
   * Submit a generation request. Returns a job handle immediately; does NOT
   * wait for completion. Throws GenerationError on submission failure.
   */
  submit(request: GenerateImageRequest | GenerateVideoRequest, modelId: string): Promise<GenerationJob>;

  /**
   * Poll the provider for the current status of a previously submitted job.
   */
  getStatus(externalJobId: string): Promise<GenerationStatus>;

  /**
   * Fetch the completed result. Throws GenerationError with code
   * RESULT_NOT_READY if the job is not yet done. Downloads the primary
   * artifact to destPath if provided.
   */
  getResult(externalJobId: string, destPath?: string): Promise<GenerationRecord>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type GenerationErrorCode =
  | 'UNSUPPORTED_CAPABILITY'
  | 'UNSUPPORTED_MODEL'
  | 'PROVIDER_UNAVAILABLE'
  | 'SUBMISSION_FAILED'
  | 'RESULT_NOT_READY'
  | 'RESULT_FETCH_FAILED'
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST';

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;

  constructor(code: GenerationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GenerationError';
    this.code = code;
  }
}

