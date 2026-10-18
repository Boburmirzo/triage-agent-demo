import { createFoundryAuth } from '../foundry-auth.mjs';
import { modelProvider } from '../model-provider.mjs';

export default async () => {
  const provider = modelProvider();
  const headers = createFoundryAuth();
  return {
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== provider.id) return;
      Object.assign(output.headers, await headers());
    },
    'chat.params': async (input, output) => {
      if (input.model.providerID !== provider.id) return;
      // Reasoning deployments use their model defaults; GPT-6 rejects these knobs.
      output.temperature = undefined;
      output.topP = undefined;
    },
  };
};
