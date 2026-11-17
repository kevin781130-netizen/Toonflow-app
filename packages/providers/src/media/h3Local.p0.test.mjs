import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('P0 model metadata: literal ID and template-owned aspect ratio are installable', async () => {
  const file = source('packages/providers/src/media/h3Local.ts');
  assert.match(file, /models:\s*\[\{\s*id:\s*'h3-native-shot'/);
  const { default: provider } = await import('./h3Local.ts');
  assert.equal(provider.id, 'h3Local');
  assert.equal(provider.models[0].id, 'h3-native-shot');
  assert.equal(provider.models[0].videoRatioControl, 'template');
  assert.deepEqual(provider.models[0].mode, ['text']);
});

test('P0 WebCrypto SHA-256 works with native VM Uint8Array without importing node modules', async () => {
  const sandbox = createContext({ crypto: webcrypto }, { codeGeneration: { strings: false, wasm: false } });
  const result = await runInContext("crypto.subtle.digest('SHA-256', new Uint8Array([97,98,99]))", sandbox);
  assert.equal(Buffer.from(result).toString('hex'), sha(Buffer.from('abc')));
  const altered = await runInContext("crypto.subtle.digest('SHA-256', new Uint8Array([97,98,100]))", sandbox);
  assert.notEqual(Buffer.from(altered).toString('hex'), sha(Buffer.from('abc')));
  const runtime = source('apps/server/src/utils/media/provider.ts');
  assert.match(runtime, /import \{ createHash, webcrypto \} from "node:crypto";/);
  assert.match(runtime, /crypto: webcrypto,/);
});

test('P0 default ratio is omitted generically for template-owned video providers', () => {
  const modelType = source('packages/toolScaffold/src/runtime.ts');
  const node = source('packages/nodes/videoGenerationNode/src/index.vue');
  const server = source('apps/server/src/utils/media/generation.ts');
  assert.match(modelType, /videoRatioControl\?: "template"/);
  assert.match(server, /model\.videoRatioControl === "template"/);
  assert.match(node, /ratio: choice\.videoRatioControl === "template" \? undefined : data\.value\.ratio/);
  assert.match(node, /args\.ratio !== undefined && choice\.videoRatioControl === "template"/);
  assert.doesNotMatch(node, /providerId === ['"]h3Local['"]/);
});

test('P0 ratio UI communicates native template mode and hides ordinary selector', () => {
  const view = source('packages/nodes/videoGenerationNode/src/components/generationSettings.vue');
  assert.match(view, /model\?\.videoRatioControl === 'template'/);
  assert.match(view, /<template v-else>/);
  assert.match(view, /画面比例由已验证的视频工作流模板决定/);
});

test('P0 builtin source maps to dynamic installer, not auto-installed model list', () => {
  const pkg = JSON.parse(source('packages/providers/package.json'));
  const dialog = source('apps/web/src/components/settings/panels/mediaModel/addCustomProviderDialog.vue');
  const installed = source('apps/server/src/utils/media/provider.ts');
  assert.equal(pkg.exports['./media/h3Local'], './src/media/h3Local.ts');
  assert.match(dialog, /import h3LocalSource from "@toonflow\/providers\/media\/h3Local\?raw";/);
  assert.match(dialog, /h3Local: h3LocalSource/);
  assert.match(installed, /export async function addMediaProvider\(source:/);
  assert.match(installed, /export async function listMediaProviders\(\)/);
});

test('P0 changes add no cross-repository runtime imports', () => {
  const provider = source('packages/providers/src/media/h3Local.ts');
  assert.doesNotMatch(provider, /^import\s/m);
  assert.doesNotMatch(provider, /from ['"](?:\.\.\/|backend\/|minimax-H3)/);
});
