/**
 * Toonflow media Provider adapter for an independently hosted H3 Director.
 *
 * This file is deliberately staged outside Toonflow while the user's fork is
 * archived. Copy into Toonflow packages/providers/src/media/ only after review.
 * Uses only existing H3 project, native Take and verified-media APIs.
 */
const rules = [
  { type: 'input', field: 'baseUrl', title: 'Local H3 Director URL', value: 'http://127.0.0.1:17960' },
] as const;

const PACK_ID = 'h3-native-shot';
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const MAX_POLL_MS = 30 * 60 * 1000;
const POLL_MS = 1500;

type H3Config = { baseUrl?: string };
type H3Context = ProviderContext<H3Config>;
type Receipt = {
  kind: 'h3-local'; stage: 'submitting' | 'queued' | 'verifying';
  baseUrl: string; deadline: number; projectId: string; shotId: string;
  takeId?: string; promptId?: string;
};

type CompletedTake = {
  project_id: string; shot_id: string; take_id: string; sha256: string; bytes: number;
};
type RunStatus = { prompt_id?: unknown; state?: unknown; take?: unknown };

function localUrl(config: H3Config): URL {
  const value = (config.baseUrl || 'http://127.0.0.1:17960').trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid H3 Director URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('H3 Director must use a plain loopback HTTP origin');
  }
  return url;
}

function endpoint(base: URL, path: string): string {
  return new URL(path, base).toString();
}

function localSignal(ctx: H3Context, deadline: number): AbortSignal {
  const remaining = Math.max(1, deadline - Date.now());
  return AbortSignal.any([AbortSignal.timeout(remaining), ...(ctx.signal ? [ctx.signal] : [])]);
}

