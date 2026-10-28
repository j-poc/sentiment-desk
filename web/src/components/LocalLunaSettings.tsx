import { ChatGPTPlanConnection } from "./ChatGPTPlanConnection.js";
import { ModelProviderSettings } from "./ModelProviderSettings.js";

export function LocalLunaSettings() {
  return <div className="space-y-3">
    <ChatGPTPlanConnection />
    <ModelProviderSettings />
  </div>;
}
