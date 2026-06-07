import type { VideoProvider, VideoGenerateParams, VideoGenerateResult } from "../types";
import fs from "node:fs";
import path from "node:path";
import { id as genId } from "@/lib/id";

type JsonObject = Record<string, unknown>;

interface SubmitResult {
  pollUrl?: string;
  immediateVideoUrl?: string;
  requestId?: string;
}

const DONE_STATUSES = new Set(["done", "succeeded", "success", "completed"]);
const FAILED_STATUSES = new Set(["failed", "error", "expired", "cancelled", "canceled"]);

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" ? (value as JsonObject) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toDataUrl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
  const base64 = fs.readFileSync(filePath, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

function toImageUrl(imagePathOrUrl: string): string {
  if (
    imagePathOrUrl.startsWith("http://") ||
    imagePathOrUrl.startsWith("https://") ||
    imagePathOrUrl.startsWith("data:")
  ) {
    return imagePathOrUrl;
  }
  return toDataUrl(imagePathOrUrl);
}

function normalizeBaseUrl(baseUrl: string): string {
  const stripped = baseUrl.replace(/\/+$/, "");
  if (/\/v\d+$/i.test(stripped)) return stripped;
  return `${stripped}/v1`;
}

function normalizeDuration(duration: number): number {
  if (!Number.isFinite(duration)) return 8;
  return Math.max(1, Math.min(15, Math.round(duration)));
}

function normalizeRatio(ratio?: string): string {
  const allowed = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
  if (ratio && allowed.has(ratio)) return ratio;
  return "16:9";
}

function extractVideoUrl(data: unknown): string | undefined {
  const obj = asObject(data);
  if (!obj) return undefined;

  const direct = readString(obj.url) || readString(obj.video_url);
  if (direct) return direct;

  const video = asObject(obj.video);
  if (video) {
    const vUrl = readString(video.url);
    if (vUrl) return vUrl;
  }

  const output = asObject(obj.output);
  if (output) {
    const outUrl = readString(output.video_url);
    if (outUrl) return outUrl;
    const urls = output.urls;
    if (Array.isArray(urls)) {
      const first = readString(urls[0]);
      if (first) return first;
    }
  }

  if (Array.isArray(obj.unsigned_urls)) {
    const first = readString(obj.unsigned_urls[0]);
    if (first) return first;
  }
  if (Array.isArray(obj.urls)) {
    const first = readString(obj.urls[0]);
    if (first) return first;
  }

  if (Array.isArray(obj.videos)) {
    const firstVideo = asObject(obj.videos[0]);
    if (firstVideo) {
      const firstVideoUrl = readString(firstVideo.url);
      if (firstVideoUrl) return firstVideoUrl;
    }
  }

  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      const fromItem = extractVideoUrl(item);
      if (fromItem) return fromItem;
    }
  }

  const result = asObject(obj.result);
  if (result) {
    const resultUrl = extractVideoUrl(result);
    if (resultUrl) return resultUrl;
  }

  return undefined;
}

function extractStatus(data: unknown): string | undefined {
  const obj = asObject(data);
  if (!obj) return undefined;

  const status =
    readString(obj.status) ||
    readString(obj.state) ||
    readString(asObject(obj.output)?.task_status);

  return status?.toLowerCase();
}