async function json(ctx: H3Context, base: URL, path: string, signal: AbortSignal, body?: object, method?: 'POST' | 'PUT'): Promise<Record<string, unknown>> {
  const response = await ctx.tool.fetch(endpoint(base, path), {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (response.status === 404 && path.startsWith('/api/integrations/toonflow/runs/')) {
    throw Object.assign(new Error('H3 native verified result receipt unavailable'), { code: 'H3_RESULT_ENDPOINT_MISSING' });
  }
  if (!response.ok) throw new Error(`H3 HTTP ${response.status} at ${path}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid H3 JSON response');
  return data as Record<string, unknown>;
}

function ident(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function verifiedTake(value: unknown): CompletedTake {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Verified H3 Take receipt missing');
  const take = value as Record<string, unknown>;
  if (!ident(take.project_id) || !ident(take.shot_id) || !ident(take.take_id)
    || typeof take.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(take.sha256)
    || typeof take.bytes !== 'number' || !Number.isSafeInteger(take.bytes)
    || take.bytes < 12 || take.bytes > MAX_VIDEO_BYTES) {
    throw new Error('Malformed H3 verified Take receipt');
  }
  return take as CompletedTake;
}

async function readBounded(response: Response, expected: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) !== expected) throw new Error('Verified video length mismatch');
  if (!response.body) throw new Error('Video body missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES || total > expected) throw new Error('Verified video exceeds expected size');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total !== expected) throw new Error('Verified video body is incomplete');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function retrieveVerifiedVideo(ctx: H3Context, base: URL, take: CompletedTake, signal: AbortSignal): Promise<MediaAsset[]> {
  // Reconstruct the path rather than trusting an arbitrary remote URL.
  const path = `/api/projects/${take.project_id}/shots/${take.shot_id}/takes/${take.take_id}/preview`;
  const response = await ctx.tool.fetch(endpoint(base, path), { signal });
  if (!response.ok) throw new Error(`H3 verified preview HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';', 1)[0];
  if (mime !== 'video/mp4' && mime !== 'video/webm') throw new Error('Unexpected verified video MIME');
  const bytes = await readBounded(response, take.bytes);
  if (mime === 'video/mp4' && String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw new Error('Not an MP4 payload');
  if (mime === 'video/webm' && (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3)) {
    throw new Error('Not a WebM payload');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  if (sha256 !== take.sha256) throw new Error('H3 video SHA-256 mismatch');
  return [{ mediaType: 'video', type: 'binary', data: bytes, mimeType: mime, name: `h3-${take.take_id}.${mime === 'video/mp4' ? 'mp4' : 'webm'}` }];
}

async function ensureNativePreflight(ctx: H3Context, base: URL, signal: AbortSignal): Promise<void> {
  // Check optional integration availability BEFORE any GPU or project write.
  const [preflight, status, bridge] = await Promise.all([
    json(ctx, base, `/api/workflows/packs/${PACK_ID}/validate`, signal),
    json(ctx, base, '/api/h3/status', signal),
    json(ctx, base, '/api/integrations/toonflow/health', signal),
  ]);
  const validation = preflight.validation as Record<string, unknown> | undefined;
  const pack = preflight.pack as Record<string, unknown> | undefined;
  const template = pack?.template as Record<string, unknown> | undefined;
  if (preflight.schema_live !== true || validation?.ok !== true || template?.bound !== true
    || status.online !== true || status.h3_available !== true || status.template_bound !== true
    || bridge.integration !== 'toonflow' || bridge.enabled !== true || bridge.contract !== 'native_take_v1') {
    throw new Error('H3 native workflow is not verified and online');
  }
}

async function setupNativeShot(ctx: H3Context, base: URL, prompt: string, duration: number, signal: AbortSignal): Promise<{projectId: string; shotId: string}> {
  const created = await json(ctx, base, '/api/projects', signal, { name: 'Toonflow H3 local take' });
  if (!ident(created.id)) throw new Error('H3 project create response invalid; do not retry blindly');
  const projectId = created.id;
  const shot = await json(ctx, base, `/api/projects/${projectId}/shot`, signal, {});
  if (!ident(shot.id)) throw new Error('H3 shot create response invalid; inspect project manually');
  const shotId = shot.id;
  const project = await json(ctx, base, `/api/projects/${projectId}`, signal);
  const prod = project.production_v1 as Record<string, unknown> | undefined;
  const shots = prod?.shots;
  if (project.id !== projectId || !Array.isArray(shots) || !ident(project.edit_revision)) {
    throw new Error('H3 project revision/shot collection missing');
  }
  const matches = shots.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).id === shotId);
  if (matches.length !== 1) throw new Error('H3 shot identity ambiguous');
  const target = matches[0] as Record<string, unknown>;
  target.prompt = prompt;
  target.h3_prompt = prompt;
  target.duration = duration;
  const replaced = await json(ctx, base, `/api/projects/${projectId}`, signal, { project }, 'PUT');
  if (replaced.id !== projectId || !ident(replaced.edit_revision)) throw new Error('H3 project update not confirmed');
  // Dry run only. Native compile is authoritative for verified template bindings.
  const compiled = await json(ctx, base, '/api/h3/compile', signal, { shot: target });
  if (compiled.provider !== 'comfy_native_minimax_h3') throw new Error('H3 native compile response invalid');
  return { projectId, shotId };
}

async function waitShort(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, POLL_MS);
    function abort() { clearTimeout(timer); reject(signal.reason || new Error('H3 poll cancelled')); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function awaitVerifiedResult(ctx: H3Context, receipt: Receipt): Promise<MediaAsset[]> {
  const base = localUrl(ctx.config);
  if (base.origin !== receipt.baseUrl) throw new Error('H3 Director origin changed: refusing to resume');
  if (!ident(receipt.promptId) || !ident(receipt.projectId) || !ident(receipt.shotId) || !ident(receipt.takeId)) {
    throw new Error('H3 native Take receipt incomplete');
  }
  const signal = localSignal(ctx, receipt.deadline);
  while (!signal.aborted) {
    const data: RunStatus = await json(ctx, base, `/api/integrations/toonflow/runs/${receipt.promptId}`, signal);
    if (data.prompt_id !== receipt.promptId) throw new Error('H3 receipt prompt_id mismatch');
    if (data.state === 'failed') throw Object.assign(new Error('H3 render failed'), { code: 'MEDIA_TASK_FAILED' });
    if (data.state === 'complete') {
      const take = verifiedTake(data.take);
      if (take.project_id !== receipt.projectId || take.shot_id !== receipt.shotId || take.take_id !== receipt.takeId) {
        throw new Error('H3 Take identity mismatch');
      }
      return retrieveVerifiedVideo(ctx, base, take, signal);
    }
    if (data.state !== 'queued') throw new Error('Unknown H3 render status');
    if (receipt.stage === 'verifying') {
      // Prior verification may have succeeded but its HTTP receipt was lost.
      // Do not repeat the hash/write. User can verify manually in H3.
      throw Object.assign(new Error('H3 media verify status ambiguous; inspect H3 manually'), { code: 'H3_VERIFY_AMBIGUOUS' });
    }
    const history = await json(ctx, base, `/api/jobs/${receipt.promptId}`, signal);
    const entry = history[receipt.promptId] as Record<string, unknown> | undefined;
    if (entry) {
      const status = entry.status as Record<string, unknown> | undefined;
      if (status?.status_str === 'error' || status?.status_str === 'failed' || status?.status_str === 'execution_error') {
        throw Object.assign(new Error('ComfyUI H3 generation failed'), { code: 'MEDIA_TASK_FAILED' });
      }
      if (status?.completed === true && status.status_str === 'success') {
        const verifying: Receipt = { ...receipt, stage: 'verifying' };
        if (!ctx.saveTaskData) throw new Error('Cannot persist verification checkpoint; refusing hash/write');
        await ctx.saveTaskData(verifying);
        try {
          const verified = await json(ctx, base, '/api/h3/takes/media/verify', signal, {
            project_id: receipt.projectId, take_id: receipt.takeId,
          });
          if (verified.h3_prompt_id !== receipt.promptId || verified.take_id !== receipt.takeId
            || verified.project_id !== receipt.projectId || verified.state !== 'media_hashed') {
            throw new Error('H3 verification identity mismatch');
          }
        } catch {
          // A response may have been lost after H3 committed the hash. Allow one
          // READ of existing status, never a second POST verification.
          const observed = await json(ctx, base, `/api/integrations/toonflow/runs/${receipt.promptId}`, signal);
          if (observed.prompt_id === receipt.promptId && observed.state === 'complete') {
            const take = verifiedTake(observed.take);
            if (take.project_id === receipt.projectId && take.shot_id === receipt.shotId && take.take_id === receipt.takeId) {
              return retrieveVerifiedVideo(ctx, base, take, signal);
            }
          }
          throw Object.assign(new Error('H3 verification ambiguous; do not auto-repeat'), { code: 'H3_VERIFY_AMBIGUOUS' });
        }
        return awaitVerifiedResult(ctx, verifying);
      }
      if (status?.completed === true && status.status_str !== 'success') {
        throw Object.assign(new Error('ComfyUI job completed without success'), { code: 'MEDIA_TASK_FAILED' });
      }
    }
    await waitShort(signal);
  }
  throw new Error('H3 result wait timed out or cancelled');
}

export default {
  id: 'h3Local',
  label: 'Local H3 Director (verified output only)',
  version: '0.2.0-native-take',
  readme: 'Local H3 Director: native Take submission and explicit media verification. Text-only 4–15s; verified ComfyUI template required.',
  rules,
  models: [{ id: PACK_ID, label: 'H3 Native Shot', type: 'video', mode: ['text'], durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: [] }] }],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const base = localUrl(this.config);
    if (request.model !== PACK_ID || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 6000) {
      throw new Error('Only a nonempty H3 Native Shot prompt is supported');
    }
    if (!Number.isInteger(request.duration) || (request.duration ?? 0) < 4 || (request.duration ?? 0) > 15) {
      throw new Error('H3 Native Shot duration must be 4-15 seconds');
    }
    if ((request.images?.length ?? 0) || (request.videos?.length ?? 0) || (request.audios?.length ?? 0)
      || request.firstFrame || request.lastFrame || request.mode && request.mode !== 'text'
      || request.generateAudio || request.ratio || request.resolution || request.watermark || request.other && Object.keys(request.other).length) {
      throw new Error('References and advanced parameters are not yet bound to verified H3 workflow inputs');
    }
    if (!this.saveTaskData) throw new Error('Toonflow durable task recovery is required for GPU safety');
    const deadline = Date.now() + MAX_POLL_MS;
    const signal = localSignal(this, deadline);
    await ensureNativePreflight(this, base, signal);
    const { projectId, shotId } = await setupNativeShot(this, base, request.prompt.trim(), request.duration!, signal);
    // Checkpoint is saved BEFORE the only GPU-triggering POST.
    const pending: Receipt = { kind: 'h3-local', stage: 'submitting', baseUrl: base.origin, deadline, projectId, shotId };
    await this.saveTaskData(pending);
    let data: Record<string, unknown>;
    try {
      data = await json(this, base, '/api/h3/takes/render', signal, { project_id: projectId, shot_id: shotId });
    } catch {
      throw Object.assign(new Error('Ambiguous H3 queue submission; do not auto-resubmit'), { code: 'H3_QUEUE_AMBIGUOUS' });
    }
    if (!ident(data.h3_prompt_id) || !ident(data.take_id) || data.state !== 'queued'
      || data.project_id !== projectId || data.shot_id !== shotId) {
      throw Object.assign(new Error('H3 native Take response invalid; inspect H3 manually'), { code: 'H3_QUEUE_AMBIGUOUS' });
    }
    const queued: Receipt = { ...pending, stage: 'queued', promptId: data.h3_prompt_id, takeId: data.take_id };
    await this.saveTaskData(queued);
    return awaitVerifiedResult(this, queued);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    if (data.kind !== 'h3-local' || !['submitting', 'queued', 'verifying'].includes(String(data.stage))
      || typeof data.baseUrl !== 'string' || typeof data.deadline !== 'number'
      || !Number.isFinite(data.deadline) || !ident(data.projectId) || !ident(data.shotId)) {
      throw new Error('Invalid H3 recovery data');
    }
    if (data.stage === 'submitting') {
      throw Object.assign(new Error('H3 queue submission ambiguous; inspect H3 manually'), { code: 'H3_QUEUE_AMBIGUOUS' });
    }
    if (!ident(data.promptId) || !ident(data.takeId) || data.deadline <= Date.now()) {
      throw new Error('H3 recovery receipt expired or incomplete');
    }
    return awaitVerifiedResult(this, data as Receipt);
  },
} satisfies ProviderDefinition<typeof rules>;
