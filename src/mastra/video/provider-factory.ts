import { resolveBackend } from './config.ts';
import { ComfyUiVideoTransformationProvider } from './providers/comfyui-provider.ts';
import { MockVideoTransformationProvider } from './providers/mock-provider.ts';
import type { VideoTransformationProvider } from './types.ts';

export function createProviderFromConfig(): VideoTransformationProvider {
  const backend = resolveBackend();
  switch (backend) {
    case 'comfyui':
      return new ComfyUiVideoTransformationProvider();
    case 'mock':
      return new MockVideoTransformationProvider();
  }
}
