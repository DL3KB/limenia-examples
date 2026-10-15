import { actions } from "./actions.js";
import { createApp } from "./app.js";
import { insecureDevAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { LimeniaClient } from "./limenia.js";

const config = loadConfig();
if (insecureDevAuth()) {
  console.warn(
    JSON.stringify({
      msg: "LIMENIA_EXAMPLE_INSECURE_DEV_AUTH=1: the X-User-Id header is trusted as the signed-in user. For local testing only. Anyone can send that header. Never set it in a deployed environment.",
    }),
  );
}
const limenia = new LimeniaClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
const app = createApp({ limenia, webhookSecrets: config.webhookSecrets, actions });

app.listen(config.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: config.port }));
});