function extractErrorMessage(data: unknown): string | undefined {
  const obj = asObject(data);
  if (!obj) return undefined;
  const errorObj = asObject(obj.error);
  return (
    readString(errorObj?.message) ||
    readString(errorObj?.detail) ||
    readString(obj.message) ||
    readString(asObject(obj.output)?.message)
  );
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export class OpenAIVideoProvider implements VideoProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private uploadDir: string;
  private resolution: "480p" | "720p";

  constructor(params?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    uploadDir?: string;
    resolution?: "480p" | "720p";
  }) {
    this.apiKey = params?.apiKey || process.env.OPENAI_API_KEY || "";
    this.baseUrl = normalizeBaseUrl(params?.baseUrl || process.env.OPENAI_BASE_URL || "https://api.x.ai");
    this.model = params?.model || process.env.OPENAI_VIDEO_MODEL || "grok-imagine-video";
    this.uploadDir = params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
    this.resolution = params?.resolution || "720p";
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    if (!this.apiKey) {
      throw new Error("OpenAI video provider requires an API key");
    }

    const payload = this.buildGenerationBody(params);
    const submit = await this.submitGeneration(payload);
    const videoUrl = await this.pollForVideoUrl(submit);

    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      throw new Error(`OpenAI video download failed: ${videoRes.status}`);
    }

    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const filename = `${genId()}.mp4`;
    const dir = path.join(this.uploadDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    return { filePath: filepath };
  }

  private buildGenerationBody(params: VideoGenerateParams): JsonObject {
    const duration = normalizeDuration(params.duration);
    const body: JsonObject = {
      model: this.model,
      prompt: params.prompt,
      duration,
      seconds: duration,
      aspect_ratio: normalizeRatio(params.ratio),
      resolution: this.resolution,
    };

    if ("firstFrame" in params) {
      if (!params.firstFrame || !params.lastFrame) {
        throw new Error("OpenAI video keyframe mode requires both firstFrame and lastFrame");
      }
      const first = toImageUrl(params.firstFrame);
      const last = toImageUrl(params.lastFrame);
      body.reference_images = [{ url: first }, { url: last }];
      body.prompt = `Use <IMAGE_1> as the opening frame and transition naturally so the ending matches <IMAGE_2>.\n${params.prompt}`;
      return body;
    }
    if (!params.initialImage) {
      throw new Error("OpenAI video reference mode requires initialImage");
    }

    const initial = toImageUrl(params.initialImage);
    const references = [
      initial,
      ...(params.referenceImages?.map((img) => toImageUrl(img)) ?? []),
    ].slice(0, 7);

    if (references.length > 1) {
      body.reference_images = references.map((url) => ({ url }));
      body.prompt = `Reference mapping: <IMAGE_1> is the primary scene anchor; keep identity/style consistency with all provided reference images.\n${params.prompt}`;
      return body;
    }

    body.image = { url: initial, image_url: initial };
    return body;
  }

  private async submitGeneration(body: JsonObject): Promise<SubmitResult> {
    const submitUrl = `${this.baseUrl}/videos/generations`;
    console.log(`[OpenAIVideo] Submitting task: model=${this.model}, endpoint=${submitUrl}`);

    const response = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await parseJsonSafe(response);
    if (!response.ok) {
      throw new Error(
        `OpenAI video submit failed: ${response.status} ${extractErrorMessage(data) || "unknown error"}`
      );
    }

    const immediateVideoUrl = extractVideoUrl(data);
    if (immediateVideoUrl) {
      return { immediateVideoUrl };
    }

    const obj = asObject(data);
    const requestId = readString(obj?.request_id) || readString(obj?.id);
    const pollingUrl = readString(obj?.polling_url);

    if (pollingUrl) {
      return { pollUrl: pollingUrl, requestId };
    }
    if (requestId) {
      return {
        requestId,
        pollUrl: `${this.baseUrl}/videos/${requestId}`,
      };
    }

    throw new Error(`OpenAI video submit succeeded but no request id returned: ${JSON.stringify(data)}`);
  }

  private async pollForVideoUrl(submit: SubmitResult): Promise<string> {
    if (submit.immediateVideoUrl) return submit.immediateVideoUrl;
    if (!submit.pollUrl) {
      throw new Error("Missing poll URL for OpenAI video generation");
    }

    const maxAttempts = 360;
    const intervalMs = 5_000;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const response = await fetch(submit.pollUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!response.ok) {
        console.warn(`[OpenAIVideo] Poll ${i + 1}: HTTP ${response.status}, retrying…`);
        continue;
      }

      const data = await parseJsonSafe(response);
      const status = extractStatus(data);
      const videoUrl = extractVideoUrl(data);

      if (videoUrl && (!status || DONE_STATUSES.has(status))) {
        console.log(`[OpenAIVideo] Poll ${i + 1}: completed`);
        return videoUrl;
      }

      if (status) {
        console.log(`[OpenAIVideo] Poll ${i + 1}: status=${status}`);
        if (FAILED_STATUSES.has(status)) {
          throw new Error(
            `OpenAI video generation ${status}: ${extractErrorMessage(data) || "unknown error"}`
          );
        }
      }
    }

    throw new Error("OpenAI video generation timed out after 30 minutes");
  }
}
